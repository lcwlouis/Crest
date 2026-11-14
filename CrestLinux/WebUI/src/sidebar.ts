// The sidebar's Space page, drawn straight from the core's outline as the
// Mac's BrowserSidebarLoadedContent draws it: the pinned grid, the Space
// header, the saved run, the seam with Clear, the new-tab row and the current
// run, and the Space switcher below. The core owns every order and rule; the
// page only draws the lists the core publishes (SpaceState.sidebar) and sends
// the person's actions back as intents.

import type { BrandColor, FolderState, Guid, Intent, SidebarRow, TabPlacement, TabState } from "../generated/crest_contracts.js";
import { SpaceAccent } from "../generated/crest_contracts.js";
import type { TabIcons } from "./icons.js";
import { listKey } from "./model.js";
import type { Model, Space, Workspace } from "./model.js";

/** What the sidebar asks of the window it sits in. */
export interface SidebarHost {
    readonly model: Model;
    readonly icons: TabIcons;
    readonly windowId: () => Guid;
    readonly shownTabId: () => Guid | null;
    readonly send: (intent: Intent) => void;
    /** Opens a new tab, as the Mac's new-tab row opens the command bar. */
    readonly openNewTab: () => void;
}

export function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

const glyph = {
    close: '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    split: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
};

export function symbol(paths: string, size = 16): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function css(color: BrandColor, alpha = color.alpha): string {
    const channel = (value: number): number => Math.round(value * 255);
    return `rgb(${channel(color.red)} ${channel(color.green)} ${channel(color.blue)} / ${alpha})`;
}

/** A Space's mark: its emoji when it has one, else its name's first letter. */
function spaceMark(name: string, mark: string): string {
    return /\p{Extended_Pictographic}/u.test(mark) ? mark : (name.trim().slice(0, 1) || "?").toUpperCase();
}

/**
 * The pinned grid's columns, as the Mac's PinnedTabGridLayout counts them:
 * as many as fit up to four, then balanced so 5 pins make 3 and 2.
 */
function pinnedColumns(count: number, width: number): number {
    const style = getComputedStyle(document.documentElement);
    const minimum = parseFloat(style.getPropertyValue("--pin-tile-min-width")) || 36;
    const spacing = parseFloat(style.getPropertyValue("--pin-spacing")) || 8;
    const requested = parseInt(style.getPropertyValue("--pin-max-columns"), 10) || 4;
    const capacity = Math.max(1, Math.min(requested, Math.floor((width + spacing) / (minimum + spacing))));
    const rows = Math.ceil(count / capacity);
    return Math.ceil(count / rows);
}

export class Sidebar {
    private readonly host: SidebarHost;
    private readonly page = element("div", "space-page");
    private readonly switcher = element("div", "switcher");

    constructor(host: SidebarHost, root: HTMLElement) {
        this.host = host;
        root.append(this.page, this.switcher);
        new ResizeObserver(() => this.render()).observe(root);
    }

    render(): void {
        const { model } = this.host;
        const workspace = model.workspace;
        const window = model.windows.get(this.host.windowId());
        const space = window ? workspace?.spaces.get(window.shownSpaceId) : undefined;
        if (!workspace || !space) return;
        const scroll = this.page.querySelector(".tabs")?.scrollTop ?? 0;
        const tint = css(SpaceAccent.facts[space.state.settings.accent].swatch);
        document.documentElement.style.setProperty("--space-tint", tint);

        const pinned = this.pinnedGrid(space);
        const header = this.spaceHeader(workspace, space);
        const tabs = element("div", "tabs");
        const expanded = space.state.settings.isSavedTabsExpanded;
        if (expanded) this.appendList(tabs, space, "Saved", null);
        tabs.append(this.seam(workspace, space));
        tabs.append(this.newTabRow());
        this.appendList(tabs, space, "Current", null);
        this.page.replaceChildren(...(pinned ? [pinned] : []), header, tabs);
        tabs.scrollTop = scroll;

        this.drawSwitcher(workspace, space);
    }

    private pinnedGrid(space: Space): HTMLElement | null {
        const list = space.lists.get(listKey("Pinned", null));
        const tabs = (list?.rows ?? [])
            .filter((row) => row.kind === "Tab")
            .map((row) => this.tab(space, row.id))
            .filter((tab): tab is TabState => tab !== undefined);
        if (tabs.length === 0) return null;
        const grid = element("div", "pinned");
        const width = this.page.clientWidth - 2 * 8;
        grid.style.gridTemplateColumns = `repeat(${pinnedColumns(tabs.length, width)}, minmax(0, 1fr))`;
        const selected = this.host.shownTabId();
        for (const tab of tabs) {
            const tile = element("button", tab.id === selected ? "pin selected" : "pin");
            tile.append(this.favicon(tab));
            tile.title = tab.displayTitle || tab.url || "";
            tile.setAttribute("aria-label", tile.title);
            if (!this.host.model.pageFor(tab.id) && tab.id !== selected) tile.classList.add("unloaded");
            tile.addEventListener("click", () => this.show(space, tab.id));
            grid.append(tile);
        }
        return grid;
    }

    private spaceHeader(workspace: Workspace, space: Space): HTMLElement {
        const settings = space.state.settings;
        const header = element("button", "space-header");
        header.setAttribute("aria-expanded", String(settings.isSavedTabsExpanded));
        header.title = settings.isSavedTabsExpanded ? "Hide saved tabs" : "Show saved tabs";
        const mark = element("span", "space-mark", spaceMark(settings.name, settings.symbol));
        const name = element("span", "space-title", settings.name);
        const disclosure = element("span", "disclosure");
        disclosure.innerHTML = symbol(glyph.chevron, 9);
        header.append(mark, name, disclosure);
        header.addEventListener("click", () =>
            this.host.send({
                kind: "ExpandSavedTabs",
                value: { workspaceId: workspace.id, spaceId: space.state.id, isExpanded: !settings.isSavedTabsExpanded },
            }),
        );
        return header;
    }

    /** The seam between the saved run and the current one, with Clear on hover. */
    private seam(workspace: Workspace, space: Space): HTMLElement {
        const seam = element("div", "seam");
        seam.append(element("div", "seam-line"));
        if (this.holdsCurrentTabs(space)) {
            const clear = element("button", "clear");
            clear.innerHTML = `<span>Clear</span>${symbol(glyph.archive, 12)}`;
            clear.title = "Clear current tabs";
            clear.addEventListener("click", () =>
                this.host.send({
                    kind: "ClearCurrentTabs",
                    value: { workspaceId: workspace.id, windowId: this.host.windowId(), spaceId: space.state.id },
                }),
            );
            seam.append(clear);
        }
        return seam;
    }

    private holdsCurrentTabs(space: Space): boolean {
        const rows = space.lists.get(listKey("Current", null))?.rows ?? [];
        return rows.some(
            (row) =>
                row.kind !== "Folder" ||
                (space.lists.get(listKey("Current", row.id))?.rows.length ?? 0) > 0,
        );
    }

    private newTabRow(): HTMLElement {
        const row = element("button", "row new-tab");
        const icon = element("span", "favicon");
        icon.innerHTML = symbol(glyph.plus, 14);
        row.append(icon, element("span", "title", "New Tab"));
        row.addEventListener("click", () => this.host.openNewTab());
        return row;
    }

    private appendList(into: HTMLElement, space: Space, section: TabPlacement, folderId: Guid | null): void {
        const list = space.lists.get(listKey(section, folderId));
        for (const row of list?.rows ?? []) {
            switch (row.kind) {
                case "Tab": {
                    const tab = this.tab(space, row.id);
                    if (tab) into.append(this.tabRow(space, tab, row.depth));
                    break;
                }
                case "Folder": {
                    const folder = space.folders.get(row.id);
                    if (folder) this.appendFolder(into, space, section, folder, row);
                    break;
                }
                case "Split":
                    into.append(this.splitRow(space, row));
                    break;
            }
        }
    }

    private appendFolder(into: HTMLElement, space: Space, section: TabPlacement, folder: FolderState, row: SidebarRow): void {
        const group = element("div", "folder");
        group.style.setProperty("--depth", String(row.depth));
        const header = element("button", "row folder-header");
        header.setAttribute("aria-expanded", String(!folder.isCollapsed));
        header.style.setProperty("--depth", String(row.depth));
        const icon = element("span", "favicon folder-icon");
        icon.innerHTML = symbol(glyph.folder, 16);
        icon.style.color = css(folder.displayColor);
        header.append(icon, element("span", "title", folder.title));
        header.addEventListener("click", () =>
            this.host.send({
                kind: "CollapseFolder",
                value: {
                    workspaceId: this.host.model.workspace!.id,
                    spaceId: space.state.id,
                    folderId: folder.id,
                    collapsed: !folder.isCollapsed,
                },
            }),
        );
        group.append(header);
        if (!folder.isCollapsed) {
            this.appendList(group, space, section, folder.id);
        } else {
            // A collapsed folder keeps showing the tab the window shows, as
            // the Mac's folder group does.
            const shown = this.host.shownTabId();
            const tab = shown ? this.tab(space, shown) : undefined;
            if (tab && this.isInside(space, tab, folder.id)) group.append(this.tabRow(space, tab, row.depth + 1));
        }
        into.append(group);
    }

    private isInside(space: Space, tab: TabState, folderId: Guid): boolean {
        for (let id = tab.folderId; id; id = space.folders.get(id)?.parentId ?? null) {
            if (id === folderId) return true;
        }
        return false;
    }

    private splitRow(space: Space, row: SidebarRow): HTMLElement {
        const group = space.splitGroups.get(row.id);
        const members = row.members.map((id) => this.tab(space, id)).filter((tab): tab is TabState => !!tab);
        const selected = this.host.shownTabId();
        const element_ = element("div", "row split");
        element_.style.setProperty("--depth", String(row.depth));
        if (members.some((tab) => tab.id === selected)) element_.classList.add("selected");
        for (const tab of members) {
            const card = element("button", tab.id === selected ? "split-card selected" : "split-card");
            card.append(this.favicon(tab), element("span", "title", tab.displayTitle || tab.url || "New Tab"));
            card.title = group?.displayTitle ?? tab.displayTitle;
            card.addEventListener("click", () => this.show(space, tab.id));
            element_.append(card);
        }
        return element_;
    }

    private tabRow(space: Space, tab: TabState, depth: number): HTMLElement {
        const selected = tab.id === this.host.shownTabId();
        const row = element("div", selected ? "row tab selected" : "row tab");
        row.style.setProperty("--depth", String(depth));
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        if (!this.host.model.pageFor(tab.id) && !selected) row.classList.add("unloaded");
        row.append(this.favicon(tab), element("span", "title", tab.displayTitle || tab.url || "New Tab"));
        row.title = tab.url ?? tab.displayTitle;
        const close = element("button", "close");
        close.innerHTML = symbol(glyph.close, 12);
        close.title = "Close Tab";
        close.setAttribute("aria-label", "Close Tab");
        close.addEventListener("click", (event) => {
            event.stopPropagation();
            this.host.send({
                kind: "CloseTab",
                value: {
                    workspaceId: this.host.model.workspace!.id,
                    windowId: this.host.windowId(),
                    spaceId: space.state.id,
                    tabId: tab.id,
                },
            });
        });
        row.append(close);
        row.addEventListener("click", () => this.show(space, tab.id));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") this.show(space, tab.id);
        });
        // A middle click closes the tab, as on the Mac.
        row.addEventListener("auxclick", (event) => {
            if (event.button === 1) close.click();
        });
        return row;
    }

    private favicon(tab: TabState): HTMLElement {
        const icon = element("span", "favicon");
        const image = this.host.icons.imageOf(tab.id);
        if (image) {
            const img = element("img", "");
            img.src = image;
            img.alt = "";
            icon.append(img);
        } else if (/\p{Extended_Pictographic}/u.test(tab.symbol)) {
            icon.textContent = tab.symbol;
        } else {
            icon.classList.add("letter");
            icon.textContent = (tab.displayTitle || "?").slice(0, 1).toUpperCase();
        }
        return icon;
    }

    private drawSwitcher(workspace: Workspace, space: Space): void {
        const track = element("div", "switcher-track");
        for (const id of workspace.order) {
            const other = workspace.spaces.get(id);
            if (!other) continue;
            const shown = id === space.state.id;
            const segment = element("button", shown ? "segment shown" : "segment");
            segment.textContent = spaceMark(other.state.settings.name, other.state.settings.symbol);
            segment.title = other.state.settings.name;
            segment.setAttribute("aria-pressed", String(shown));
            segment.addEventListener("click", () =>
                this.host.send({ kind: "ShowSpace", value: { windowId: this.host.windowId(), spaceId: id } }),
            );
            track.append(segment);
        }
        this.switcher.replaceChildren(track);
    }

    private tab(space: Space, id: Guid): TabState | undefined {
        return space.tabs.find((tab) => tab.id === id);
    }

    private show(space: Space, tabId: Guid): void {
        this.host.send({ kind: "ShowTab", value: { windowId: this.host.windowId(), spaceId: space.state.id, tabId } });
    }
}
