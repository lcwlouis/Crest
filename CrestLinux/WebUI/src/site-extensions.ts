// The extensions section of Site Controls, as the Mac's
// BrowserSiteExtensionsSection and ChromiumExtensionControls draw it: the
// "Extensions" header with its Manage Extensions button, the page's actions
// in a grid of four (each with its badge, a pin button on hover and its
// context menu), and Install Extension… on a Chrome Web Store listing whose
// Space may change. Site Controls shows the section under its quick actions.

import type { PageState } from "../generated/crest_contracts.js";
import { iconView } from "./extension-install.js";
import { webStoreExtensionId } from "./extensions.js";
import type { ExtensionActionPresentation, ExtensionStore } from "./extensions.js";
import type { Space } from "./model.js";
import type { SiteControlsSection } from "./site-controls.js";
import { element } from "./settings-form.js";
import { sfSymbol } from "./symbols.js";

/** BrowserSiteControlMetrics. */
const metrics = {
    glyph: 17,
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

// MARK: - In Site Controls

/** The section Site Controls shows under its quick actions for the window's store. */
export function siteControlsExtensions(store: ExtensionStore): SiteControlsSection {
    return {
        key: (page) => {
            const space = store.space(page.spaceId);
            if (!space) return "";
            return JSON.stringify([store.actions(page), store.mayChange(space), webStoreExtensionId(page.live.address)]);
        },
        draw: (page, dismiss) => {
            const space = store.space(page.spaceId);
            if (!space) return null;
            store.prepare(space);
            return siteExtensionsSection({ store, page, space, dismiss });
        },
    };
}
