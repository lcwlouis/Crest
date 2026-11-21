// Draws the card of the tab or folder the window's sidebar is rested on,
// beside its row or tile and over the page, as the Mac's
// BrowserTabPreviewLayer and BrowserMacTabPreviewLayer do, and beside a
// folder's card, the card of a tab that card lists.
//
// A tab's card shows its title, its site and the last picture Crest took of
// its page (BrowserTabPreviewCard). A folder's card shows a search over the
// folder's tabs, however deep, as the sidebar's own rows (BrowserFolderPreviewCard):
// the search takes typing once the card has grown, unless the person was
// typing elsewhere a moment before, and otherwise once the pointer moves into
// the card; typing narrows the rows by title or site, Return opens the first,
// opening a tab closes the card, and while the search holds text the card
// stays when the pointer leaves it.
//
// A key, a click or a scroll in the window takes the card down, or the card on
// its way, as does the window losing focus or showing another Space. Escape
// goes no further than a card that shows; a click or a scroll inside the card
// is the card's own; a folder's card stays up for keys, which go into its
// search; and the arrow keys leave the card up. Each kind of card shows only
// while its preview is on in Appearance (BrowserDeviceAppearanceStore's
// previewsTabsOnHover and previewsFoldersOnHover).
//
// A card floats over the page, so the window raises the WebUI over the page's
// view while one shows.
//
// TODO(linux): the Mac also rests a preview on a row the arrow keys focus in
// a multiple selection, and keeps the card up through a drag begun in it;
// Linux's sidebar has neither yet.

import type { Guid, TabState } from "../generated/crest_contracts.js";
import { DeviceAppearance } from "./device-appearance.js";
import type { TabIcons } from "./icons.js";
import { Menu } from "./menu.js";
import { listKey } from "./model.js";
import type { Model, Space } from "./model.js";
import { holdOverlay, onOverlayHoldersChange } from "./overlay.js";
import { sfSymbol } from "./symbols.js";
import type { TabPictures } from "./tab-pictures.js";
import { previewKey, TabPreviewState } from "./tab-preview.js";
import type { Point, PreviewSubject, PreviewTarget } from "./tab-preview.js";

// MARK: - Types

/** What the layer reads of the window. */
export interface TabPreviewContext {
    readonly model: Model;
    readonly icons: TabIcons;
    readonly pictures: TabPictures;
    /** The Space the window shows. */
    readonly space: () => Space | undefined;
    /** The tab the window shows. */
    readonly shownTabId: () => Guid | null;
    /** The sidebar, whose rows and tiles report where the pointer rests. */
    readonly sidebar: HTMLElement;
    /** One of the sidebar's own tab rows, which a folder's card lists. */
    readonly tabRow: (space: Space, tab: TabState) => HTMLElement;
}

/** The card's width (BrowserTabPreviewSurface.width). */
const cardWidth = 280;
/** The space between the sidebar, or the card it leans on, and the card. */
const gap = 8;
/** The closest a card comes to the window's edge. */
const margin = 8;
/** How far above the row's top the card's top sits, so its title lines up with the row's. */
const rise = 6;
/** How long a card takes to grow out of its row. */
const openingTime = 300;

/** Whether the person keeps `subject`'s kind of preview on, in Appearance. */
function isTurnedOn(subject: PreviewSubject): boolean {
    return subject.kind === "tab" ? DeviceAppearance.tabHoverPreview.value : DeviceAppearance.folderHoverPreview.value;
}

function reducesMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** A page's site as a card names it: its host, without "www.". */
function siteOf(url: string | null): string | null {
    if (!url) return null;
    try {
        const host = new URL(url).host;
        return host ? host.replace(/^www\./, "") : null;
    } catch {
        return null;
    }
}

/**
 * Tells a preview where the pointer rests among the rows and tiles inside
 * `root`, as the Mac's BrowserTabPreviewSource: each carries the tab or folder
 * it draws as data-preview-tab or data-preview-folder. A root that draws
 * again under a still pointer reports the row now under it.
 */
class PreviewSource {
    private readonly root: HTMLElement;
    private readonly preview: () => TabPreviewState;
    private readonly spaceId: () => Guid | null;
    private entered: string | null = null;
    private last: Point | null = null;

    constructor(root: HTMLElement, preview: () => TabPreviewState, spaceId: () => Guid | null) {
        this.root = root;
        this.preview = preview;
        this.spaceId = spaceId;
        root.addEventListener("pointermove", (event) => this.track(event));
        root.addEventListener("pointerover", (event) => this.track(event));
        root.addEventListener("pointerleave", () => {
            this.last = null;
            this.leave();
        });
        new MutationObserver(() => this.check()).observe(root, { childList: true, subtree: true });
        root.addEventListener("scroll", () => this.check(), { capture: true, passive: true });
    }

    private track(event: PointerEvent): void {
        if (event.pointerType === "touch") return;
        this.last = { x: event.clientX, y: event.clientY };
        this.check();
    }

    /** Reports the row under the pointer now, or that it left the one it was on. */
    check(): void {
        const target = this.last ? this.targetAt(this.last) : null;
        const preview = this.preview();
        if (!target) {
            this.leave();
            return;
        }
        const key = previewKey(target);
        if (this.entered === key) {
            preview.move(target);
            return;
        }
        this.leave();
        this.entered = key;
        preview.enter(target);
    }

    private leave(): void {
        if (!this.entered) return;
        const key = this.entered;
        this.entered = null;
        this.preview().leave(key);
    }

    private targetAt(point: Point): PreviewTarget | null {
        const spaceId = this.spaceId();
        const under = document.elementFromPoint(point.x, point.y);
        if (!spaceId || !under || !this.root.contains(under)) return null;
        const node = under.closest<HTMLElement>("[data-preview-tab], [data-preview-folder]");
        if (!node || !this.root.contains(node)) return null;
        const subject: PreviewSubject = node.dataset.previewTab
            ? { kind: "tab", id: node.dataset.previewTab }
            : { kind: "folder", id: node.dataset.previewFolder! };
        if (!isTurnedOn(subject)) return null;
        return { subject, spaceId, frame: node.getBoundingClientRect() };
    }
}

/** One preview's card: where it is drawn, and the target it was drawn for. */
interface Slot {
    readonly preview: TabPreviewState;
    node: HTMLElement | null;
    key: string | null;
    /** A folder card's search, kept while its card shows so typing is never lost. */
    search: HTMLInputElement | null;
    list: HTMLElement | null;
}

export class TabPreviewLayer {
    private readonly context: TabPreviewContext;
    readonly preview: TabPreviewState;
    private readonly outer: Slot;
    private readonly inner: Slot;
    private releaseOverlay: (() => void) | null = null;
    private pointer: Point | null = null;
    /** What held the keyboard as the card showed, which takes it back once the card goes. */
    private previousFocus: Element | null = null;
    private shownSpaceId: Guid | null = null;
    private shownTabId: Guid | null = null;
    private menuHeld = false;

    constructor(context: TabPreviewContext) {
        this.context = context;
        this.preview = new TabPreviewState(() => this.render());
        const location = (): Point | null => this.pointer;
        this.preview.pointerLocation = location;
        this.preview.inner!.pointerLocation = location;
        this.outer = { preview: this.preview, node: null, key: null, search: null, list: null };
        this.inner = { preview: this.preview.inner!, node: null, key: null, search: null, list: null };
        new PreviewSource(context.sidebar, () => this.preview, () => context.space()?.state.id ?? null);
        this.listen();
    }

    // MARK: - Actions - Following

    /** Follows the core: a card whose tab or folder went, or whose Space no longer shows, goes. */
    follow(): void {
        const space = this.context.space();
        const spaceId = space?.state.id ?? null;
        const shownTabId = this.context.shownTabId();
        if (spaceId !== this.shownSpaceId) {
            this.shownSpaceId = spaceId;
            this.preview.dismiss();
        }
        // Opening a tab from a folder's card closes the card, the shown one included.
        if (shownTabId !== this.shownTabId) {
            this.shownTabId = shownTabId;
            if (this.preview.shown?.subject.kind === "folder") this.preview.dismiss();
        }
        const shown = this.preview.shown;
        if (shown && !this.exists(shown.subject, space)) this.preview.dismiss();
        else this.render();
    }

    private exists(subject: PreviewSubject, space: Space | undefined): boolean {
        if (!space) return false;
        return subject.kind === "tab" ? space.tabs.some((tab) => tab.id === subject.id) : space.folders.has(subject.id);
    }

    // MARK: - Actions - Events

    private listen(): void {
        document.addEventListener("pointermove", (event) => (this.pointer = { x: event.clientX, y: event.clientY }), true);
        document.addEventListener("keydown", (event) => this.keyDown(event), true);
        document.addEventListener("mousedown", (event) => this.pointerDown(event), true);
        document.addEventListener("wheel", (event) => this.pointerDown(event), { capture: true, passive: true });
        window.addEventListener("blur", () => this.preview.dismiss());
        window.addEventListener("resize", () => this.preview.dismiss());
        // A row's menu opened from the card keeps the card up until it closes.
        // A menu takes the overlay as it opens, before it counts as open, so this asks once it has.
        onOverlayHoldersChange(() => queueMicrotask(() => this.followMenu()));
    }

    private followMenu(): void {
        const open = Menu.isOpen;
        if (open && !this.menuHeld && (this.preview.isPointerInCard || this.preview.inner!.isPointerInCard)) {
            this.menuHeld = true;
            this.preview.interactionChanged(true);
        } else if (!open && this.menuHeld) {
            this.menuHeld = false;
            this.preview.interactionChanged(false);
        }
    }

    /**
     * Escape goes no further than a card that shows. The arrow keys leave the
     * card up, and a folder's card stays up for keys, which go into its
     * search. Anything else takes the card down and goes on.
     */
    private keyDown(event: KeyboardEvent): void {
        this.preview.keyPressed();
        if (!this.preview.isEngaged || this.menuHeld) return;
        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
            const showsCard = this.preview.shown !== null;
            this.preview.dismiss();
            if (showsCard) {
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }
        if (event.key.startsWith("Arrow") || this.preview.shown?.subject.kind === "folder") return;
        this.preview.dismiss();
    }

    /** A click or a scroll outside the cards takes them down. */
    private pointerDown(event: MouseEvent): void {
        if (!this.preview.isEngaged || this.menuHeld) return;
        const inside = this.preview.shownCardFrames.some(
            (frame) => event.clientX >= frame.left && event.clientX <= frame.right && event.clientY >= frame.top && event.clientY <= frame.bottom,
        );
        if (!inside) this.preview.dismiss();
    }

    // MARK: - Actions - Drawing

    private render(): void {
        const space = this.context.space();
        const outer = this.preview.shown;
        const wasShowing = this.outer.node !== null;
        this.draw(this.outer, outer, space, null);
        const inner = outer?.subject.kind === "folder" ? this.preview.inner!.shown : null;
        this.draw(this.inner, inner, space, this.outer.node ? this.preview.cardFrame : null);
        const showing = this.outer.node !== null;
        if (showing && !wasShowing) {
            this.releaseOverlay = holdOverlay();
            this.previousFocus = document.activeElement;
        } else if (!showing && wasShowing) {
            this.releaseOverlay?.();
            this.releaseOverlay = null;
            // Gives the keyboard back to whatever held it, once the card's search let it go.
            const previous = this.previousFocus as HTMLElement | null;
            this.previousFocus = null;
            if ((document.activeElement === document.body || document.activeElement === null) && previous?.isConnected) previous.focus();
        }
    }

    /** Draws `slot`'s card for `target`, beside `leanOn` (a card it leans on) or the sidebar, or takes it down. */
    private draw(slot: Slot, target: PreviewTarget | null, space: Space | undefined, leanOn: DOMRect | null): void {
        if (!target || !space) {
            this.takeDown(slot);
            return;
        }
        const key = previewKey(target);
        const fresh = slot.node === null;
        if (slot.key !== key || !slot.node) {
            const node = slot.node ?? this.cardNode(slot);
            node.replaceChildren();
            slot.search = null;
            slot.list = null;
            slot.key = key;
            node.dataset.kind = target.subject.kind;
            // A tab's card repeats what its row already tells a screen reader; a folder's holds its search.
            if (target.subject.kind === "tab") node.setAttribute("aria-hidden", "true");
            else node.removeAttribute("aria-hidden");
            if (target.subject.kind === "folder") this.folderCard(slot, node, target.subject.id, space);
        }
        const node = slot.node!;
        if (target.subject.kind === "tab") {
            const tab = space.tabs.find((held) => held.id === target.subject.id);
            if (tab) node.replaceChildren(...this.tabCard(tab));
        } else {
            this.folderRows(slot, target.subject.id, space);
        }
        const placement = this.place(node, target.frame, leanOn);
        slot.preview.cardFrame = node.getBoundingClientRect();
        if (fresh) this.grow(node, placement.anchor);
        if (fresh && target.subject.kind === "folder") this.focusSearchSoon(slot);
    }

    private cardNode(slot: Slot): HTMLElement {
        const node = element("div", "tab-preview-card");
        node.addEventListener("pointerenter", () => {
            slot.preview.pointerInCardChanged(true);
            // A folder card's search takes the keyboard once the pointer moves into the card.
            if (slot.search && !this.preview.isTyping) slot.search.focus();
        });
        node.addEventListener("pointerleave", () => slot.preview.pointerInCardChanged(false));
        document.body.append(node);
        slot.node = node;
        return node;
    }

    private takeDown(slot: Slot): void {
        const node = slot.node;
        slot.node = null;
        slot.key = null;
        slot.search = null;
        slot.list = null;
        slot.preview.cardFrame = null;
        if (!node) return;
        node.style.pointerEvents = "none";
        const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in-out", fill: "forwards" });
        fade.onfinish = () => node.remove();
    }

    /** The card grows out of its row as it fades in, or only fades in with Reduce Motion. */
    private grow(node: HTMLElement, anchor: Point): void {
        node.style.transformOrigin = `${anchor.x}px ${anchor.y}px`;
        const frames = reducesMotion()
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                  { opacity: 0, transform: "scale(0.2)" },
                  { opacity: 1, transform: "scale(1)" },
              ];
        node.animate(frames, { duration: reducesMotion() ? 140 : openingTime, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.05)" });
    }

    /**
     * Places the card beside `row`, against the sidebar's page edge or the
     * card it leans on, at the row's height, inside the window. Answers the
     * point at the card's edge beside the row that it grows from.
     */
    private place(node: HTMLElement, row: DOMRect, leanOn: DOMRect | null): { anchor: Point } {
        const bounds = { width: window.innerWidth, height: window.innerHeight };
        const sidebar = this.context.sidebar.getBoundingClientRect();
        const opensTrailing = row.left + row.width / 2 < bounds.width / 2;
        const lean = leanOn ? (opensTrailing ? leanOn.right : leanOn.left) : opensTrailing ? sidebar.right : sidebar.left;
        const width = node.offsetWidth || cardWidth;
        const height = node.offsetHeight;
        const x = opensTrailing ? lean + gap : lean - gap - width;
        const y = row.top - rise;
        const left = Math.min(Math.max(x, margin), Math.max(bounds.width - width - margin, margin));
        const top = Math.min(Math.max(y, margin), Math.max(bounds.height - height - margin, margin));
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
        const middle = Math.min(Math.max(row.top + row.height / 2 - top, 0), height);
        return { anchor: { x: opensTrailing ? 0 : width, y: middle } };
    }

    // MARK: - Actions - Tab card

    /** BrowserTabPreviewCard: the tab's icon, title and site, over the last picture Crest took of its page. */
    private tabCard(tab: TabState): HTMLElement[] {
        const header = element("div", "tab-preview-header");
        header.append(this.favicon(tab));
        const text = element("div", "tab-preview-text");
        text.append(element("div", "tab-preview-title", tab.displayTitle || tab.url || "New Tab"));
        const site = siteOf(tab.url);
        if (site) text.append(element("div", "tab-preview-site", site));
        header.append(text);
        const picture = this.context.pictures.picture(tab.id);
        if (!picture) return [header];
        const image = element("img", "tab-preview-picture");
        image.src = picture.src;
        image.alt = "";
        const width = cardWidth - 2 * 8;
        image.style.height = `${Math.min(width * picture.aspectRatio, 168)}px`;
        return [header, image];
    }

    private favicon(tab: TabState): HTMLElement {
        const icon = element("span", "favicon tab-preview-favicon");
        const image = this.context.icons.imageOf(tab.id);
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

    // MARK: - Actions - Folder card

    /** BrowserFolderPreviewCard's search over the folder's rows. */
    private folderCard(slot: Slot, node: HTMLElement, folderId: Guid, space: Space): void {
        const field = element("label", "folder-preview-search");
        const glass = element("span", "folder-preview-glass");
        glass.innerHTML = sfSymbol("magnifyingglass", 14);
        const search = element("input", "folder-preview-input");
        search.type = "search";
        search.placeholder = "Search Tabs";
        search.setAttribute("aria-label", "Search Tabs");
        const clear = element("button", "folder-preview-clear");
        clear.type = "button";
        clear.innerHTML = sfSymbol("xmark.circle", 14);
        clear.title = "Clear Search";
        clear.setAttribute("aria-label", "Clear Search");
        clear.hidden = true;
        clear.addEventListener("click", () => {
            search.value = "";
            search.dispatchEvent(new Event("input"));
            search.focus();
        });
        search.addEventListener("input", () => {
            clear.hidden = search.value.length === 0;
            slot.preview.isHeld = search.value.length > 0;
            this.folderRows(slot, folderId, space);
        });
        search.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const first = this.matches(search.value, this.folderTabs(this.context.space() ?? space, folderId))[0];
            if (first) this.open(first.id);
        });
        field.append(glass, search, clear);
        const list = element("div", "folder-preview-list");
        new PreviewSource(list, () => this.preview.inner!, () => this.context.space()?.state.id ?? null);
        // Opening a tab from the card closes it; closing one leaves it up.
        list.addEventListener("click", (event) => {
            const row = (event.target as Element).closest(".row");
            if (row && !(event.target as Element).closest(".close")) this.preview.dismiss();
        });
        node.append(field, list);
        slot.search = search;
        slot.list = list;
    }

    /** The rows of the folder's tabs the search matches, drawn again as the core changes them. */
    private folderRows(slot: Slot, folderId: Guid, space: Space): void {
        const list = slot.list;
        if (!list) return;
        const query = slot.search?.value ?? "";
        const matches = this.matches(query, this.folderTabs(space, folderId));
        const scroll = list.scrollTop;
        if (matches.length === 0) {
            list.replaceChildren(element("div", "folder-preview-empty", query.trim() ? "No Results" : "No Tabs"));
        } else {
            list.replaceChildren(...matches.map((tab) => this.context.tabRow(space, tab)));
        }
        list.scrollTop = scroll;
    }

    /** Every tab the folder holds, however deep, in the sidebar's order. */
    private folderTabs(space: Space, folderId: Guid): TabState[] {
        const tabs: TabState[] = [];
        const walk = (id: Guid): void => {
            for (const row of space.lists.get(listKey("Current", id))?.rows ?? []) {
                const ids = row.kind === "Tab" ? [row.id] : row.kind === "Split" ? row.members : [];
                for (const tabId of ids) {
                    const tab = space.tabs.find((held) => held.id === tabId);
                    if (tab) tabs.push(tab);
                }
                if (row.kind === "Folder") walk(row.id);
            }
        };
        walk(folderId);
        return tabs;
    }

    /** The tabs whose title or site holds `query`, or every tab while it is blank. */
    private matches(query: string, tabs: readonly TabState[]): TabState[] {
        const needle = query.trim().toLocaleLowerCase();
        if (!needle) return [...tabs];
        return tabs.filter(
            (tab) =>
                (tab.displayTitle || tab.url || "").toLocaleLowerCase().includes(needle) ||
                (siteOf(tab.url)?.toLocaleLowerCase().includes(needle) ?? false),
        );
    }

    /** Opens `tabId` in the shown Space, which closes the card. */
    private open(tabId: Guid): void {
        const node = this.outer.list?.querySelector<HTMLElement>(`[data-preview-tab="${CSS.escape(tabId)}"]`);
        node?.click();
        this.preview.dismiss();
    }

    /** A search that takes the keyboard while the card still grows waits the opening out, unless the person was typing. */
    private focusSearchSoon(slot: Slot): void {
        window.setTimeout(() => {
            if (slot.search?.isConnected && !this.preview.isTyping) slot.search.focus();
        }, reducesMotion() ? 0 : openingTime);
    }
}
