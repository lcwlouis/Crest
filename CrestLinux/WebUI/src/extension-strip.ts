// A Space's pinned extensions in the sidebar, above its pinned tabs, as the
// Mac's BrowserPinnedExtensionStripContent: a row 32 high of 24-point tiles,
// centered and scrolling sideways when it overflows, which runs each action
// from its tile and opens its menu on a secondary click. The row belongs to
// the Space, so it shows whether or not a page is open; it also tells the
// window where each tile is, so a popup an extension opens itself hangs from
// its tile, and any other from the window's fallback control.
//
// TODO(linux): the Mac's Quick Window shows the pinned actions in its own
// toolbar (BrowserPinnedExtensionToolbarActions, with its overflow); the
// Linux Quick Window (quick.ts) shows none yet.

import { actionArtwork, anchorOf } from "./site-extensions.js";
import type { ExtensionStore } from "./extensions.js";
import type { ExtensionAnchor } from "./bridge.js";
import type { Space } from "./model.js";
import { element } from "./settings-form.js";

/** BrowserPinnedExtensionActionButton.glyphSize. */
const glyphSize = 16;

/** The controls a popup with no tile of its own hangs from, in the order tried. */
const fallbackControls = [".site-control-trigger:not([hidden])", ".extensions-trigger:not([hidden])", "#sidebar .address"];

export class ExtensionStrip {
    // MARK: - Variables

    private readonly store: ExtensionStore;
    private anchorsPending = false;

    // MARK: - Initializers

    constructor(store: ExtensionStore) {
        this.store = store;
        window.addEventListener("resize", () => this.reportAnchors());
    }

    // MARK: - Actions

    /** The strip of `space`, or null when it pins nothing. */
    draw(space: Space): HTMLElement | null {
        this.store.prepare(space);
        const page = this.store.host.page();
        const actions = this.store.pinnedActions(space, page);
        this.reportAnchors();
        if (actions.length === 0) return null;
        const strip = element("div", "extension-strip");
        strip.setAttribute("aria-label", "Pinned Extensions");
        const row = element("div", "extension-strip-row");
        for (const action of actions) {
            const tile = element("button", "extension-strip-tile");
            tile.type = "button";
            tile.dataset.extensionId = action.id;
            tile.title = action.displayName;
            tile.setAttribute("aria-label", action.displayName);
            tile.append(actionArtwork(action, glyphSize));
            tile.addEventListener("click", () => void this.store.run(action, anchorOf(tile), space));
            tile.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.store.presentMenu(action, space, anchorOf(tile));
            });
            row.append(tile);
        }
        strip.append(row);
        return strip;
    }

    /** Tells the window, once the sidebar is laid out, where each tile and the fallback control are. */
    reportAnchors(): void {
        if (this.anchorsPending) return;
        this.anchorsPending = true;
        requestAnimationFrame(() => {
            this.anchorsPending = false;
            const anchors = new Map<string, ExtensionAnchor>();
            for (const selector of fallbackControls) {
                const control = document.querySelector(selector);
                const box = control?.getBoundingClientRect();
                if (box && box.width > 0) {
                    anchors.set("", box);
                    break;
                }
            }
            for (const tile of document.querySelectorAll<HTMLElement>(".extension-strip-tile")) {
                const box = tile.getBoundingClientRect();
                if (tile.dataset.extensionId && box.width > 0) anchors.set(tile.dataset.extensionId, box);
            }
            this.store.placeAnchors(anchors);
        });
    }
}
