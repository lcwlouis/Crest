// The address of the link under the pointer, at the page card's bottom
// corner, as the Mac's BrowserLinkHoverPreview: the engine says which link
// the pointer is on (LinkHovered); after a second on it the address shows on
// one line, cut in its middle, and after 0.8 seconds more it opens to four.
// Leaving the link, moving to another, a navigation or the WebUI rising over
// the page puts it away, and so does a surface over the page it cannot show
// with, such as the find bar: as the Mac's label goes with the key press or
// click that brought that surface, it shows again only for the next link the
// engine reports.

import type { Guid, LinkHovered, PageState } from "../generated/crest_contracts.js";
import type { FloatEvent } from "./float.js";
import { onOverlayChange, overlayHeld } from "./overlay.js";
import {
    linkHoverInset,
    linkHoverLabel,
    linkHoverMaxWidth,
    linkHoverShadowRoom,
    measure,
    truncateMiddle,
} from "./page-layers.js";
import type { PageLayerState } from "./page-layers.js";
import { FloatRank } from "./surfaces.js";
import type { FloatSurface, FloatSurfaces } from "./surfaces.js";

/** BrowserLinkHoverState: how long the pointer rests on a link before it shows, and before it opens. */
const appearanceDelay = 1000;
const expansionDelay = 800;
/** The longest address shown, as BrowserLinkHoverDestination. */
const longestAddress = 8192;

/**
 * The address as the label shows it, without the user name and password it
 * may carry, or null for one that is no address. Text only: it is never
 * opened.
 */
function destination(href: string): string | null {
    if (new TextEncoder().encode(href).length > longestAddress) return null;
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    url.username = "";
    url.password = "";
    return url.href;
}

export class LinkHoverPreview implements FloatSurface {
    readonly rank = FloatRank.linkHover;
    readonly exclusive = false;
    private readonly page: () => PageState | undefined;
    private readonly surfaces: FloatSurfaces;
    /** The page whose link the pointer is on. */
    private pageId: Guid | null = null;
    private shown: string | null = null;
    private expanded = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(page: () => PageState | undefined, surfaces: FloatSurfaces) {
        this.page = page;
        this.surfaces = surfaces;
        surfaces.add(this);
        onOverlayChange(() => {
            if (overlayHeld()) this.invalidate();
        });
        new ResizeObserver(() => this.place()).observe(document.getElementById("page")!);
    }

    /** The engine says the pointer moved onto a link of `pageId`, or off every link. */
    hovered(hover: LinkHovered): void {
        if (hover.pageId !== this.page()?.id) return;
        this.invalidate();
        const text = hover.url === null ? null : destination(hover.url);
        if (text === null || overlayHeld()) return;
        this.pageId = hover.pageId;
        this.timer = setTimeout(() => {
            this.shown = text;
            this.place();
            this.timer = setTimeout(() => {
                this.timer = null;
                this.expanded = true;
                this.place();
            }, expansionDelay);
        }, appearanceDelay);
    }

    /** The page navigated, or the window shows another page: the label goes. */
    invalidate(pageId?: Guid): void {
        if (pageId !== undefined && pageId !== this.pageId) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.pageId = null;
        this.expanded = false;
        if (this.shown === null) return;
        this.shown = null;
        this.place();
    }

    /** Follows the page the window shows. */
    follow(): void {
        if (this.pageId && this.page()?.id !== this.pageId) this.invalidate();
    }

    restore(): void {
        this.place();
    }

    handle(_event: FloatEvent): void {}

    displaced(): void {
        this.invalidate();
    }

    private place(): void {
        if (this.shown === null) {
            this.surfaces.post(this, null);
            return;
        }
        const card = document.getElementById("page")!.getBoundingClientRect();
        const maxWidth = Math.min(linkHoverMaxWidth, Math.max(0, card.width - 2 * linkHoverInset));
        const state: Extract<PageLayerState, { kind: "linkHover" }> = {
            kind: "linkHover",
            text: this.expanded ? this.shown : truncateMiddle(this.shown, maxWidth),
            expanded: this.expanded,
            maxWidth,
        };
        const size = measure(linkHoverLabel(state));
        this.surfaces.post(this, {
            bounds: {
                x: card.left + linkHoverInset - linkHoverShadowRoom,
                y: card.bottom - linkHoverInset - size.height - linkHoverShadowRoom,
                width: size.width + 2 * linkHoverShadowRoom,
                height: size.height + 2 * linkHoverShadowRoom,
            },
            focus: false,
            state,
            band: "bottom",
        });
    }
}
