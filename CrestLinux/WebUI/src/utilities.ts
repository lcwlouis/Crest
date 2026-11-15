// The sidebar's utility lists, as the Mac's BrowserUtilityPresentationState
// and SpaceSidebarUtilityContent show them: the Space's archive, its history
// and its downloads. The lists button at the switcher's page side opens the
// list chosen for the Space (or Downloads while downloads wait unseen), and
// the list takes the place of the Space's tabs, with a search field and a
// filter menu where the address field was. While a list is open the three
// lists fan out beside the sidebar, over the page, and a press on the page,
// on the list's empty space or on the lists button puts it away, as does
// Escape. Seeing Downloads acknowledges the Space's downloads, which clears
// the button's badge.
//
// Which list the button opens in each Space is this device's choice, kept
// across launches as the Mac keeps it in its defaults.

import { ArchiveFilterGroup, ArchiveReason, DownloadPhase } from "../generated/crest_contracts.js";
import type { DownloadState, Guid, HistoryEntryState, Intent } from "../generated/crest_contracts.js";
import { openDownload, showDownloadInFolder } from "./bridge.js";
import { showAlert } from "./alert.js";
import { Menu } from "./menu.js";
import type { MenuEntry } from "./menu.js";
import type { Model, Space, Workspace } from "./model.js";
import { holdOverlay } from "./overlay.js";
import { sfSymbol } from "./symbols.js";
import { ArchiveItem, DownloadItem, HistoryItem } from "./utility-rows.js";
import type { DownloadAction, UtilityItem, UtilityRowHost } from "./utility-rows.js";

// MARK: - Types

/** A filter of a list, as the Mac's BrowserUtilityListFilter. */
interface UtilityFilter {
    readonly name: string;
    readonly title: string;
    readonly symbol: string;
    includes(item: UtilityItem, now: Date): boolean;
}

/** One list: what it is called, what it says when empty, its filters and its items. */
export interface UtilitySurface {
    readonly name: "archive" | "history" | "downloads";
    readonly title: string;
    readonly symbol: string;
    readonly searchPrompt: string;
    readonly emptyTitle: string;
    readonly emptyDescription: string;
    noResults(query: string): string;
    readonly filterLabel: string;
    readonly filters: readonly UtilityFilter[];
    /** The filter menu also offers to clear the Space's history. */
    readonly clearsHistory: boolean;
    items(space: Space, downloads: readonly DownloadState[]): UtilityItem[];
}

const everything: UtilityFilter = { name: "all", title: "All", symbol: "line.3.horizontal.decrease", includes: () => true };

const day = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** History visited within the last `count` days or months. */
function visitedWithin(name: string, title: string, back: (now: Date) => Date): UtilityFilter {
    return { name, title, symbol: "calendar.badge.clock", includes: (item, now) => item instanceof HistoryItem && item.date >= back(now) };
}

function downloadPhase(name: string, title: string, symbol: string, passes: (phase: DownloadState["phase"]) => boolean): UtilityFilter {
    return { name, title, symbol, includes: (item) => item instanceof DownloadItem && passes(item.download.phase) };
}

export const UtilitySurface: { readonly archive: UtilitySurface; readonly history: UtilitySurface; readonly downloads: UtilitySurface; readonly all: readonly UtilitySurface[] } = (() => {
    const archive: UtilitySurface = {
        name: "archive",
        title: "Archive",
        symbol: "archivebox",
        searchPrompt: "Search Archive…",
        emptyTitle: "No Archived Tabs",
        emptyDescription: "Closed and automatically cleaned tabs from this Space appear here.",
        noResults: (query) => `No archived tabs in this Space match “${query}”.`,
        filterLabel: "Filter Archive",
        filters: [
            everything,
            ...ArchiveFilterGroup.all.map((group): UtilityFilter => ({
                name: `archive.${ArchiveFilterGroup.facts[group].name}`,
                title: ArchiveFilterGroup.facts[group].title.text,
                symbol: ArchiveFilterGroup.facts[group].symbol,
                includes: (item) => item instanceof ArchiveItem && ArchiveReason.facts[item.entry.reason].filterGroup === group,
            })),
        ],
        clearsHistory: false,
        items: (space) => space.archive.filter((entry) => entry.tab.surface !== "StartPage").map((entry) => new ArchiveItem(entry)),
    };
    const history: UtilitySurface = {
        name: "history",
        title: "History",
        symbol: "clock.arrow.circlepath",
        searchPrompt: "Search History…",
        emptyTitle: "No History",
        emptyDescription: "Completed visits from this Space appear here and remain separate from every other Space.",
        noResults: (query) => `No history entries in this Space match “${query}”.`,
        filterLabel: "Filter History",
        filters: [
            everything,
            {
                name: "history.today",
                title: "Today",
                symbol: "calendar",
                includes: (item, now) => item instanceof HistoryItem && startOfDay(item.date).getTime() === startOfDay(now).getTime(),
            },
            visitedWithin("history.pastWeek", "Past Week", (now) => new Date(now.getTime() - 7 * day)),
            visitedWithin("history.pastMonth", "Past Month", (now) => new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), now.getHours(), now.getMinutes())),
        ],
        clearsHistory: true,
        // TODO(linux): a Space group's members share one history (the Mac's
        // groupHistory) once Linux shows Sub-Spaces.
        items: (space) => space.history.map((entry) => new HistoryItem(entry)),
    };
    const downloads: UtilitySurface = {
        name: "downloads",
        title: "Downloads",
        symbol: "arrow.down.circle",
        searchPrompt: "Search Downloads…",
        emptyTitle: "No Downloads",
        emptyDescription: "Downloads from this Space appear here.",
        noResults: (query) => `No downloads in this Space match “${query}”.`,
        filterLabel: "Filter Downloads",
        filters: [
            everything,
            downloadPhase("downloads.inProgress", "In Progress", "arrow.down.circle", (phase) => DownloadPhase.facts[phase].isLive),
            downloadPhase("downloads.finished", "Finished", "checkmark.circle.fill", (phase) => DownloadPhase.facts[phase].isComplete),
            downloadPhase("downloads.needsAttention", "Needs Attention", "exclamationmark.triangle.fill", (phase) => DownloadPhase.facts[phase].needsAttention),
        ],
        clearsHistory: false,
        items: (_space, downloads) => downloads.map((download) => new DownloadItem(download)),
    };
    return { archive, history, downloads, all: [archive, history, downloads] };
})();

/** The heading a run of items falls under by age, as the Mac's BrowserUtilityTimeSection. */
function timeSection(date: Date, now: Date): { readonly id: string; readonly title: string } {
    const today = startOfDay(now);
    const itemDay = startOfDay(date < now ? date : now);
    const daysAgo = Math.max(Math.round((today.getTime() - itemDay.getTime()) / day), 0);
    if (daysAgo < 7) {
        const title = daysAgo === 0 ? "Today" : daysAgo === 1 ? "1 day ago" : `${daysAgo} days ago`;
        return { id: `day-${itemDay.getTime()}`, title };
    }
    if (daysAgo < 42) {
        const weeks = Math.max(Math.floor(daysAgo / 7), 1);
        return { id: `week-${weeks}`, title: weeks === 1 ? "1 week ago" : `${weeks} weeks ago` };
    }
    return {
        id: `month-${itemDay.getFullYear()}-${itemDay.getMonth()}`,
        title: itemDay.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    };
}

/** Where the button's list for each Space is kept, by the Space's id, as the Mac's defaults key. */
const triggerSurfacesKey = "browser.utility.trigger-surfaces";

/** The fan's measures: BrowserUtilitySwitcherLayout and BrowserRootMetrics. */
const fan = { step: 64, buttonSize: 44, destinationGap: 18, additionalEdgeOffset: 12 };

/** What the lists ask of the window they sit in. */
export interface UtilitiesHost {
    readonly model: Model;
    readonly imageOf: (tabId: Guid) => string | null;
    readonly windowId: () => Guid;
    readonly space: () => Space | undefined;
    readonly workspace: () => Workspace | undefined;
    /** Sends an intent; true once the core took it. */
    readonly send: (intent: Intent) => Promise<boolean>;
    /** The sidebar draws again: the list takes the tabs' place, or gives it back. */
    readonly redraw: () => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// MARK: - Utilities

export class Utilities {
    private readonly host: UtilitiesHost;
    private shown: UtilitySurface | null = null;
    private filter: UtilityFilter = everything;
    private search = "";
    /** The downloads the list last showed, to acknowledge new ones as they come. */
    private seenDownloads = "";
    private releaseOverlay: (() => void) | null = null;

    /** The search toolbar and the list, which stay in place while the list draws again. */
    readonly element = element("div", "utility");
    private readonly field = element("input", "utility-search-field");
    private readonly clearSearch = element("button", "utility-search-clear");
    private readonly filterButton = element("button", "utility-filter");
    private readonly list = element("div", "utility-list");
    private readonly fanLayer = element("div", "utility-fan");
    /**
     * The lists button. The sidebar draws its switcher again on every change
     * and keeps this one button, so a press that a change lands in the middle
     * of still reaches it.
     */
    private readonly trigger = element("button", "lists-button");

    constructor(host: UtilitiesHost) {
        this.host = host;
        const search = element("label", "utility-search");
        search.innerHTML = sfSymbol("magnifyingglass", 12);
        this.field.type = "search";
        this.field.spellcheck = false;
        this.field.addEventListener("input", () => {
            this.search = this.field.value;
            this.drawList();
        });
        this.field.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && this.field.value) {
                event.stopPropagation();
                this.setSearch("");
            }
        });
        this.clearSearch.innerHTML = sfSymbol("xmark.circle.fill", 13);
        this.clearSearch.title = "Clear";
        this.clearSearch.setAttribute("aria-label", "Clear");
        this.clearSearch.addEventListener("click", () => {
            this.setSearch("");
            this.field.focus();
        });
        search.append(this.field, this.clearSearch);
        this.filterButton.innerHTML = sfSymbol("line.3.horizontal.decrease", 15);
        this.filterButton.setAttribute("aria-haspopup", "menu");
        this.filterButton.addEventListener("click", () => this.openFilterMenu());
        const toolbar = element("div", "utility-toolbar");
        toolbar.append(search, this.filterButton);
        // A press on the list's empty space puts the list away.
        this.list.addEventListener("click", (event) => {
            const target = event.target as Element;
            if (!target.closest(".utility-row, button")) this.dismiss();
        });
        this.element.append(toolbar, this.list);
        document.body.append(this.fanLayer);
        this.fanLayer.hidden = true;
        this.trigger.title = "Archive, History, and Downloads";
        this.trigger.addEventListener("click", () => this.toggle());
        this.trigger.addEventListener("contextmenu", (event) => this.openTriggerMenu(event));
        // A press on the page puts the list away, as the Mac's page does,
        // and so does Escape that nothing nearer took: a menu, an alert, or
        // the search field clearing its text.
        document.getElementById("page")!.addEventListener("mousedown", () => this.dismiss());
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || event.defaultPrevented || !this.shown) return;
            event.preventDefault();
            this.dismiss();
        });
        window.addEventListener("resize", () => this.placeFan());
    }

    /** The list the window shows in place of the Space's tabs, if any. */
    get surface(): UtilitySurface | null {
        return this.shown;
    }

    get isOpen(): boolean {
        return this.shown !== null;
    }

    /** The Space's downloads: the ones its profile holds. */
    private downloads(space: Space | undefined): DownloadState[] {
        return space ? this.host.model.downloads.filter((download) => download.profileId === space.state.profileId) : [];
    }

    private unseenDownloads(space: Space | undefined): DownloadState[] {
        return this.downloads(space).filter((download) => !download.isAcknowledged);
    }

    // MARK: - Actions - Presentation

    /** The lists button: opens the list chosen for the Space, or Downloads while downloads wait unseen; closes an open list. */
    toggle(): void {
        if (this.shown) {
            this.dismiss();
            return;
        }
        const space = this.host.space();
        this.present(this.unseenDownloads(space).length > 0 ? UtilitySurface.downloads : this.triggerSurface(space?.state.id));
    }

    /** Show History, Show Archive and Show Downloads: open that list, or put it away when it shows. */
    toggleSurface(surface: UtilitySurface): void {
        if (this.shown === surface) this.dismiss();
        else this.present(surface);
    }

    present(surface: UtilitySurface): void {
        if (this.shown !== surface) {
            this.search = "";
            this.field.value = "";
            this.filter = everything;
        }
        this.shown = surface;
        this.releaseOverlay ??= holdOverlay();
        this.host.redraw();
        this.acknowledge(true);
        this.field.focus({ preventScroll: true });
    }

    dismiss(): void {
        if (!this.shown) return;
        this.shown = null;
        this.search = "";
        this.field.value = "";
        this.filter = everything;
        this.seenDownloads = "";
        Menu.closeAll();
        this.fanLayer.hidden = true;
        this.fanLayer.classList.remove("settled");
        this.releaseOverlay?.();
        this.releaseOverlay = null;
        this.host.redraw();
    }

    /** The list the lists button opens in a Space: the one chosen there, else the archive. */
    private triggerSurface(spaceId: Guid | undefined): UtilitySurface {
        const name = spaceId ? this.storedTriggerSurfaces()[spaceId] : undefined;
        return UtilitySurface.all.find((surface) => surface.name === name) ?? UtilitySurface.archive;
    }

    private chooseTriggerSurface(surface: UtilitySurface, spaceId: Guid): void {
        const stored = this.storedTriggerSurfaces();
        stored[spaceId] = surface.name;
        localStorage.setItem(triggerSurfacesKey, JSON.stringify(stored));
        this.host.redraw();
    }

    private storedTriggerSurfaces(): Record<string, string> {
        try {
            const stored: unknown = JSON.parse(localStorage.getItem(triggerSurfacesKey) ?? "{}");
            return stored && typeof stored === "object" ? (stored as Record<string, string>) : {};
        } catch {
            return {};
        }
    }

    /**
     * Seeing Downloads acknowledges the Space's downloads, as the Mac's sidebar
     * does when Downloads opens and each time its downloads change.
     */
    private acknowledge(force: boolean): void {
        if (this.shown !== UtilitySurface.downloads) return;
        const space = this.host.space();
        const downloads = this.downloads(space);
        const ids = downloads.map((download) => download.id).join(",");
        if (!force && ids === this.seenDownloads) return;
        this.seenDownloads = ids;
        if (space && downloads.some((download) => !download.isAcknowledged)) {
            void this.host.send({ kind: "AcknowledgeDownloads", value: { profileId: space.state.profileId } });
        }
    }

    // MARK: - Actions - Drawing

    /** Draws the open list again with the core's state, keeping the search field as it is. */
    render(): void {
        if (!this.shown) return;
        const surface = this.shown;
        this.field.placeholder = surface.searchPrompt;
        this.field.setAttribute("aria-label", surface.searchPrompt);
        this.filterButton.title = surface.filterLabel;
        this.filterButton.setAttribute("aria-label", surface.filterLabel);
        this.filterButton.classList.toggle("filtered", this.filter !== everything);
        this.drawList();
        this.acknowledge(false);
    }

    private setSearch(text: string): void {
        this.search = text;
        this.field.value = text;
        this.drawList();
    }

    private drawList(): void {
        const surface = this.shown;
        const space = this.host.space();
        this.clearSearch.hidden = this.search.length === 0;
        if (!surface || !space) return;
        const now = new Date();
        const query = this.search.trim();
        const items = surface
            .items(space, this.downloads(space))
            .filter((item) => item.matches(query) && this.filter.includes(item, now))
            .sort((a, b) => b.date.getTime() - a.date.getTime());
        const scroll = this.list.scrollTop;
        if (items.length === 0) {
            this.list.replaceChildren(this.emptyState(surface, query));
            return;
        }
        const rowHost = this.rowHost(space);
        const sections: HTMLElement[] = [];
        let current: { id: string; node: HTMLElement } | null = null;
        for (const item of items) {
            const section = timeSection(item.date, now);
            if (!current || current.id !== section.id) {
                const node = element("section", "utility-section");
                node.append(element("h3", "utility-section-title", section.title));
                current = { id: section.id, node };
                sections.push(node);
            }
            current.node.append(item.row(rowHost));
        }
        this.list.replaceChildren(...sections);
        this.list.scrollTop = scroll;
    }

    private emptyState(surface: UtilitySurface, query: string): HTMLElement {
        const empty = element("div", "utility-empty");
        const icon = element("span", "utility-empty-icon");
        icon.innerHTML = sfSymbol(query ? "magnifyingglass" : surface.symbol, 34);
        const description = query
            ? surface.noResults(query)
            : this.filter !== everything
              ? "No items match the selected filter."
              : surface.emptyDescription;
        empty.append(icon, element("h3", "utility-empty-title", query ? "No Results" : surface.emptyTitle), element("p", "utility-empty-description", description));
        return empty;
    }

    private openFilterMenu(): void {
        const surface = this.shown;
        if (!surface) return;
        const entries: MenuEntry[] = surface.filters.map((filter) => ({
            title: filter.title,
            icon: { kind: "symbol", name: filter.symbol },
            checked: filter === this.filter,
            action: () => {
                this.filter = filter;
                this.render();
            },
        }));
        if (surface.clearsHistory) {
            entries.push("separator", {
                title: "Clear History",
                icon: { kind: "symbol", name: "trash" },
                destructive: true,
                action: () => this.confirmClearHistory(),
            });
        }
        Menu.open(entries, { anchor: this.filterButton.getBoundingClientRect() });
    }

    /** Asks before it clears the Space's history, as the Mac's BrowserSidebarClearHistoryDialog. */
    private confirmClearHistory(): void {
        const space = this.host.space();
        const workspace = this.host.workspace();
        if (!space || !workspace) return;
        const spaceId = space.state.id;
        showAlert({
            title: `Clear history for ${space.state.settings.name}?`,
            message: "History in other Spaces is not affected.",
            buttons: [
                { title: "Cancel", role: "cancel" },
                {
                    title: "Clear History",
                    role: "destructive",
                    action: () => {
                        // The request is dropped once the Space is no longer the one it was asked about.
                        if (this.host.space()?.state.id !== spaceId) return;
                        void this.host.send({ kind: "ClearHistory", value: { workspaceId: workspace.id, spaceId, range: "AllTime" } });
                    },
                },
            ],
        });
    }

    // MARK: - Actions - Rows

    private rowHost(space: Space): UtilityRowHost {
        const spaceId = space.state.id;
        // Each action is refused once the Space is no longer the shown one it was drawn for.
        const current = (): Space | undefined => {
            const shown = this.host.space();
            return shown?.state.id === spaceId ? shown : undefined;
        };
        return {
            imageOf: this.host.imageOf,
            restoreArchivedTab: (tabId) => {
                const workspace = this.host.workspace();
                if (!current() || !workspace) return;
                void this.host.send({
                    kind: "RestoreArchivedTab",
                    value: { workspaceId: workspace.id, windowId: this.host.windowId(), spaceId, tabId },
                });
            },
            openHistoryEntry: (entry) => this.openHistoryEntry(entry, spaceId),
            performDownloadAction: (action, download) => {
                if (current()) this.performDownloadAction(action, download);
            },
            openMenu: (entries, placement) => Menu.open(entries, placement),
        };
    }

    /** Opens a history entry in a new tab of the Space, as the Mac's windowed shell does. */
    private openHistoryEntry(entry: HistoryEntryState, spaceId: Guid): void {
        const workspace = this.host.workspace();
        if (this.host.space()?.state.id !== spaceId || !workspace) return;
        void this.host.send({
            kind: "OpenAddress",
            value: { workspaceId: workspace.id, windowId: this.host.windowId(), spaceId, tabId: crypto.randomUUID(), address: entry.url },
        });
    }

    /** A row's action, guarded as the Mac's BrowserDownloadCenter guards each. */
    private performDownloadAction(action: DownloadAction, download: DownloadState): void {
        const current = this.host.model.downloads.find((held) => held.id === download.id);
        if (!current) return;
        const phase = DownloadPhase.facts[current.phase];
        const downloadId = current.id;
        switch (action.kind) {
            case "open":
                if (!phase.isComplete || !current.destination) return;
                if (action.destination.name === "open") openDownload(current.destination);
                else showDownloadInFolder(current.destination);
                return;
            case "retry":
                if (phase.canRetry) void this.host.send({ kind: "RestartDownload", value: { downloadId } });
                return;
            case "pause":
                if (current.canPause) void this.host.send({ kind: "PauseDownload", value: { downloadId } });
                return;
            case "resume":
                if (current.canResume) void this.host.send({ kind: "ResumeDownload", value: { downloadId } });
                return;
            case "cancel":
                if (phase.isLive) void this.host.send({ kind: "CancelDownload", value: { downloadId, message: "Canceled." } });
                return;
            case "clear":
                if (!phase.isLive) void this.host.send({ kind: "RemoveDownload", value: { downloadId } });
                return;
        }
    }

    // MARK: - Actions - Lists button and fan

    /**
     * The switcher's lists button, wearing the symbol of the list it opens
     * (filled while one is open) and, while downloads wait unseen, a badge
     * with their count: red while one needs attention, with the newest live
     * download's progress round it. Its menu chooses the list it opens.
     */
    listsButton(space: Space): HTMLElement {
        const unseen = this.unseenDownloads(space);
        const downloads = this.downloads(space);
        const opens = unseen.length > 0 ? UtilitySurface.downloads : this.triggerSurface(space.state.id);
        const button = this.trigger;
        button.classList.toggle("expanded", this.shown !== null);
        button.setAttribute("aria-label", opens.title);
        button.setAttribute("aria-expanded", String(this.shown !== null));
        // Drawn again only when it shows something else, so a press on it
        // ends on what it began on.
        const badge = unseen.length > 0 ? this.badge(unseen.length, downloads) : null;
        const symbol = (this.shown ?? opens).symbol;
        const key = JSON.stringify([symbol, badge?.outerHTML ?? null]);
        if (button.dataset.key !== key) {
            button.dataset.key = key;
            button.innerHTML = sfSymbol(symbol, 17);
            if (badge) button.append(badge);
        }
        requestAnimationFrame(() => this.drawFan(space));
        return button;
    }

    /** The lists button's menu: the list it opens in the shown Space. */
    private openTriggerMenu(event: MouseEvent): void {
        event.preventDefault();
        const spaceId = this.host.space()?.state.id;
        if (!spaceId) return;
        const chosen = this.triggerSurface(spaceId);
        Menu.open(
            UtilitySurface.all.map((surface) => ({
                title: surface.title,
                icon: { kind: "symbol", name: surface.symbol },
                checked: surface === chosen,
                action: () => this.chooseTriggerSurface(surface, spaceId),
            })),
            { x: event.clientX, y: event.clientY },
        );
    }

    private badge(count: number, downloads: readonly DownloadState[]): HTMLElement {
        const badge = element("span", "lists-badge", String(Math.min(count, 99)));
        if (downloads.some((download) => DownloadPhase.facts[download.phase].needsAttention)) badge.classList.add("danger");
        const live = downloads.filter((download) => DownloadPhase.facts[download.phase].isLive);
        const newest = live.sort((a, b) => b.createdAt - a.createdAt)[0];
        if (newest) {
            badge.classList.add("progress");
            badge.style.setProperty("--progress", String(Math.min(Math.max(newest.progress, 0.04), 1)));
        }
        return badge;
    }

    /** The three lists fanned out beside the lists button, over the page, while one is open. */
    private drawFan(space: Space): void {
        this.fanLayer.hidden = !this.shown;
        if (!this.shown) return;
        const downloads = this.downloads(space);
        const unseen = this.unseenDownloads(space).length;
        const buttons = UtilitySurface.all.map((surface) => {
            const selected = surface === this.shown;
            const button = element("button", selected ? "fan-button selected" : "fan-button");
            let symbol = surface.symbol;
            if (surface === UtilitySurface.downloads) {
                if (downloads.some((download) => DownloadPhase.facts[download.phase].needsAttention)) {
                    symbol = "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90";
                } else if (!downloads.some((download) => DownloadPhase.facts[download.phase].isLive)) {
                    symbol = "arrow.down.circle.fill";
                }
            }
            button.innerHTML = sfSymbol(symbol, 18);
            button.title = surface.title;
            button.setAttribute("aria-label", surface.title);
            button.setAttribute("aria-pressed", String(selected));
            button.addEventListener("click", () => this.present(surface));
            if (surface === UtilitySurface.downloads && unseen > 0) button.append(this.badge(unseen, downloads));
            return button;
        });
        this.fanLayer.replaceChildren(...buttons);
        this.placeFan();
        // The fan reveals once as the list opens, not each time it draws again.
        if (!this.fanLayer.classList.contains("settled")) setTimeout(() => this.fanLayer.classList.add("settled"), 600);
    }

    /** Each destination sits beside the trigger, centred on the window's height, one step apart. */
    private placeFan(): void {
        if (this.fanLayer.hidden) return;
        const trigger = this.trigger.getBoundingClientRect();
        const x = trigger.right + fan.buttonSize / 2 + fan.destinationGap + fan.additionalEdgeOffset;
        const count = this.fanLayer.children.length;
        [...this.fanLayer.children].forEach((child, index) => {
            const node = child as HTMLElement;
            const y = window.innerHeight / 2 + (index - (count - 1) / 2) * fan.step;
            node.style.left = `${x - fan.buttonSize / 2}px`;
            node.style.top = `${y - fan.buttonSize / 2}px`;
        });
    }
}
