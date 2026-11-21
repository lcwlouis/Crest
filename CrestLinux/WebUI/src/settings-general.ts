// Settings' General and Tabs pages (BrowserGeneralSettingsPane,
// BrowserTabsSettingsPane): the workspace's behavior preferences, which the
// core keeps in the session (SetAppPreferences), the default Space, and the
// link preferences that decide how new and moved tabs behave.
//
// Left out on Linux: the default browser row (the desktop's own setting),
// translation, which Linux's engine does not offer, and the sidebar widgets.

import { SavedTabClosePolicy, StartupBehavior } from "../generated/crest_contracts.js";
import type { AppPreferences, LinkBehavior } from "../generated/crest_contracts.js";
import { SpaceGroups } from "./space-groups.js";
import type { SettingsContext } from "./settings.js";
import { group, picker, row, toggle } from "./settings-form.js";

/** The startup choices the Mac's picker offers, in its order (StartupBehavior.settingsOrder). */
const startupOrder: readonly StartupBehavior[] = ["LastActiveTab", "ShowStartPage"];

/** Keeps the workspace's preferences with `change` made. */
export function setAppPreferences(context: SettingsContext, change: Partial<AppPreferences>): void {
    const workspace = context.workspace();
    if (!workspace) return;
    void context.send({ kind: "SetAppPreferences", value: { workspaceId: workspace.id, preferences: { ...context.preferences.app, ...change } } });
}

/** A switch over one of the workspace's preferences. */
function appToggle(context: SettingsContext, title: string, field: { [K in keyof AppPreferences]: AppPreferences[K] extends boolean ? K : never }[keyof AppPreferences], detail?: string): HTMLElement {
    const value = context.preferences.app[field] as boolean;
    return row(title, toggle(value, (isOn) => setAppPreferences(context, { [field]: isOn })), detail);
}

/** A switch over one of the link preferences. */
function linkToggle(context: SettingsContext, title: string, behavior: LinkBehavior, isOn: boolean): HTMLElement {
    return row(title, toggle(isOn, (value) => void context.send({ kind: "SetLinkBehavior", value: { behavior, isOn: value } })));
}

export function generalPage(context: SettingsContext): (HTMLElement | null)[] {
    const workspace = context.workspace();
    const app = context.preferences.app;
    const spaces = workspace ? new SpaceGroups(workspace).available : [];
    const defaultSpaceId = context.preferences.defaultSpaceId ?? spaces[0]?.state.id ?? null;
    const startupChoices = startupOrder.includes(app.startup) ? startupOrder : [...startupOrder, app.startup];
    return [
        group("Startup", [
            row(
                "When Crest opens",
                picker(
                    startupChoices.map((behavior) => ({ value: behavior, title: StartupBehavior.facts[behavior].title.text })),
                    app.startup,
                    (startup) => setAppPreferences(context, { startup }),
                ),
            ),
            row(
                "Default Space",
                picker(
                    spaces.map((space) => ({ value: space.state.id, title: space.state.settings.name })),
                    defaultSpaceId,
                    (spaceId) => workspace && spaceId && void context.send({ kind: "SetDefaultSpace", value: { workspaceId: workspace.id, spaceId } }),
                ),
            ),
        ]),
        group(
            "Webpages",
            [
                appToggle(context, "Check spelling", "checksSpelling"),
                appToggle(context, "Picture in Picture when switching tabs", "automaticallyEntersPictureInPicture"),
            ],
            { footer: "Spelling changes apply after Crest restarts." },
        ),
        group("Developer", [appToggle(context, "Developer toolbar on local pages", "automaticallyShowsDeveloperToolbar")], {
            footer: "Local pages are localhost, private network addresses, .local, .test and files.",
        }),
    ];
}

export function tabsPage(context: SettingsContext): (HTMLElement | null)[] {
    const links = context.preferences.links;
    const app = context.preferences.app;
    return [
        group(
            "New tabs",
            links
                ? [
                      linkToggle(context, "Switch to tabs opened from links", "FocusesNewTabs", links.focusesNewTabs),
                      linkToggle(context, "Follow tabs moved to another Space", "FollowsMovedTabs", links.followsMovedTabs),
                  ]
                : [],
            { footer: "Hold Shift as you open a link to do the opposite." },
        ),
        group("Pinned and saved tabs", [
            row(
                "After closing",
                picker(
                    SavedTabClosePolicy.all.map((policy) => ({ value: policy, title: SavedTabClosePolicy.facts[policy].title.text })),
                    app.savedTabClose,
                    (savedTabClose) => setAppPreferences(context, { savedTabClose }),
                ),
            ),
            appToggle(context, "Keep saved tabs after unloading", "unloadedSavedTabsStay"),
            appToggle(context, "Click the favicon to return to the saved URL", "savedTabFaviconReturnsToSavedUrl"),
        ]),
        group("Split View", [appToggle(context, "Focus follows pointer", "splitFocusFollowsMouse")]),
        group("Switching", [appToggle(context, "Show recent tabs while switching", "showsRecentTabs")]),
    ];
}
