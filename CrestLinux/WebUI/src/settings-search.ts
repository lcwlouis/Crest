// Settings' Search page (BrowserSearchSettingsPane): the default searches,
// the command palette's results, sections and typing, and the search
// providers. The core keeps the search catalog in its device store and the
// palette's preferences in the session, and applies every rule; a provider
// it refuses says why.

import {
    BuiltInSearchProvider,
    PaletteLayout,
    PaletteSource,
    SearchChoice,
    SearchProviderKind,
    SearchProviderOption,
    SearchProviderSpaceTrigger,
} from "../generated/crest_contracts.js";
import type {
    CustomSearchProvider,
    PalettePreferences,
    PaletteSourceChoice,
    SearchCatalogChanged,
    SearchProvider,
    SearchProviderSeed,
} from "../generated/crest_contracts.js";
import { AppPreferences } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { Menu } from "./menu.js";
import type { SettingsContext } from "./settings.js";
import { button, element, glyphButton, group, picker, row, segmented, textField, toggle, wideRow } from "./settings-form.js";
import { setAppPreferences } from "./settings-general.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Providers

/** A provider as the core takes it back, to search with or keep as a default. */
export function seedOf(provider: SearchProvider): SearchProviderSeed {
    return {
        name: provider.name,
        title: provider.title,
        kind: provider.kind,
        shortcuts: provider.shortcuts,
        searchTemplate: provider.searchTemplate,
        suggestionTemplate: provider.suggestionTemplate,
        color: provider.color,
        logo: provider.logo,
        builtIn: provider.builtIn,
        customId: provider.customId,
    };
}

/** The providers a default can be: each kind that searches the web, then the defaults themselves (defaultChoices). */
export function defaultChoices(search: SearchCatalogChanged): SearchProvider[] {
    const choices = search.providers.filter((provider) => SearchProviderKind.facts[provider.kind].canBeDefault);
    for (const provider of [search.default, search.privateDefault]) {
        if (!choices.some((choice) => choice.name === provider.name)) choices.push(provider);
    }
    return choices;
}

/** Which providers have their options open, by name, while Settings stays open. */
const expanded = new Set<string>();

// MARK: - Page

export function searchPage(context: SettingsContext): (HTMLElement | null)[] {
    const search = context.preferences.search;
    const palette = context.preferences.app.palette;
    const setPalette = (change: Partial<PalettePreferences>): void => setAppPreferences(context, { palette: { ...palette, ...change } });
    const paletteToggle = (title: string, field: "showsTopHit" | "prefersOpenTabs" | "completesInline" | "learnsChoices" | "searchesSitesWithTab" | "showsReasons", detail?: string): HTMLElement =>
        row(title, toggle(palette[field], (isOn) => setPalette({ [field]: isOn })), detail);
    const choices = search ? defaultChoices(search) : [];
    const providerPicker = (selected: SearchProvider | undefined, choose: (provider: SearchProvider) => void): HTMLSelectElement =>
        picker(
            choices.map((provider) => ({ value: provider.name, title: provider.title })),
            selected?.name ?? "",
            (name) => {
                const provider = choices.find((choice) => choice.name === name);
                if (provider) choose(provider);
            },
        );
    const trigger = palette.providerSpaceTrigger;
    return [
        group(
            "Search",
            [
                search
                    ? row("Default search", providerPicker(search.default, (provider) => void context.send({ kind: "SetDefaultSearch", value: { provider: seedOf(provider) } })))
                    : null,
                search
                    ? row(
                          "Private windows",
                          providerPicker(search.privateDefault, (provider) => void context.send({ kind: "SetPrivateSearch", value: { provider: seedOf(provider) } })),
                      )
                    : null,
                search
                    ? row(
                          "Search suggestions",
                          toggle(search.catalog.suggestionsEnabled, (enabled) => void context.send({ kind: "SetSearchSuggestions", value: { enabled } })),
                      )
                    : null,
                paletteToggle("Tab to search providers", "searchesSitesWithTab", "Type a provider’s name or shortcut and press Tab."),
                row(
                    "Space to search providers",
                    picker(
                        SearchProviderSpaceTrigger.all.map((value) => ({ value, title: SearchProviderSpaceTrigger.facts[value].title.text })),
                        trigger,
                        (providerSpaceTrigger) => setPalette({ providerSpaceTrigger }),
                    ),
                    SearchProviderSpaceTrigger.facts[trigger].example.text,
                ),
            ],
            { footer: "Each device keeps its own default search. Search suggestions send what you type to the search engine." },
        ),
        group("Results", [
            row(
                "Layout",
                segmented(
                    PaletteLayout.all.map((value) => ({ value, title: PaletteLayout.facts[value].title.text })),
                    palette.layout,
                    (layout) => setPalette({ layout }),
                ),
            ),
            paletteToggle("Top Hit", "showsTopHit"),
            paletteToggle("Prefer open tabs", "prefersOpenTabs"),
            paletteToggle("Show match reasons", "showsReasons", "Notes why each result is there, such as “Often visited” or “Already open”."),
        ]),
        sectionsGroup(palette, setPalette),
        group(
            "Also show",
            palette.sources
                .filter((setting) => !PaletteSource.facts[setting.source].isSection)
                .map((setting) => {
                    const facts = PaletteSource.facts[setting.source];
                    return row(
                        facts.title.text,
                        toggle(setting.isEnabled, (isEnabled) => setPalette({ sources: replacing(palette.sources, setting.source, { isEnabled }) })),
                        facts.detail?.text,
                    );
                }),
        ),
        group(
            "Typing",
            [
                paletteToggle("Complete addresses inline", "completesInline"),
                paletteToggle("Learn from my choices", "learnsChoices"),
                wideRow(
                    button("Clear Learned Choices…", () =>
                        showAlert({
                            title: "Clear what the palette learned?",
                            message: "The palette forgets which results you chose for what you typed.",
                            buttons: [
                                { title: "Clear Learned Choices", role: "destructive", action: () => void context.send({ kind: "ClearPaletteChoices", value: {} }) },
                                { title: "Cancel", role: "cancel" },
                            ],
                        }),
                    ),
                ),
            ],
            { footer: "Learned choices stay on this device." },
        ),
        ...(search ? providerGroups(context, search) : []),
    ];
}

function replacing(sources: readonly PaletteSourceChoice[], source: PaletteSource, change: Partial<PaletteSourceChoice>): PaletteSourceChoice[] {
    return sources.map((setting) => (setting.source === source ? { ...setting, ...change } : setting));
}

/** The palette's sections, in their order, each with its limit and switch (BrowserPaletteSectionsSettingsSection). */
function sectionsGroup(palette: PalettePreferences, setPalette: (change: Partial<PalettePreferences>) => void): HTMLElement {
    const sections = palette.sources.filter((setting) => PaletteSource.facts[setting.source].isSection && setting.source !== "Suggestions");
    const limits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20];
    const move = (source: PaletteSource, offset: number): void => {
        const order = sections.map((setting) => setting.source);
        const from = order.indexOf(source);
        const to = from + offset;
        if (to < 0 || to >= order.length) return;
        [order[from], order[to]] = [order[to]!, order[from]!];
        // The sections take each other's places; the other sources keep theirs.
        let next = 0;
        const sources = palette.sources.map((setting) =>
            sections.includes(setting) ? palette.sources.find((candidate) => candidate.source === order[next++])! : setting,
        );
        setPalette({ sources });
    };
    const defaultOrder = AppPreferences.default.palette.sources.map((setting) => setting.source);
    const ordered = [...palette.sources].sort((a, b) => defaultOrder.indexOf(a.source) - defaultOrder.indexOf(b.source));
    const rows = sections.map((setting, index) => {
        const facts = PaletteSource.facts[setting.source];
        const controls = element("div", "settings-inline-controls");
        const limit = picker(
            limits.map((value) => ({ value, title: `Up to ${value}` })),
            setting.limit ?? facts.defaultLimit,
            (value) => setPalette({ sources: replacing(palette.sources, setting.source, { limit: value }) }),
            !setting.isEnabled,
        );
        limit.setAttribute("aria-label", `${facts.title.text} limit`);
        const actions = glyphButton("ellipsis", `${facts.title.text} actions`, (anchor) =>
            Menu.open(
                [
                    { title: "Move Up", icon: { kind: "symbol", name: "arrow.up" }, disabled: index === 0, action: () => move(setting.source, -1) },
                    { title: "Move Down", icon: { kind: "symbol", name: "arrow.down" }, disabled: index === sections.length - 1, action: () => move(setting.source, 1) },
                ],
                { anchor: anchor.getBoundingClientRect() },
            ),
        );
        const enabled = toggle(setting.isEnabled, (isEnabled) => setPalette({ sources: replacing(palette.sources, setting.source, { isEnabled }) }));
        enabled.setAttribute("aria-label", facts.title.text);
        controls.append(limit, enabled, actions);
        return row(facts.title.text, controls);
    });
    const reset = button("Reset Order", () => setPalette({ sources: ordered }), "plain", ordered.every((setting, index) => setting === palette.sources[index]));
    reset.classList.add("small");
    return group("Sections", rows, { accessory: reset });
}

// MARK: - Providers

function providerGroups(context: SettingsContext, search: SearchCatalogChanged): HTMLElement[] {
    const builtIns = new Map(search.catalog.builtIns.map((settings) => [settings.provider, settings]));
    const custom = search.catalog.custom;
    const groups = SearchProviderKind.all.map((kind) => {
        const rows: HTMLElement[] = [];
        for (const provider of BuiltInSearchProvider.all) {
            if (BuiltInSearchProvider.facts[provider].kind !== kind) continue;
            rows.push(...builtInRows(context, search, provider, builtIns.get(provider)?.isEnabled ?? BuiltInSearchProvider.facts[provider].isEnabledByDefault));
        }
        for (const provider of custom.filter((candidate) => candidate.kind === kind)) rows.push(customRow(context, search, provider));
        return group(SearchProviderKind.facts[kind].title.text, rows);
    });
    const actions = group(null, [
        wideRow(
            button("Add Provider…", () => editProvider(context, null)),
            element("span", "settings-spacer"),
            button("Restore Defaults…", () =>
                showAlert({
                    title: "Restore the built-in providers?",
                    message: "Shortcuts and options you changed go back to how they ship. Providers you added stay.",
                    buttons: [
                        { title: "Restore Defaults", role: "destructive", action: () => void context.send({ kind: "ResetSearchProviders", value: {} }) },
                        { title: "Cancel", role: "cancel" },
                    ],
                }),
            ),
        ),
    ]);
    return [...groups, actions];
}

function isDefault(search: SearchCatalogChanged, name: string): boolean {
    return search.default.name === name || search.privateDefault.name === name;
}

/** A provider's row: its disclosure, title, first shortcut and switch. */
function providerRow(title: string, shortcut: string | undefined, isEnabled: boolean, locked: boolean, open: boolean, change: (isOn: boolean) => void, disclose: () => void): HTMLElement {
    const node = element("div", "settings-row settings-provider");
    const disclosure = element("button", open ? "settings-disclosure open" : "settings-disclosure");
    disclosure.type = "button";
    disclosure.innerHTML = sfSymbol("chevron.right", 11);
    disclosure.setAttribute("aria-label", `${title} options`);
    disclosure.setAttribute("aria-expanded", String(open));
    disclosure.addEventListener("click", disclose);
    const label = element("div", "settings-row-label");
    label.append(element("span", "settings-row-title", title));
    node.append(disclosure, label);
    if (shortcut) node.append(element("span", "settings-shortcut-chip", shortcut));
    const enabled = toggle(isEnabled || locked, change, locked);
    enabled.setAttribute("aria-label", title);
    enabled.classList.add("settings-control");
    node.append(enabled);
    return node;
}

function builtInRows(context: SettingsContext, search: SearchCatalogChanged, provider: BuiltInSearchProvider, isEnabled: boolean): HTMLElement[] {
    const facts = BuiltInSearchProvider.facts[provider];
    const settings = search.catalog.builtIns.find((candidate) => candidate.provider === provider);
    const shortcuts = settings?.shortcuts ?? facts.shortcuts;
    const open = expanded.has(facts.name);
    const rows = [
        providerRow(
            facts.title,
            shortcuts[0],
            isEnabled,
            isDefault(search, facts.name),
            open,
            (isOn) => void context.send({ kind: "SetSearchProviderEnabled", value: { provider, isEnabled: isOn } }),
            () => {
                if (open) expanded.delete(facts.name);
                else expanded.add(facts.name);
                context.redraw();
            },
        ),
    ];
    if (!open) return rows;
    for (const option of facts.options) {
        const optionFacts = SearchProviderOption.facts[option];
        const value = settings?.options.find((setting) => setting.option === option)?.value ?? null;
        const set = (next: string | null): void => void context.send({ kind: "SetSearchOption", value: { provider, option, value: next } });
        let control: HTMLElement | null = null;
        if (optionFacts.isSwitch) control = toggle(value === SearchProviderOption.constants.on, (isOn) => set(isOn ? SearchProviderOption.constants.on : null));
        else if (optionFacts.choices.length > 0)
            control = picker(
                optionFacts.choices.map((choice) => ({ value: SearchChoice.facts[choice].name, title: SearchChoice.facts[choice].title.text })),
                value ?? SearchChoice.facts[optionFacts.choices[0]!].name,
                (next) => set(next),
            );
        else if (optionFacts.acceptsText) control = textField(value ?? "", optionFacts.textExample ?? "", (next) => set(next.trim() || null));
        if (control) rows.push(nested(row(optionFacts.title.text, control)));
    }
    rows.push(
        nested(
            wideRow(
                button("Edit Shortcuts…", () => editShortcuts(context, provider, settings?.shortcuts ?? null)),
            ),
        ),
    );
    return rows;
}

function customRow(context: SettingsContext, search: SearchCatalogChanged, provider: CustomSearchProvider): HTMLElement {
    const node = providerRow(provider.name, provider.shortcuts[0], true, search.default.customId === provider.id || search.privateDefault.customId === provider.id, false, () => undefined, () => editProvider(context, provider));
    node.querySelector<HTMLInputElement>(".settings-switch")!.hidden = true;
    const edit = button("Edit…", () => editProvider(context, provider));
    edit.classList.add("small");
    node.append(edit);
    return node;
}

function nested(node: HTMLElement): HTMLElement {
    node.classList.add("nested");
    return node;
}

function editShortcuts(context: SettingsContext, provider: BuiltInSearchProvider, shortcuts: readonly string[] | null): void {
    const builtIn = BuiltInSearchProvider.facts[provider].shortcuts.join(", ");
    showAlert({
        title: BuiltInSearchProvider.facts[provider].title,
        message: "Separate shortcuts with commas.",
        field: { value: (shortcuts ?? BuiltInSearchProvider.facts[provider].shortcuts).join(", "), placeholder: builtIn },
        buttons: [
            {
                title: "Save",
                role: "default",
                action: (text) => void context.send({ kind: "SetSearchShortcuts", value: { provider, shortcuts: splitShortcuts(text) } }),
            },
            { title: "Use Built-In Shortcuts", role: "destructive", action: () => void context.send({ kind: "SetSearchShortcuts", value: { provider, shortcuts: null } }) },
            { title: "Cancel", role: "cancel" },
        ],
    });
}

function splitShortcuts(text: string): string[] {
    return text
        .split(",")
        .map((shortcut) => shortcut.trim())
        .filter((shortcut) => shortcut.length > 0);
}

/** Adds a provider, or edits one the person added (BrowserSearchProviderEditor). */
function editProvider(context: SettingsContext, provider: CustomSearchProvider | null): void {
    const layer = element("div", "alert-layer settings-sheet-layer");
    const sheet = element("form", "alert settings-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const title = provider ? "Edit Provider" : "Add Provider";
    sheet.setAttribute("aria-label", title);
    const field = (label: string, value: string, placeholder: string): HTMLInputElement => {
        const input = element("input", "settings-field");
        input.value = value;
        input.placeholder = placeholder;
        input.spellcheck = false;
        input.setAttribute("aria-label", label);
        return input;
    };
    const kinds = SearchProviderKind.all.map((value) => ({ value, title: SearchProviderKind.facts[value].itemTitle.text }));
    let kind = provider?.kind ?? SearchProviderKind.all[0]!;
    const kindPicker = picker(kinds, kind, (value) => (kind = value));
    const name = field("Name", provider?.name ?? "", "");
    const shortcuts = field("Shortcuts", provider?.shortcuts.join(", ") ?? "", "docs, d");
    const template = field("Search URL", provider?.searchUrlTemplate ?? "", "https://example.com/search?q=%s");
    const suggestions = field("Suggestions URL", provider?.suggestionUrlTemplate ?? "", "Optional");
    const labelled = (label: string, control: HTMLElement): HTMLElement => {
        const node = element("label", "settings-sheet-field");
        node.append(element("span", "", label), control);
        return node;
    };
    const close = (): void => layer.remove();
    const buttons = element("div", "alert-buttons");
    if (provider) {
        buttons.append(
            button("Remove Provider", () => {
                close();
                void context.send({ kind: "RemoveSearchProvider", value: { id: provider.id } });
            }, "destructive"),
        );
    }
    const cancel = button("Cancel", close);
    const save = button("Save", () => undefined, "prominent");
    save.type = "submit";
    buttons.append(element("span", "settings-spacer"), cancel, save);
    sheet.append(
        element("h2", "alert-title", title),
        labelled("Kind", kindPicker),
        labelled("Name", name),
        labelled("Shortcuts", shortcuts),
        labelled("Search URL", template),
        labelled("Suggestions URL", suggestions),
        element("p", "settings-footer", "Use “%s” where the search words go."),
        buttons,
    );
    sheet.addEventListener("submit", (event) => {
        event.preventDefault();
        const kept: CustomSearchProvider = {
            id: provider?.id ?? crypto.randomUUID(),
            name: name.value.trim(),
            searchUrlTemplate: template.value.trim(),
            suggestionUrlTemplate: suggestions.value.trim() || null,
            kind,
            shortcuts: splitShortcuts(shortcuts.value),
            color: provider?.color ?? null,
        };
        void context.send({ kind: "SaveSearchProvider", value: { provider: kept } }).then((saved) => saved && close());
    });
    layer.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close();
    });
    layer.addEventListener("mousedown", (event) => {
        if (event.target === layer) close();
    });
    layer.append(sheet);
    document.body.append(layer);
    name.focus();
}
