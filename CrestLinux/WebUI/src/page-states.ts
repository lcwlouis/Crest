// What the window shows of a page beyond the page itself, as the Mac's page
// surface and window chrome show it: notices at the window's top, the
// address of the link under the pointer, a page still opening, the engine's
// bars for the page, and a page its engine could not make.

import type { Change, EnginePresentation, Guid, PageState, TabState } from "../generated/crest_contracts.js";
import { InfoBars } from "./infobars.js";
import { LinkHoverPreview } from "./link-hover.js";
import type { Model } from "./model.js";
import { NoticeLayer } from "./notices.js";
import { ProcessFailureView } from "./page-failure.js";
import { PageOpening } from "./page-opening.js";
import type { FloatSurfaces } from "./surfaces.js";

/** What the page states read of the window. */
export interface PageStatesContext {
    readonly model: Model;
    /** The tab the window shows. */
    readonly tab: () => TabState | undefined;
    /** The page the window shows, if the engine has one for the shown tab. */
    readonly page: () => PageState | undefined;
    readonly report: (error: unknown) => void;
}

export class PageStates {
    private readonly linkHover: LinkHoverPreview;
    private readonly opening: PageOpening;
    private readonly infoBars: InfoBars;
    private readonly processFailure: ProcessFailureView;

    constructor(context: PageStatesContext, surfaces: FloatSurfaces) {
        new NoticeLayer(surfaces);
        this.linkHover = new LinkHoverPreview(context.page, surfaces);
        this.opening = new PageOpening(context.page, surfaces);
        this.infoBars = new InfoBars(context.page, surfaces);
        this.processFailure = new ProcessFailureView(context.tab, context.page, context.report);
    }

    /** Follows a batch of the core's changes, and the page the window shows. */
    apply(changes: readonly Change[]): void {
        this.linkHover.follow();
        this.opening.apply(changes);
        this.infoBars.apply(changes);
        this.processFailure.follow();
    }

    /** Another window took the page `pageId`: what showed over it here goes. */
    pageLeft(pageId: Guid): void {
        this.linkHover.invalidate(pageId);
    }

    /** Hears one of the engine's presentations. */
    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "LinkHovered":
                this.linkHover.hovered(presentation.value);
                break;
            case "PageNavigationStarted":
                this.linkHover.invalidate(presentation.value.pageId);
                break;
            case "PageNavigationCommitted":
                this.linkHover.invalidate(presentation.value.pageId);
                this.opening.committed(presentation.value.pageId);
                break;
            case "InfoBarShown":
                this.infoBars.added(presentation.value);
                break;
            case "InfoBarRemoved":
                this.infoBars.removed(presentation.value);
                break;
            default:
                break;
        }
    }
}
