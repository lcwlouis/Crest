// One window's extension side panels, as the Mac's
// BrowserExtensionSidePanelHost keeps them: a card beside the page, never a
// tab and never a window, which holds the panel document the engine made for
// one tab. The window shows the focused tab's own panel; without one, the
// panel it was showing stays only when its extension shows that same panel
// for the new tab too, and otherwise the card closes and the panel waits
// with its tab. Nothing here is kept: the engine owns each document, and
// closing the window leaves nothing behind. This draws the card's header and
// tells the window where the document goes (placeSidePanel).

import type { Guid, PageState, SidePanelRequested, SidePanelScope } from "../generated/crest_contracts.js";
import { closeSidePanel, openSidePanel, pageRequest, placeSidePanel } from "./bridge.js";
import type { ExtensionActionPresentation, ExtensionStore } from "./extensions.js";
import { iconView } from "./extension-install.js";
import { postNotice } from "./notices.js";
import { element } from "./settings-form.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

interface Panel {
    /** The owning extension. */
    readonly id: string;
    /** The page of the tab the panel was opened for, which keeps its document. */
    readonly pageId: Guid;
    readonly title: string;
    readonly icon: string | null;
    /** Whether the extension shows one panel for every tab (Window) or gave this tab its own (Tab). */
    readonly scope: SidePanelScope;
}

/** How long to keep asking while the extension finishes enabling its panel. */
const enablementRetryDelays = [100, 250, 600];

const hidden = { x: 0, y: 0, width: 0, height: 0 };

export class ExtensionSidePanels {
    // MARK: - Variables

    private readonly store: ExtensionStore;
    /** Each tab's own panel, by its page, whether or not the window shows it. */
    private readonly panels = new Map<Guid, Panel>();
    /** The panel the window shows beside its focused page. */
    private shown: Panel | null = null;
    /** The page the window focuses, or null while it shows none. */
    private focused: Guid | null = null;
    /** The panel that showed when the window moved to no page, which the next page may still show. */
    private carried: Panel | null = null;
    /** The page whose document the window last placed in the card. */
    private placed: Guid | null = null;
    private sentPlace = "";
    private readonly card = element("aside", "side-panel");
    private readonly header = element("div", "side-panel-header");
    private readonly content = element("div", "side-panel-content");

    // MARK: - Initializers

    constructor(store: ExtensionStore) {
        this.store = store;
        this.card.id = "side-panel";
        this.card.hidden = true;
        this.card.setAttribute("aria-label", "Extension Side Panel");
        this.card.append(this.header, this.content);
        document.body.append(this.card);
        new ResizeObserver(() => this.place()).observe(this.content);
        window.addEventListener("resize", () => this.place());
    }

    // MARK: - Actions - Panels

    /** The panel the tab showing `pageId` shows: the window's while that tab has focus, and otherwise the tab's own. */
    private panelOn(pageId: Guid): Panel | null {
        return pageId === this.focused ? this.shown : (this.panels.get(pageId) ?? null);
    }

    /**
     * The item the action's menu offers to open its panel, or null when the
     * extension has no side panel for `page`'s own tab.
     */
    async opener(action: ExtensionActionPresentation, page: PageState): Promise<(() => void) | null> {
        const scope = await this.scope(page.id, action.id);
        if (scope === "Unavailable") return null;
        return () => {
            if (this.panelOn(page.id)?.id !== action.id) void this.present(action.id, page);
        };
    }

    /** Applies a request the engine made for a page's own tab (ChromiumSidePanelRoute). */
    route(request: SidePanelRequested): void {
        const page = this.store.host.model.pages.get(request.pageId);
        if (!page) return;
        const isShowing = this.panelOn(page.id)?.id === request.extensionId;
        switch (request.request) {
            case "Open":
                if (!isShowing) void this.present(request.extensionId, page);
                break;
            case "Close":
                if (isShowing) this.closeOn(page.id);
                break;
            case "Toggle":
                if (isShowing) this.closeOn(page.id);
                else void this.present(request.extensionId, page);
                break;
        }
    }

    /** The panel document or its extension host went away; the engine already let it go, so only the card closes. */
    dismiss(extensionId: string, pageId: Guid): void {
        this.forget((panel) => panel.pageId === pageId && panel.id === extensionId);
        this.draw();
    }

    private async present(extensionId: string, page: PageState, attempt = 0): Promise<void> {
        let opened = false;
        try {
            opened = await openSidePanel(extensionId, page.id);
        } catch (error) {
            console.error(error);
        }
        if (!opened) {
            // An extension may enable its panel for the tab in the same turn
            // it asks to open it, and the engine can hear the open first.
            const delay = enablementRetryDelays[attempt];
            if (delay !== undefined) {
                window.setTimeout(() => {
                    const current = this.store.host.model.pages.get(page.id);
                    if (current && this.panelOn(page.id)?.id !== extensionId) void this.present(extensionId, current, attempt + 1);
                }, delay);
                return;
            }
            postNotice({ message: "This extension's side panel is unavailable on this page.", symbol: "sidebar.right", label: null });
            return;
        }
        const action = this.store.actions(page).find((candidate) => candidate.id === extensionId);
        const space = this.store.space(page.spaceId);
        const scope = await this.scope(page.id, extensionId);
        // The engine replaced any panel the tab had.
        this.forget((panel) => panel.pageId === page.id);
        const panel: Panel = {
            id: extensionId,
            pageId: page.id,
            title: action?.displayName ?? (space ? this.store.installedRecord(extensionId, space)?.name : undefined) ?? extensionId,
            icon: action?.icon ?? (space ? this.store.icon(extensionId, space) : null),
            scope,
        };
        this.panels.set(page.id, panel);
        if (page.id === this.focused) {
            this.shown = panel;
            this.carried = null;
        }
        this.draw();
    }

    /** The person closed the panel the tab showing `pageId` shows. */
    private closeOn(pageId: Guid): void {
        const panel = this.panelOn(pageId);
        if (!panel) return;
        this.forget((candidate) => candidate.pageId === panel.pageId && candidate.id === panel.id);
        closeSidePanel(panel.pageId);
        this.draw();
    }

    private forget(matches: (panel: Panel) => boolean): void {
        for (const [pageId, panel] of [...this.panels]) if (matches(panel)) this.panels.delete(pageId);
        if (this.shown && matches(this.shown)) this.shown = null;
        if (this.carried && matches(this.carried)) this.carried = null;
    }

    private async scope(pageId: Guid, extensionId: string): Promise<SidePanelScope> {
        try {
            return await pageRequest("HasSidePanel", { pageId, extensionId });
        } catch (error) {
            console.error(error);
            return "Unavailable";
        }
    }

    // MARK: - Actions - Focus

    /** Follows the window to the page it shows, and lets go of the panels of pages that went. */
    follow(): void {
        const pages = this.store.host.model.pages;
        this.forget((panel) => !pages.has(panel.pageId));
        const page = this.store.host.page();
        const pageId = page && this.store.host.showsPage(page.id) ? page.id : null;
        if (pageId !== this.focused) this.focus(pageId);
        this.draw();
    }

    private focus(pageId: Guid | null): void {
        const previous = this.shown ?? this.carried;
        this.focused = pageId;
        if (!pageId) {
            this.carried = previous;
            this.shown = null;
            return;
        }
        this.carried = null;
        this.shown = this.panels.get(pageId) ?? null;
        if (this.shown || !previous || previous.scope !== "Window") return;
        // The panel stays when its extension shows the same one for this tab.
        void this.scope(pageId, previous.id).then((scope) => {
            if (scope !== "Window" || this.focused !== pageId || this.shown) return;
            if (this.panels.get(previous.pageId) !== previous) return;
            this.shown = previous;
            this.draw();
        });
    }

    // MARK: - Actions - Drawing

    private draw(): void {
        const panel = this.shown;
        const open = panel !== null;
        document.body.classList.toggle("side-panel-open", open);
        this.card.hidden = !open;
        if (panel) {
            const title = element("span", "side-panel-title", panel.title);
            const close = element("button", "side-panel-close");
            close.type = "button";
            close.title = "Close Side Panel";
            close.setAttribute("aria-label", "Close Side Panel");
            close.innerHTML = sfSymbol("xmark", 12);
            close.addEventListener("click", () => {
                if (this.focused) this.closeOn(this.focused);
            });
            this.header.replaceChildren(iconView(panel.icon, 16), title, close);
        } else {
            this.header.replaceChildren();
        }
        this.place();
    }

    /** Tells the window where the shown panel's document goes, and hides the one it showed before. */
    private place(): void {
        const panel = this.shown;
        const target = panel?.pageId ?? null;
        if (this.placed && this.placed !== target) placeSidePanel(this.placed, hidden);
        this.placed = target;
        if (!target) {
            this.sentPlace = "";
            return;
        }
        const box = this.content.getBoundingClientRect();
        const place = { x: box.left, y: box.top, width: box.width, height: box.height };
        const sent = JSON.stringify([target, place]);
        if (sent === this.sentPlace) return;
        this.sentPlace = sent;
        placeSidePanel(target, place);
    }
}
