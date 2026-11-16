// Peek on Linux, as the Mac's BrowserPeekOverlay draws it beside a pointer:
// the core keeps a link for Peek, the engine presents PeekRequested, and the
// window opens the link in a transient page of the source page's Space and
// engine, staged with the link the engine kept so it loads with its referrer
// and initiator. The page shows on a card over the page it came from, which
// a scrim dims, with the controls above the card: Close, and Open In, which
// keeps the page as a tab of the Space it names. Escape, Ctrl+W and a click
// on the scrim close it; Ctrl+O keeps it.
//
// The window raises the WebUI while a Peek shows, to dim the page and draw
// the controls, and keeps the Peek's page over the WebUI, so the page takes
// the pointer and the keyboard. While another surface floats over the Peek
// (the Open In menu, the command bar) the page goes under the raised WebUI,
// which leaves its card clear, so it still shows.

import type { Change, Guid, Intent, PeekRequested } from "../generated/crest_contracts.js";
import type { PagePlacement } from "./bridge.js";
import { Refused, dispatch } from "./bridge.js";
import { foregroundTone, spaceIcon } from "./crest.js";
import { Menu } from "./menu.js";
import type { Model, Space, Workspace } from "./model.js";
import { holdOverlay, onOverlayHoldersChange, overlayHolders } from "./overlay.js";
import { css } from "./sidebar.js";
import { sfSymbol } from "./symbols.js";

/** BrowserTransientCardArrangement.pointer and BrowserPeekControlStyle.actionBar. */
const pointerMargin = 24;
const controlHeight = 48;
const controlSpacing = 10;
const cardCornerRadius = 15;
/** The share of its room the card takes: the Mac's Peek size, whose default is all of it. */
const cardShare = 1;

/** What the Peek reads of the window. */
export interface PeekContext {
    readonly model: Model;
    readonly windowId: () => Guid;
    readonly workspace: () => Workspace | undefined;
    /** The tabs the window shows as cards now; a Peek opens only over one of them. */
    readonly shownCards: () => readonly Guid[];
    readonly report: (error: unknown) => void;
    /** The page layout changed: where the Peek's page goes, or that it is gone. */
    readonly relayout: () => void;
    /** The keys Crest takes from pages changed: Escape is Crest's while a Peek shows. */
    readonly shortcutsChanged: () => void;
}

/** The Peek showing. */
interface Shown {
    readonly pageId: Guid;
    readonly sourcePageId: Guid;
    readonly sourceTabId: Guid;
    readonly spaceId: Guid;
    readonly url: string;
    readonly releaseOverlay: () => void;
    readonly layer: HTMLElement;
    readonly card: HTMLElement;
    readonly openIn: HTMLElement;
}

export class Peek {
    private readonly context: PeekContext;
    private shown: Shown | null = null;

    constructor(context: PeekContext) {
        this.context = context;
        // Another surface floating over the Peek takes the page under the WebUI.
        onOverlayHoldersChange(() => {
            if (this.shown) this.context.relayout();
        });
        window.addEventListener("resize", () => this.place());
        new ResizeObserver(() => this.place()).observe(document.getElementById("page")!);
    }

    get isOpen(): boolean {
        return this.shown !== null;
    }

    /**
     * The Peek's page and where it goes, once the engine made it live, and
     * whether it is the page in use: it is, unless another surface floats
     * over it.
     */
    placement(): { placement: PagePlacement; inUse: boolean } | null {
        const shown = this.shown;
        const page = shown ? this.context.model.pages.get(shown.pageId) : undefined;
        if (!shown || !page || page.phase !== "Live") return null;
        const box = shown.card.getBoundingClientRect();
        const alone = overlayHolders() <= 1;
        return {
            placement: {
                pageId: page.id,
                x: box.left,
                y: box.top,
                width: box.width,
                height: box.height,
                above: alone,
                cornerRadius: cardCornerRadius,
            },
            inUse: alone,
        };
    }

    /** The engine kept a link for Peek: opens it over the page it was followed in. */
    requested(request: PeekRequested): void {
        const { model } = this.context;
        const workspace = this.context.workspace();
        const source = model.pages.get(request.pageId);
        const discard = (): void => {
            if (request.stagedLinkId) {
                void dispatch({ kind: "DiscardStagedLink", value: { sourcePageId: request.pageId, stagedLinkId: request.stagedLinkId } }).catch(
                    this.context.report,
                );
            }
        };
        // A Peek opens over a page this window shows, as the Mac's does over a
        // page in its window.
        if (!workspace || !source?.tabId || !this.context.shownCards().includes(source.tabId)) {
            if (source?.tabId) console.info("A Peek's link came from a page this window does not show as a card.");
            discard();
            return;
        }
        this.close();
        const pageId = crypto.randomUUID();
        // Sent together, so the link is staged before the engine makes the
        // page and its first load is the link the engine kept.
        const opening = dispatch({
            kind: "OpenPage",
            value: {
                pageId,
                workspaceId: workspace.id,
                spaceId: source.spaceId,
                tabId: null,
                windowId: this.context.windowId(),
                transient: "Peek",
                openerPageId: source.id,
            },
        });
        const staging = request.stagedLinkId
            ? dispatch({ kind: "StageLink", value: { pageId, sourcePageId: source.id, stagedLinkId: request.stagedLinkId, url: request.url } })
            : null;
        const loading = dispatch({ kind: "LoadAddress", value: { pageId, url: request.url } });
        opening.catch((error: unknown) => {
            this.context.report(error);
            discard();
            if (this.shown?.pageId === pageId) this.dismiss();
        });
        // A link the engine can no longer stage loads as an address.
        staging?.catch((error: unknown) => console.warn("The Peek's link loads afresh:", error));
        loading.catch((error: unknown) => {
            if (!(error instanceof Refused)) this.context.report(error);
        });
        this.show({ pageId, sourcePageId: source.id, sourceTabId: source.tabId, spaceId: source.spaceId, url: request.url });
    }

    /** Follows the core: the Peek closes with its page, and when the page under it no longer shows. */
    apply(changes: readonly Change[]): void {
        const shown = this.shown;
        if (!shown) return;
        for (const change of changes) {
            if (change.kind === "TransientPageClosed" && change.value.pageId === shown.pageId) {
                this.dismiss();
                return;
            }
        }
        const window = this.context.model.windows.get(this.context.windowId());
        const sourceShows = this.context.model.pages.has(shown.sourcePageId) && this.context.shownCards().includes(shown.sourceTabId);
        if (!window || window.shownSpaceId !== shown.spaceId || !sourceShows || !this.context.model.pages.has(shown.pageId)) {
            this.close();
            return;
        }
        const page = this.context.model.pages.get(shown.pageId);
        shown.card.classList.toggle("has-page", page?.phase === "Live");
        this.drawOpenIn(shown);
    }

    /** Closes the Peek and lets its page go, as its Close button does. */
    close(): boolean {
        const shown = this.shown;
        if (!shown) return false;
        this.dismiss();
        void dispatch({ kind: "ReleasePage", value: { pageId: shown.pageId, keepsState: false } }).catch((error: unknown) => {
            // A page the core already let go needs nothing more.
            if (!(error instanceof Refused)) this.context.report(error);
        });
        return true;
    }

    /**
     * Keeps the Peek's page as a tab of `spaceId`, as Open In does: the core
     * opens the tab after the one the window shows there and shows it, and
     * the tab takes the live page when it can; otherwise the tab loads the
     * page's address afresh and the Peek's page goes.
     */
    async keep(spaceId: Guid = this.shown?.spaceId ?? ""): Promise<void> {
        const shown = this.shown;
        const workspace = this.context.workspace();
        if (!shown || !workspace) return;
        const page = this.context.model.pages.get(shown.pageId);
        // A page that has been nowhere worth keeping only shows its Space.
        if (!page?.live.url) {
            this.close();
            await this.send({ kind: "ShowSpace", value: { windowId: this.context.windowId(), spaceId } });
            return;
        }
        let changes: Change[];
        try {
            changes = await dispatch({
                kind: "PromoteTransientPage",
                value: { workspaceId: workspace.id, windowId: this.context.windowId(), pageId: shown.pageId, spaceId, placement: "Current" },
            });
        } catch (error) {
            this.context.report(error);
            return;
        }
        const promoted = changes.find((change) => change.kind === "TransientPagePromoted" && change.value.pageId === shown.pageId);
        if (promoted?.kind === "TransientPagePromoted" && promoted.value.adoptsPage) this.dismiss();
        else this.close();
    }

    /** Hears a key, from the WebUI or one the window took from a page; true when the Peek took it. */
    handleKey(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
        if (!this.shown || event.altKey || event.metaKey) return false;
        if (event.key === "Escape" && !event.ctrlKey) {
            this.close();
            return true;
        }
        if (event.key.toLowerCase() === "o" && event.ctrlKey && !event.shiftKey) {
            void this.keep();
            return true;
        }
        return false;
    }

    private async send(intent: Intent): Promise<void> {
        await dispatch(intent).catch(this.context.report);
    }

    private show(request: { pageId: Guid; sourcePageId: Guid; sourceTabId: Guid; spaceId: Guid; url: string }): void {
        const layer = document.createElement("div");
        layer.className = "peek-layer";
        const dims = this.context.model.linkPreferences?.dimsPageBehindPeek ?? true;
        layer.classList.toggle("dims", dims);
        layer.setAttribute("role", "dialog");
        let host = request.url;
        try {
            host = new URL(request.url).host || request.url;
        } catch {
            // The address stays as the engine gave it.
        }
        layer.setAttribute("aria-label", `Peek at ${host}`);
        // A click on the ground around the card closes it.
        layer.addEventListener("click", (event) => {
            if (event.target === layer) this.close();
        });

        const bar = document.createElement("div");
        bar.className = "peek-bar";
        const close = document.createElement("button");
        close.className = "peek-close";
        close.innerHTML = sfSymbol("xmark");
        close.title = "Close Peek (Esc or Ctrl+W)";
        close.setAttribute("aria-label", "Close Peek");
        close.addEventListener("click", () => this.close());
        const openIn = document.createElement("div");
        openIn.className = "peek-open-in";
        bar.append(close, openIn);

        const card = document.createElement("div");
        card.className = "peek-card";
        card.setAttribute("aria-label", "Loading Peek");
        layer.append(bar, card);
        document.body.append(layer);

        this.shown = { ...request, releaseOverlay: holdOverlay(), layer, card, openIn };
        this.drawOpenIn(this.shown);
        this.place();
        this.context.shortcutsChanged();
        this.context.relayout();
    }

    /** Takes the Peek away without letting its page go, which the core already kept or closed. */
    private dismiss(): void {
        const shown = this.shown;
        if (!shown) return;
        this.shown = null;
        shown.layer.classList.add("leaving");
        shown.layer.addEventListener("animationend", () => shown.layer.remove(), { once: true });
        // Removed anyway where nothing animates.
        setTimeout(() => shown.layer.remove(), 400);
        shown.releaseOverlay();
        this.context.shortcutsChanged();
        this.context.relayout();
    }

    /** Lays the Peek over the page's card: the controls above the card, which takes the room left. */
    private place(): void {
        const shown = this.shown;
        if (!shown) return;
        const box = document.getElementById("page")!.getBoundingClientRect();
        Object.assign(shown.layer.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
        const roomWidth = Math.max(0, box.width - pointerMargin * 2);
        const roomHeight = Math.max(0, box.height - pointerMargin * 2 - controlHeight - controlSpacing);
        const width = roomWidth * cardShare;
        const height = roomHeight * cardShare;
        const left = pointerMargin + (roomWidth - width) / 2;
        const top = pointerMargin + controlHeight + controlSpacing + (roomHeight - height) / 2;
        Object.assign(shown.card.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        const bar = shown.layer.querySelector<HTMLElement>(".peek-bar")!;
        bar.style.top = `${top - controlSpacing - controlHeight}px`;
        bar.style.right = `${pointerMargin + (roomWidth - width) / 2}px`;
        this.context.relayout();
    }

    /** Open In, in the Peek's Space's colour, and the menu of the other Spaces it may go to. */
    private drawOpenIn(shown: Shown): void {
        const space = this.context.workspace()?.spaces.get(shown.spaceId);
        const key = JSON.stringify(space?.state.settings ?? null);
        if (shown.openIn.dataset.key === key) return;
        shown.openIn.dataset.key = key;
        const primary = document.createElement("button");
        primary.className = "peek-open-primary";
        primary.title = `Open in ${space?.state.settings.name ?? "Space"} (Ctrl+O)`;
        primary.setAttribute("aria-label", "Open In…");
        if (space) primary.append(spaceIcon(space.state.settings, 22));
        else primary.insertAdjacentHTML("beforeend", sfSymbol("square.grid.2x2"));
        const title = document.createElement("span");
        title.textContent = "Open In…";
        primary.append(title);
        primary.addEventListener("click", () => void this.keep(shown.spaceId));
        const separator = document.createElement("span");
        separator.className = "peek-open-separator";
        const choose = document.createElement("button");
        choose.className = "peek-open-menu";
        choose.innerHTML = sfSymbol("chevron.down");
        choose.title = "Open in another Space";
        choose.setAttribute("aria-label", "Choose Destination Space");
        choose.addEventListener("click", () => this.chooseSpace(choose));
        shown.openIn.replaceChildren(primary, separator, choose);
        if (space) {
            const look = space.state.settings.look;
            const tint = look.colors.colors[0];
            shown.openIn.style.setProperty("--peek-space-tint", tint ? css(tint) : "var(--space-tint)");
            const dark = matchMedia("(prefers-color-scheme: dark)").matches;
            shown.openIn.classList.toggle("reads-light", foregroundTone(look, dark) === "light");
        }
    }

    /** The Spaces the Peek's page may go to: every one not being deleted. */
    private destinations(): Space[] {
        const workspace = this.context.workspace();
        if (!workspace) return [];
        const deleting = new Set(workspace.deletions.map((deletion) => deletion.spaceId));
        return workspace.order
            .map((id) => workspace.spaces.get(id))
            .filter((space): space is Space => space !== undefined && !deleting.has(space.state.id));
    }

    private chooseSpace(anchor: HTMLElement): void {
        const shown = this.shown;
        if (!shown) return;
        Menu.open(
            this.destinations().map((space) => ({
                title: space.state.settings.name,
                icon: { kind: "space" as const, settings: space.state.settings },
                action: () => void this.keep(space.state.id),
            })),
            { anchor: anchor.getBoundingClientRect() },
        );
    }
}
