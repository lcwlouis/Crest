// The window's page cards, as the Mac's BrowserSplitColumnsView lays them
// out: the tab the window shows in its card, or the cards of the split it
// shows side by side in one row, inset as one page is, with the dividers in
// the gaps between them and a ring in the Space's accent around the card in
// use. The core says which cards show (WindowState.cards) and their shares
// (splitColumnShares); this draws them, asks the core for each card's page,
// and tells the window where each page goes. Focus is selection: the card
// the person clicks into becomes the tab the window shows.

import { listenToPageFocus, setPageLayout } from "./bridge.js";
import type { PagePlacement } from "./bridge.js";
import type { Guid, Intent, PageState, ShownCards, TabState } from "../generated/crest_contracts.js";
import type { Model, Space, Workspace } from "./model.js";
import { holdOverlay } from "./overlay.js";
import { columnWidths, equalFractions, fractionsAfterResize, resizeHandleWidth, seedFractions, splitGap } from "./split-columns.js";

/** BrowserChromeLayout.pageCornerRadius. */
export const pageCornerRadius = 13;

/**
 * The card the shown tab is drawn in, which the surfaces floating over its
 * page (the find bar, a prompt, the page's bars) sit on: its split card, or
 * the window's page card.
 */
export function shownCard(): HTMLElement {
    return document.querySelector<HTMLElement>("#page .page-card.focused") ?? document.getElementById("page")!;
}

/** What the cards read of the window. */
export interface PageCardsContext {
    readonly model: Model;
    readonly windowId: () => Guid;
    readonly workspace: () => Workspace | undefined;
    readonly space: () => Space | undefined;
    readonly shownTabId: () => Guid | null;
    readonly send: (intent: Intent) => Promise<boolean>;
    readonly report: (error: unknown) => void;
    /** The page a Peek shows over the cards, placed, and whether it is the page in use. */
    readonly peek: () => { readonly placement: PagePlacement; readonly inUse: boolean } | null;
    /** Whether the window shows the page `pageId`: another window may show it while this one is in the background. */
    readonly shows: (pageId: Guid) => boolean;
}

/** A divider drag in flight: the shares it started from and those the pointer reached. */
interface Resize {
    readonly groupId: Guid;
    readonly start: readonly number[];
    shares: number[];
}

export class PageCards {
    private readonly context: PageCardsContext;
    private readonly page = document.getElementById("page")!;
    private readonly row = document.createElement("div");
    /** Each card's element, by tab, while the window shows a split. */
    private readonly cards = new Map<Guid, HTMLElement>();
    private readonly dividers: HTMLElement[] = [];
    /** Tabs this window asked the core to open a page for, until the page appears. */
    private readonly opening = new Set<Guid>();
    private resize: Resize | null = null;
    /** Shares a finished drag committed, until the core's window state carries them. */
    private committed: { readonly groupId: Guid; readonly shares: readonly number[] } | null = null;
    /** What the window was last told, so a layout that changed nothing is not sent again. */
    private sent = "";
    /** Where a tab dragged over the cards would join them, while one is (sidebar-drag.ts). */
    private dropIndex: number | null = null;
    /** The room the cards make for that tab (BrowserSplitPageSurface's placeholder). */
    private readonly dropSlot = document.createElement("div");

    constructor(context: PageCardsContext) {
        this.context = context;
        this.row.className = "page-card-row";
        this.dropSlot.className = "page-card-drop";
        this.page.append(this.row);
        new ResizeObserver(() => this.layout()).observe(this.page);
        window.addEventListener("resize", () => this.layout());
        listenToPageFocus((pageId) => this.pageFocused(pageId));
    }

    /** The tabs the window shows as cards in the shown Space, in order: one, or a split's members. */
    shownCards(): Guid[] {
        const window = this.context.model.windows.get(this.context.windowId());
        const cards = this.cardsState();
        if (cards && cards.tabIds.length > 0) return [...cards.tabIds];
        const shown = window ? this.context.shownTabId() : null;
        return shown ? [shown] : [];
    }

    /** The cards on show, as a tab dragged over them aims at them: the split's in order, or the page's card. */
    frames(): DOMRect[] {
        const tabs = this.shownCards();
        if (tabs.length === 0) return [];
        if (this.cards.size === 0) return [this.page.getBoundingClientRect()];
        return tabs.map((tabId) => this.cards.get(tabId)?.getBoundingClientRect()).filter((frame): frame is DOMRect => frame !== undefined);
    }

    /**
     * Opens room among the cards for a tab dragged over them, as the card at
     * `index`, or closes it for null; the cards move aside while it is open.
     */
    previewDrop(index: number | null): void {
        if (index === this.dropIndex) return;
        this.dropIndex = index;
        this.layout();
    }

    /** Whether the window shows a split's cards side by side. */
    get isSplit(): boolean {
        return this.shownCards().length > 1;
    }

    /** The card the shown tab is drawn in: its split card, or the window's page card. */
    focusedCard(): HTMLElement {
        const shown = this.context.shownTabId();
        return (shown && this.cards.get(shown)) || this.page;
    }

    /** Follows the core: gives each card's tab a page and lays the cards out again. */
    follow(): void {
        const space = this.context.space();
        const workspace = this.context.workspace();
        if (!space || !workspace) return;
        for (const tabId of this.shownCards()) {
            const tab = space.tabs.find((held) => held.id === tabId);
            if (tab) this.openPage(workspace, space, tab);
        }
        const window = this.context.model.windows.get(this.context.windowId());
        const group = this.cardsState()?.splitGroupId;
        const stored = group ? window?.splitColumnShares.find((shares) => shares.groupId === group)?.shares : undefined;
        if (this.committed && (this.committed.groupId !== group || sameShares(stored, this.committed.shares))) this.committed = null;
        this.layout();
    }

    /** Lays the cards out where the page's card is now and tells the window where each page goes. */
    layout(): void {
        const space = this.context.space();
        const tabs = space ? this.shownCards() : [];
        const drop = tabs.length > 0 ? this.dropIndex : null;
        const split = tabs.length > 1 || drop !== null;
        document.body.classList.toggle("split-view", split);
        document.body.classList.toggle("split-drop", drop !== null);
        this.drawCards(split ? tabs : []);
        const box = this.page.getBoundingClientRect();
        const placements: PagePlacement[] = [];
        const shown = this.context.shownTabId();
        let inUse = "";
        if (split) {
            const slots = tabs.length + (drop === null ? 0 : 1);
            const widths = columnWidths(box.width, drop === null ? this.fractions(tabs.length) : equalFractions(slots));
            let x = 0;
            if (drop === null) {
                this.dropSlot.remove();
            } else {
                // The cards before the room keep their slots; those after it move one along.
                const before = widths.slice(0, drop).reduce((sum, width) => sum + width + splitGap, 0);
                this.dropSlot.style.left = `${before}px`;
                this.dropSlot.style.width = `${widths[drop] ?? 0}px`;
                if (this.dropSlot.parentElement !== this.row) this.row.append(this.dropSlot);
            }
            tabs.forEach((tabId, index) => {
                const slot = drop !== null && index >= drop ? index + 1 : index;
                if (slot !== index && index === drop) x += (widths[drop] ?? 0) + splitGap;
                const width = widths[slot] ?? 0;
                const card = this.cards.get(tabId)!;
                card.style.left = `${x}px`;
                card.style.width = `${width}px`;
                const page = this.shownPage(tabId);
                card.classList.toggle("has-page", page !== undefined);
                card.classList.toggle("focused", tabId === shown);
                if (page) {
                    const left = Math.max(box.left + x, box.left);
                    const right = Math.min(box.left + x + width, box.right);
                    placements.push({
                        pageId: page.id,
                        x: left,
                        y: box.top,
                        width: Math.max(0, right - left),
                        height: box.height,
                        above: false,
                        cornerRadius: pageCornerRadius,
                    });
                    if (tabId === shown) inUse = page.id;
                }
                const divider = this.dividers[index];
                if (divider) divider.style.left = `${x + width + splitGap / 2 - resizeHandleWidth / 2}px`;
                x += width + splitGap;
            });
        } else if (shown) {
            const page = this.shownPage(shown);
            if (page) {
                placements.push({ pageId: page.id, x: box.left, y: box.top, width: box.width, height: box.height, above: false, cornerRadius: pageCornerRadius });
                inUse = page.id;
            }
        }
        document.body.classList.toggle("has-page", !split && placements.length > 0);
        this.moveCardContents();
        const peek = this.context.peek();
        if (peek) {
            placements.push(peek.placement);
            if (peek.inUse) inUse = peek.placement.pageId;
        }
        const layout = JSON.stringify([placements, inUse]);
        if (layout === this.sent) return;
        this.sent = layout;
        setPageLayout(placements, inUse);
    }

    /** The page a card shows over itself: one the engine made live that has not failed to load. */
    private shownPage(tabId: Guid): PageState | undefined {
        const page = this.context.model.pageFor(tabId);
        return page && page.phase === "Live" && !page.live.failure && this.context.shows(page.id) ? page : undefined;
    }

    private cardsState(): ShownCards | undefined {
        const window = this.context.model.windows.get(this.context.windowId());
        return window?.cards.find((cards) => cards.spaceId === window.shownSpaceId);
    }

    /** The shares the row is drawn at: a drag's, a committed drag's, the window's stored ones, or equal. */
    private fractions(count: number): number[] {
        const group = this.cardsState()?.splitGroupId ?? null;
        if (this.resize && this.resize.groupId === group && this.resize.shares.length === count) return this.resize.shares;
        if (this.committed && this.committed.groupId === group) return seedFractions(this.committed.shares, count);
        const window = this.context.model.windows.get(this.context.windowId());
        const stored = group ? window?.splitColumnShares.find((shares) => shares.groupId === group)?.shares : undefined;
        return seedFractions(stored, count);
    }

    /** One element per card, kept while its tab stays a card, and a divider in each gap. */
    private drawCards(tabs: readonly Guid[]): void {
        for (const [tabId, card] of this.cards) {
            if (tabs.includes(tabId)) continue;
            card.remove();
            this.cards.delete(tabId);
        }
        tabs.forEach((tabId, index) => {
            let card = this.cards.get(tabId);
            if (!card) {
                card = document.createElement("div");
                card.className = "page-card";
                // A card the WebUI draws itself (a Start Page, a page still
                // opening) takes focus from a click; a page's own view tells
                // the window instead.
                card.addEventListener("mousedown", () => this.focus(tabId));
                this.cards.set(tabId, card);
            }
            if (this.row.children[index] !== card) this.row.insertBefore(card, this.row.children[index] ?? null);
        });
        while (this.dividers.length > Math.max(0, tabs.length - 1)) this.dividers.pop()!.remove();
        while (this.dividers.length < tabs.length - 1) {
            const index = this.dividers.length;
            const divider = document.createElement("div");
            divider.className = "page-card-divider";
            divider.setAttribute("role", "separator");
            divider.setAttribute("aria-orientation", "vertical");
            divider.setAttribute("aria-label", "Resize Split View Cards");
            divider.append(document.createElement("span"));
            divider.addEventListener("pointerdown", (event) => this.beginResize(index, event));
            this.dividers.push(divider);
            this.row.append(divider);
        }
    }

    /** The Start Page and the failure views sit in the card of the shown tab. */
    private moveCardContents(): void {
        const card = this.focusedCard();
        for (const content of document.querySelectorAll<HTMLElement>(".card-content")) {
            if (content.parentElement !== card) card.append(content);
        }
    }

    /**
     * Drags the divider after card `dividerIndex`, as the Mac's
     * BrowserSplitCardResizeHandle: the pair around it moves with the
     * pointer, and the shares it settles on are the window's once released.
     * The WebUI is raised while the pointer holds the divider, so it keeps
     * the pointer as it crosses the pages' own views.
     */
    private beginResize(dividerIndex: number, event: PointerEvent): void {
        const group = this.cardsState()?.splitGroupId;
        const tabs = this.shownCards();
        if (!group || event.button !== 0) return;
        event.preventDefault();
        const divider = event.currentTarget as HTMLElement;
        divider.setPointerCapture(event.pointerId);
        divider.classList.add("active");
        const release = holdOverlay();
        const start = this.fractions(tabs.length);
        this.resize = { groupId: group, start, shares: [...start] };
        const originX = event.clientX;
        const width = this.page.getBoundingClientRect().width;
        const move = (moved: PointerEvent): void => {
            if (!this.resize) return;
            this.resize.shares = fractionsAfterResize(this.resize.start, dividerIndex, moved.clientX - originX, width);
            this.layout();
        };
        const end = (): void => {
            divider.removeEventListener("pointermove", move);
            divider.removeEventListener("pointerup", end);
            divider.removeEventListener("pointercancel", end);
            divider.classList.remove("active");
            release();
            const resize = this.resize;
            this.resize = null;
            if (!resize) return;
            if (!sameShares(resize.shares, resize.start)) {
                this.committed = { groupId: resize.groupId, shares: resize.shares };
                void this.context.send({
                    kind: "ResizeSplitColumns",
                    value: { windowId: this.context.windowId(), groupId: resize.groupId, shares: resize.shares },
                });
            }
            this.layout();
        };
        divider.addEventListener("pointermove", move);
        divider.addEventListener("pointerup", end);
        divider.addEventListener("pointercancel", end);
    }

    /** The window heard the person click into a page: its card becomes the one in use. */
    private pageFocused(pageId: Guid): void {
        if (this.context.peek()) return;
        const tabId = [...this.context.model.pages.values()].find((page) => page.id.toLowerCase() === pageId)?.tabId;
        if (tabId) this.focus(tabId);
    }

    /** Makes `tabId`, one of the split's cards, the tab the window shows. */
    private focus(tabId: Guid): void {
        const space = this.context.space();
        if (!space || tabId === this.context.shownTabId() || !this.shownCards().includes(tabId)) return;
        void this.context.send({ kind: "ShowTab", value: { windowId: this.context.windowId(), spaceId: space.state.id, tabId } });
    }

    /**
     * Gives a card's tab a page once the engine has none for it, as the
     * Mac's window does for each card it shows; the core asks the engine to
     * create it, and the window shows it once it is live.
     */
    private openPage(workspace: Workspace, space: Space, tab: TabState): void {
        // TODO(linux): other native views (settings, history) are drawn with
        // the surfaces they belong to.
        if (this.context.model.pageFor(tab.id) || tab.nativeContent || this.opening.has(tab.id)) return;
        this.opening.add(tab.id);
        const pageId = crypto.randomUUID();
        const { send } = this.context;
        void send({
            kind: "OpenPage",
            value: {
                pageId,
                workspaceId: workspace.id,
                spaceId: space.state.id,
                tabId: tab.id,
                windowId: this.context.windowId(),
                transient: null,
                openerPageId: null,
            },
        })
            // A new page starts at its tab's address, which the window asks
            // the core to load, as the Mac's page pool does.
            // TODO(linux): restore the tab's archived history first, as the
            // Mac does, when the tab has one.
            .then((opened) => (opened && tab.url ? send({ kind: "LoadAddress", value: { pageId, url: tab.url } }) : undefined))
            .finally(() => this.opening.delete(tab.id));
    }
}

function sameShares(a: readonly number[] | undefined, b: readonly number[]): boolean {
    return a !== undefined && a.length === b.length && a.every((share, index) => Math.abs(share - b[index]!) < 1e-6);
}
