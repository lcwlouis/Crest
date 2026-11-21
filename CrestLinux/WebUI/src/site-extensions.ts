// The extensions section of Site Controls, as the Mac's
// BrowserSiteExtensionsSection and ChromiumExtensionControls draw it: the
// "Extensions" header with its Manage Extensions button, the page's actions
// in a grid of four (each with its badge, a pin button on hover and its
// context menu), and Install Extension… on a Chrome Web Store listing whose
// Space may change. Site Controls embeds the section; until Linux has Site
// Controls in this branch, a puzzle-piece control in the navigation band
// opens the section in a popover of its own.

import type { PageState } from "../generated/crest_contracts.js";
import { iconView } from "./extension-install.js";
import { webStoreExtensionId } from "./extensions.js";
import type { ExtensionActionPresentation, ExtensionStore } from "./extensions.js";
import { Menu } from "./menu.js";
import type { Space } from "./model.js";
import { holdOverlay } from "./overlay.js";
import { element } from "./settings-form.js";
import { sfSymbol } from "./symbols.js";

/** BrowserSiteControlMetrics. */
const metrics = {
    width: 292,
    glyph: 17,
    gap: 6,
    margin: 8,
} as const;

// MARK: - Parts

/** An action's icon with its badge (BrowserExtensionActionArtwork). */
export function actionArtwork(action: ExtensionActionPresentation, glyphSize: number): HTMLElement {
    const artwork = iconView(action.icon, glyphSize);
    artwork.classList.add("extension-artwork");
    artwork.classList.toggle("disabled", !action.isEnabled);
    if (action.badgeText) artwork.append(element("span", "extension-badge", action.badgeText));
    return artwork;
}

/** The control's place in the window, which a popup hangs from. */
export function anchorOf(node: Element): DOMRect {
    return node.getBoundingClientRect();
}

/** Runs `perform` once the surface `dismiss` closes has gone, as the Mac's afterDismiss. */
function afterDismiss(dismiss: () => void, perform: () => void): void {
    dismiss();
    window.setTimeout(perform);
}

// MARK: - The section

export interface SiteExtensionsContext {
    readonly store: ExtensionStore;
    readonly page: PageState;
    readonly space: Space;
    /** Closes the surface the section shows in. */
    readonly dismiss: () => void;
}

/** The page's extension actions, as Site Controls shows them. */
export function siteExtensionsSection(context: SiteExtensionsContext): HTMLElement {
    const { store, page, space, dismiss } = context;
    const section = element("section", "site-extensions");
    section.setAttribute("aria-label", "Extensions");

    const header = element("div", "site-extensions-header");
    header.append(element("h3", "", "Extensions"));
    const manage = element("button", "site-extensions-manage");
    manage.type = "button";
    manage.title = "Manage Extensions";
    manage.setAttribute("aria-label", "Manage Extensions");
    manage.innerHTML = sfSymbol("plus", 11);
    manage.addEventListener("click", () => afterDismiss(dismiss, () => store.host.openSettings(space.state.id)));
    header.append(manage);
    section.append(header);

    const actions = store.actions(page);
    if (actions.length === 0) {
        const empty = element("div", "site-extensions-empty");
        empty.innerHTML = sfSymbol("puzzlepiece.extension", 12);
        empty.append(element("span", "", "No extension actions for this page"));
        section.append(empty);
    } else {
        const grid = element("div", "site-extensions-grid");
        for (const action of actions) grid.append(actionButton(context, action));
        section.append(grid);
    }

    const listing = webStoreExtensionId(page.live.address);
    if (listing && store.mayChange(space) === true) {
        const install = element("button", "site-extensions-install");
        install.type = "button";
        install.innerHTML = sfSymbol("plus.app", 13);
        install.append(element("span", "", "Install Extension…"));
        install.addEventListener("click", () => afterDismiss(dismiss, () => store.beginInstall(listing, space)));
        section.append(install);
    }
    return section;
}

/** One action of the grid (BrowserSiteExtensionActionButton). */
function actionButton(context: SiteExtensionsContext, action: ExtensionActionPresentation): HTMLElement {
    const { store, space, dismiss } = context;
    const cell = element("div", "site-extension-action");
    const button = element("button", "site-extension-run");
    button.type = "button";
    button.title = action.displayName;
    button.setAttribute("aria-label", action.displayName);
    button.append(actionArtwork(action, metrics.glyph));
    button.addEventListener("click", () => {
        // The popup hangs from where the control was, after Site Controls closes.
        const anchor = anchorOf(button);
        afterDismiss(dismiss, () => void store.run(action, anchor, space));
    });
    button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Site Controls stays open under the menu, and closes only for an item that leads elsewhere.
        void store.presentMenu(action, space, anchorOf(button), dismiss);
    });
    const pin = element("button", "extension-pin");
    pin.type = "button";
    const pinLabel = action.isPinned ? "Unpin Extension" : "Pin Extension";
    pin.title = pinLabel;
    pin.setAttribute("aria-label", pinLabel);
    pin.innerHTML = sfSymbol(action.isPinned ? "pin.slash.fill" : "pin.fill", 8);
    pin.addEventListener("click", () => store.togglePin(action, space));
    cell.append(button, pin);
    return cell;
}

// MARK: - The temporary popover

/**
 * The navigation band's extensions control and the popover it opens with
 * the section in it.
 *
 * TODO(linux): Site Controls (linux/site-controls) embeds
 * siteExtensionsSection where its header leaves the "extensions grid (step
 * 16)"; once it merges, this control and its popover go, and the store's
 * fallback anchor is the Site Controls trigger alone.
 */
export class SiteExtensionsControl {
    // MARK: - Variables

    readonly trigger: HTMLButtonElement;
    private readonly store: ExtensionStore;
    private popover: { readonly layer: HTMLElement; readonly panel: HTMLElement; readonly pageId: string; readonly release: () => void; readonly onKey: (event: KeyboardEvent) => void } | null = null;

    // MARK: - Initializers

    constructor(store: ExtensionStore) {
        this.store = store;
        this.trigger = element("button", "nav-control extensions-trigger");
        this.trigger.type = "button";
        this.trigger.title = "Extensions";
        this.trigger.setAttribute("aria-label", "Extensions");
        this.trigger.innerHTML = sfSymbol("puzzlepiece.extension", 14);
        this.trigger.addEventListener("click", (event) => {
            event.stopPropagation();
            if (this.popover) this.close();
            else this.open();
        });
    }

    // MARK: - Actions

    /** Draws the control for the shown page, and the open popover again. */
    follow(): void {
        const page = this.store.host.page();
        // Site Controls, where it exists, holds the section itself.
        const siteControls = document.querySelector(".site-control-trigger");
        this.trigger.hidden = !page || page.live.address === null || siteControls !== null;
        this.trigger.setAttribute("aria-expanded", String(this.popover !== null));
        const popover = this.popover;
        if (!popover) return;
        if (!page || page.id !== popover.pageId) {
            this.close();
            return;
        }
        this.draw(page);
    }

    private open(): void {
        const page = this.store.host.page();
        const space = page ? this.store.space(page.spaceId) : undefined;
        if (!page || !space) return;
        const layer = element("div", "site-extensions-layer");
        const panel = element("div", "site-extensions-popover");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Extensions");
        layer.append(panel);
        layer.addEventListener("mousedown", (event) => {
            if (event.target !== layer) return;
            event.preventDefault();
            this.close();
        });
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || Menu.isOpen) return;
            event.preventDefault();
            event.stopPropagation();
            this.close();
        };
        window.addEventListener("keydown", onKey, true);
        document.body.append(layer);
        this.popover = { layer, panel, pageId: page.id, release: holdOverlay(), onKey };
        this.store.prepare(space);
        this.follow();
    }

    close(): void {
        const popover = this.popover;
        if (!popover) return;
        this.popover = null;
        window.removeEventListener("keydown", popover.onKey, true);
        popover.layer.remove();
        popover.release();
        this.trigger.setAttribute("aria-expanded", "false");
    }

    private draw(page: PageState): void {
        const popover = this.popover;
        const space = this.store.space(page.spaceId);
        if (!popover || !space) return;
        popover.panel.replaceChildren(siteExtensionsSection({ store: this.store, page, space, dismiss: () => this.close() }));
        const anchor = this.trigger.getBoundingClientRect();
        const left = Math.max(metrics.margin, Math.min(anchor.left, window.innerWidth - metrics.width - metrics.margin));
        popover.panel.style.left = `${left}px`;
        popover.panel.style.top = `${anchor.bottom + metrics.gap}px`;
        popover.panel.style.width = `${metrics.width}px`;
    }
}
