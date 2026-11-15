// What the window shows of a page beyond the page itself, as the Mac's page
// surface and window chrome show it: notices at the window's top, and the
// address of the link under the pointer.

import type { Change, EnginePresentation, PageState } from "../generated/crest_contracts.js";
import { LinkHoverPreview } from "./link-hover.js";
import type { Model } from "./model.js";
import { NoticeLayer } from "./notices.js";
import type { FloatSurfaces } from "./surfaces.js";

/** What the page states read of the window. */
export interface PageStatesContext {
    readonly model: Model;
    /** The page the window shows, if the engine has one for the shown tab. */
    readonly page: () => PageState | undefined;
}

export class PageStates {
    private readonly linkHover: LinkHoverPreview;

    constructor(context: PageStatesContext, surfaces: FloatSurfaces) {
        new NoticeLayer(surfaces);
        this.linkHover = new LinkHoverPreview(context.page, surfaces);
    }

    /** Follows a batch of the core's changes, and the page the window shows. */
    apply(_changes: readonly Change[]): void {
        this.linkHover.follow();
    }

    /** Hears one of the engine's presentations. */
    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "LinkHovered":
                this.linkHover.hovered(presentation.value);
                break;
            case "PageNavigationStarted":
            case "PageNavigationCommitted":
                this.linkHover.invalidate(presentation.value.pageId);
                break;
            default:
                break;
        }
    }
}
