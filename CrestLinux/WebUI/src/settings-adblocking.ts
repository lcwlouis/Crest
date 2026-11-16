// Settings' Ad Blocking page (BrowserAdBlockingSettingsPane): how much the
// content blocker blocks, its filter lists, lists the person subscribes to,
// their own filters, and the sites with blocking off. The core keeps them in
// its device store, fetches the lists and applies every rule.

import { ContentBlockingLevel, FilterList, FilterListGroup, referenceDateUnixSeconds } from "../generated/crest_contracts.js";
import type { FilterLists, WireDate } from "../generated/crest_contracts.js";
import type { SettingsContext } from "./settings.js";
import { button, element, glyphButton, group, row, segmented, textField, toggle, wideRow } from "./settings-form.js";

/** The person's filters while they edit them, kept across the page's redraws. */
let draftFilters: string | null = null;
let newListAddress = "";
let siteQuery = "";

function updated(date: WireDate | null): string {
    if (date === null) return "Not yet";
    const when = new Date((Number(date) + referenceDateUnixSeconds) * 1000);
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(when);
}

export function adBlockingPage(context: SettingsContext): (HTMLElement | null)[] {
    const lists = context.preferences.filterLists;
    if (!lists) return [];
    const blocks = ContentBlockingLevel.facts[lists.level].blocksContent;
    const levelControls = element("div", "settings-inline-controls");
    if (lists.isCustomized) levelControls.append(element("span", "settings-row-detail", "Customized"));
    const level = segmented(
        ContentBlockingLevel.all.map((value) => ({ value, title: ContentBlockingLevel.facts[value].title.text })),
        lists.level,
        (value) => void context.send({ kind: "SetContentBlockingLevel", value: { level: value } }),
    );
    level.setAttribute("aria-label", "Blocking");
    levelControls.append(level);
    return [
        group(null, [row("Blocking", levelControls)], { footer: ContentBlockingLevel.facts[lists.level].summary.text }),
        ...filterListGroups(context, lists, !blocks),
        yourLists(context, lists, !blocks),
        myFilters(context, lists, !blocks),
        sitesWithBlockingOff(context, !blocks),
    ];
}

function filterListGroups(context: SettingsContext, lists: FilterLists, disabled: boolean): HTMLElement[] {
    const latest = lists.lists.reduce<WireDate | null>((last, state) => (state.updatedAt !== null && (last === null || state.updatedAt > last) ? state.updatedAt : last), null);
    const groups = FilterListGroup.all.map((kind) =>
        group(
            FilterListGroup.facts[kind].title.text,
            lists.lists
                .filter((state) => FilterList.facts[state.list].group === kind)
                .map((state) =>
                    row(
                        FilterList.facts[state.list].title,
                        toggle(state.isOn, (isOn) => void context.send({ kind: "SetFilterList", value: { list: state.list, isOn } })),
                        state.isFailing ? "Couldn’t update" : undefined,
                    ),
                ),
            { disabled },
        ),
    );
    const update = element("div", "settings-inline-controls");
    update.append(
        element("span", "settings-row-value", updated(latest)),
        button("Update Now", () => void context.send({ kind: "RefreshFilterLists", value: {} })),
    );
    groups.push(group(null, [row("Updated", update)], { disabled }));
    return groups;
}

function yourLists(context: SettingsContext, lists: FilterLists, disabled: boolean): HTMLElement {
    const field = textField(newListAddress, "https://example.com/list.txt", (value) => (newListAddress = value));
    field.setAttribute("aria-label", "Filter list address");
    field.addEventListener("input", () => (newListAddress = field.value));
    field.classList.add("settings-grow");
    const add = (): void => {
        const url = field.value.trim();
        if (!url) return;
        void context.send({ kind: "AddCustomFilterList", value: { id: crypto.randomUUID(), url } }).then((added) => {
            if (!added) return;
            newListAddress = "";
            context.redraw();
        });
    };
    field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") add();
    });
    return group(
        "Your Lists",
        [
            ...lists.customLists.map((state) => {
                const controls = element("div", "settings-inline-controls");
                controls.append(
                    toggle(state.list.isOn, (isOn) => void context.send({ kind: "SetCustomFilterList", value: { id: state.list.id, isOn } })),
                    glyphButton("trash", `Remove ${state.title}`, () => void context.send({ kind: "RemoveCustomFilterList", value: { id: state.list.id } })),
                );
                return row(state.title, controls, state.isTooLarge ? "Too large to use" : state.isFailing ? "Couldn’t update" : state.list.url);
            }),
            wideRow(field, button("Add List", add)),
        ],
        { footer: "Subscribe to any list by its address. It updates with the built-in lists.", disabled },
    );
}

function myFilters(context: SettingsContext, lists: FilterLists, disabled: boolean): HTMLElement {
    const editor = element("textarea", "settings-text-editor");
    editor.value = draftFilters ?? lists.customFilters;
    editor.spellcheck = false;
    editor.rows = 6;
    editor.setAttribute("aria-label", "My Filters");
    const changed = (): boolean => (draftFilters ?? lists.customFilters) !== lists.customFilters;
    const revert = button("Revert", () => {
        draftFilters = null;
        context.redraw();
    }, "plain", !changed());
    const save = button("Save", () => {
        const text = editor.value;
        void context.send({ kind: "SetCustomFilters", value: { text } }).then((saved) => {
            if (!saved) return;
            draftFilters = null;
            context.redraw();
        });
    }, "prominent", !changed());
    editor.addEventListener("input", () => {
        draftFilters = editor.value;
        revert.disabled = save.disabled = !changed();
    });
    const actions = element("div", "settings-inline-controls settings-end");
    actions.append(revert, save);
    const body = element("div", "settings-row wide settings-stack");
    body.append(editor, actions);
    return group("My Filters", [body], { footer: "One rule per line, as filter lists write them. Block Element adds its rules here.", disabled });
}

function sitesWithBlockingOff(context: SettingsContext, disabled: boolean): HTMLElement {
    const sites = context.preferences.blockingOff;
    const spaces = context.workspace()?.spaces;
    const query = siteQuery.trim().toLowerCase();
    const shown = sites.filter((site) => !query || site.origin.host.toLowerCase().includes(query));
    const rows: HTMLElement[] = [];
    if (sites.length > 0) {
        const search = element("input", "settings-field settings-grow");
        search.type = "search";
        search.placeholder = "Search Sites";
        search.value = siteQuery;
        search.setAttribute("aria-label", "Search Sites");
        search.addEventListener("input", () => {
            siteQuery = search.value;
            context.redraw();
        });
        rows.push(wideRow(search));
    }
    if (sites.length === 0) rows.push(wideRow(element("span", "settings-row-detail", "None")));
    else if (shown.length === 0) rows.push(wideRow(element("span", "settings-row-detail", "No Sites Found")));
    for (const site of shown) {
        const turnOn = button("Turn On Blocking", () =>
            void context.send({ kind: "SetSiteContentBlocking", value: { spaceId: site.spaceId, origin: site.origin, blocks: true } }),
        );
        turnOn.setAttribute("aria-label", `Turn on blocking for ${site.origin.host}`);
        rows.push(row(site.origin.host, turnOn, spaces?.get(site.spaceId)?.state.settings.name));
    }
    return group("Sites with Blocking Off", rows, {
        footer: "Turn blocking off for a site from its page menu. Ad blocking settings stay on this device.",
        disabled,
    });
}
