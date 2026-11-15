// Settings' Spaces: the Spaces page, which lists each Space to open its own
// page, and a Space page's Browsing and Privacy sections
// (BrowserSpaceSettingsSections, BrowserPrivacySpaceSection). Its
// Appearance section is the Space editor (space-editor.ts).
//
// Left out on Linux: the access policy (locking a Space), passwords,
// extensions, the downloads section, website data and clearing browsing
// data, which need the engine's profile tools Linux does not drive yet.

import { CurrentTabCleanup, DataRetention, SitePermission, SitePermissionDecision } from "../generated/crest_contracts.js";
import type { BrowsingPreferences, DataRetentionPreferences, SearchProvider, SearchProviderSeed } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { identityIcon } from "./crest.js";
import type { Space } from "./model.js";
import { SpaceGroups } from "./space-groups.js";
import type { SettingsContext } from "./settings.js";
import { button, element, group, picker, row, toggle, wideRow } from "./settings-form.js";
import { defaultChoices, seedOf } from "./settings-search.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Spaces

export function spacesPage(context: SettingsContext): (HTMLElement | null)[] {
    const workspace = context.workspace();
    if (!workspace) return [];
    const groups = new SpaceGroups(workspace);
    const rows = groups.available.map((space) => {
        const node = element("button", groups.isSubSpace(space) ? "settings-row settings-link sub-space" : "settings-row settings-link");
        node.type = "button";
        node.append(
            identityIcon(space.state.settings.look, space.state.settings.symbol, 22),
            element("span", "settings-row-title", space.state.settings.name),
            element("span", "settings-spacer"),
        );
        const chevron = element("span", "settings-chevron");
        chevron.innerHTML = sfSymbol("chevron.right", 12);
        node.append(chevron);
        node.addEventListener("click", () => context.go({ kind: "space", spaceId: space.state.id, section: "appearance" }));
        return node;
    });
    return [
        element("h2", "settings-title settings-inline-title", "Spaces"),
        group(null, [...rows, wideRow(button("New Space…", () => void context.spaces.create()))]),
    ];
}

// MARK: - Browsing

function setBrowsing(context: SettingsContext, space: Space, change: Partial<BrowsingPreferences>): void {
    const workspace = context.workspace();
    if (!workspace) return;
    const current = { ...space.state.settings.browsingPreferences, ...change };
    void context.send({
        kind: "SetBrowsingPreferences",
        value: {
            workspaceId: workspace.id,
            spaceId: space.state.id,
            currentTabCleanup: current.currentTabCleanup,
            contentBlocking: current.contentBlocking,
            dataRetention: current.dataRetention,
        },
    });
}

/** The provider a Space searches with when it does not follow the default. */
function ownProvider(context: SettingsContext, preferences: BrowsingPreferences): SearchProvider | null {
    if (preferences.followsDefaultSearch) return null;
    const providers = context.preferences.search?.providers ?? [];
    return (
        providers.find(
            (provider) =>
                (preferences.selectedBuiltInEngine !== null && provider.builtIn === preferences.selectedBuiltInEngine) ||
                (preferences.selectedCustomEngineId !== null && provider.customId === preferences.selectedCustomEngineId),
        ) ?? null
    );
}

export function browsingSection(context: SettingsContext, space: Space): (HTMLElement | null)[] {
    const workspace = context.workspace();
    const search = context.preferences.search;
    if (!workspace) return [];
    const preferences = space.state.settings.browsingPreferences;
    const own = ownProvider(context, preferences);
    const providers = search ? defaultChoices(search) : [];
    if (own && !providers.some((provider) => provider.name === own.name)) providers.push(own);
    const suggestionChoice = preferences.followsDefaultSuggestions ? null : preferences.searchSuggestionsEnabled;
    const setSearch = (provider: SearchProviderSeed | null, suggestionsEnabled: boolean | null): void =>
        void context.send({ kind: "SetSpaceSearch", value: { workspaceId: workspace.id, spaceId: space.state.id, provider, suggestionsEnabled } });
    const ownSeed = own ? seedOf(own) : null;
    const defaultOn = search?.catalog.suggestionsEnabled ?? true;
    const groups = new SpaceGroups(workspace);
    const primary = groups.primary(space).state.settings.name;
    const separates = space.state.settings.separatesPinnedTabs;
    return [
        group(
            "Browsing",
            [
                row(
                    "Search with",
                    picker(
                        [
                            { value: null as string | null, title: `Default (${search?.default.title ?? "Google"})` },
                            ...providers.map((provider) => ({ value: provider.name as string | null, title: provider.title })),
                        ],
                        own?.name ?? null,
                        (name) => {
                            const provider = providers.find((candidate) => candidate.name === name);
                            setSearch(provider ? seedOf(provider) : null, suggestionChoice);
                        },
                    ),
                ),
                row(
                    "Search suggestions",
                    picker(
                        [
                            { value: null as boolean | null, title: defaultOn ? "Default (On)" : "Default (Off)" },
                            { value: true as boolean | null, title: "On" },
                            { value: false as boolean | null, title: "Off" },
                        ],
                        suggestionChoice,
                        (enabled) => setSearch(ownSeed, enabled),
                    ),
                ),
                row(
                    "Archive current tabs",
                    picker(
                        CurrentTabCleanup.all.map((cleanup) => ({ value: cleanup, title: CurrentTabCleanup.facts[cleanup].title.text })),
                        preferences.currentTabCleanup,
                        (currentTabCleanup) => setBrowsing(context, space, { currentTabCleanup }),
                    ),
                ),
                wideRow(
                    button(
                        "Archive Now",
                        () => void context.send({ kind: "CleanUpCurrentTabs", value: { workspaceId: workspace.id, spaceId: space.state.id } }),
                        "plain",
                        CurrentTabCleanup.facts[preferences.currentTabCleanup].lifetime === null,
                    ),
                ),
            ],
            { footer: "Search suggestions send what you type to the search engine." },
        ),
        groups.members(space).length > 1
            ? group(
                  null,
                  [
                      row(
                          "Separate Pinned Tabs",
                          toggle(separates, (value) =>
                              void context.send({ kind: "SetSeparatePinnedTabs", value: { workspaceId: workspace.id, spaceId: space.state.id, separates: value } }),
                          ),
                      ),
                  ],
                  {
                      footer: separates
                          ? `Each Space of ${primary}’s group shows its own pinned tabs.`
                          : `Every Space of ${primary}’s group shows ${primary}’s pinned tabs.`,
                  },
              )
            : null,
        group(null, [
            wideRow(
                button(`Delete “${space.state.settings.name}”…`, () => context.spaces.requestDeletion(space, false), "destructive", groups.available.length <= 1),
            ),
        ]),
    ];
}

// MARK: - Privacy

/** What a Space keeps, and for how long (BrowserDataRetentionCategory). */
const retentionCategories: readonly { readonly field: keyof DataRetentionPreferences; readonly title: string; readonly cleanupDescription: string }[] = [
    { field: "history", title: "History", cleanupDescription: "history entries" },
    { field: "archive", title: "Archived Tabs", cleanupDescription: "archived tabs" },
    { field: "downloads", title: "Download Records", cleanupDescription: "download records" },
];

/** Whether keeping records for `proposed` instead of `previous` deletes some now. */
function shortens(previous: DataRetention, proposed: DataRetention): boolean {
    const before = DataRetention.facts[previous].lifetime;
    const after = DataRetention.facts[proposed].lifetime;
    return after !== null && (before === null || after < before);
}

export function privacySection(context: SettingsContext, space: Space): (HTMLElement | null)[] {
    const workspace = context.workspace();
    if (!workspace) return [];
    const retention = space.state.settings.browsingPreferences.dataRetention;
    const keep = (field: keyof DataRetentionPreferences, proposed: DataRetention): void => {
        setBrowsing(context, space, { dataRetention: { ...retention, [field]: proposed } });
        void context.send({ kind: "SweepExpiredRecords", value: { workspaceId: workspace.id } });
    };
    const records = context.preferences.sitePermissions.get(space.state.id) ?? [];
    return [
        group(
            "Keep",
            retentionCategories.map((category) =>
                row(
                    category.title,
                    picker(
                        DataRetention.all.map((duration) => ({ value: duration, title: DataRetention.facts[duration].title.text })),
                        retention[category.field],
                        (proposed) => {
                            const previous = retention[category.field];
                            if (!shortens(previous, proposed)) {
                                keep(category.field, proposed);
                                return;
                            }
                            const title = DataRetention.facts[proposed].title.text;
                            showAlert({
                                title: "Permanently delete older records?",
                                message: `This immediately and permanently deletes ${category.cleanupDescription} older than ${title.toLowerCase()} in this Space, including synced copies. Downloaded files stay on disk.`,
                                buttons: [
                                    { title: `Use ${title}`, role: "destructive", action: () => keep(category.field, proposed) },
                                    { title: "Cancel", role: "cancel", action: () => context.redraw() },
                                ],
                            });
                        },
                    ),
                ),
            ),
            { footer: "Removing download records doesn’t delete the files." },
        ),
        group(
            "Site permissions",
            records.length === 0
                ? [wideRow(element("span", "settings-row-detail", "No saved permissions"))]
                : [
                      ...records.map((record) =>
                          row(
                              record.siteName,
                              element("span", "settings-row-value", SitePermissionDecision.facts[record.decision].title.text),
                              SitePermission.facts[record.permission].title.text,
                          ),
                      ),
                      wideRow(button("Reset All…", () => confirmResettingPermissions(context, space), "destructive")),
                  ],
        ),
    ];
}

function confirmResettingPermissions(context: SettingsContext, space: Space): void {
    const workspace = context.workspace();
    const sharesGroup = workspace ? new SpaceGroups(workspace).members(space).length > 1 : false;
    showAlert({
        title: "Reset All",
        message: sharesGroup ? "Makes every site ask again in this Space and the others of its group" : "Makes every site ask again in this Space",
        buttons: [
            { title: "Reset All", role: "destructive", action: () => void context.send({ kind: "ResetSpacePermissions", value: { spaceId: space.state.id } }) },
            { title: "Cancel", role: "cancel" },
        ],
    });
}

/** The Privacy page: each Space's own privacy, one page of that Space (BrowserSystemPrivacySettingsPane). */
export function privacyPage(context: SettingsContext): (HTMLElement | null)[] {
    const workspace = context.workspace();
    if (!workspace) return [];
    const rows = new SpaceGroups(workspace).available.map((space) => {
        const node = element("button", "settings-row settings-link");
        node.type = "button";
        node.dataset.space = space.state.id;
        node.append(
            identityIcon(space.state.settings.look, space.state.settings.symbol, 22),
            element("span", "settings-row-title", space.state.settings.name),
            element("span", "settings-spacer"),
        );
        const chevron = element("span", "settings-chevron");
        chevron.innerHTML = sfSymbol("chevron.right", 12);
        node.append(chevron);
        node.addEventListener("click", () => context.go({ kind: "space", spaceId: space.state.id, section: "privacy" }));
        return node;
    });
    return [group("Spaces", rows, { footer: "Each Space keeps its own history and site permissions." })];
}
