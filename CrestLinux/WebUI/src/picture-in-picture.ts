// Automatic Picture in Picture on Linux, as the Mac's
// BrowserAutomaticPictureInPictureCoordinator and the Chromium page's
// ChromiumPictureInPicturePageController decide it: when a tab whose page
// plays media leaves the cards this window presents, and no page already
// floats, its video floats in Chromium's Picture in Picture window. One
// request is in flight at a time; returning to the tab before the engine
// answers cancels it. A tab another window still presents stays where it is.
//
// TODO(linux): the Mac keeps a full-screen page that the sidebar reveal still
// serves from floating; Linux has no sidebar reveal yet.

import { pageRequest } from "./bridge.js";
import { PageMediaActivity } from "../generated/crest_contracts.js";
import type { Guid } from "../generated/crest_contracts.js";
import type { Model } from "./model.js";

export interface AutomaticPictureInPictureHost {
    readonly model: Model;
    readonly windowId: () => Guid;
    /** Whether the person lets a video float when they switch tabs. */
    readonly isEnabled: () => boolean;
    readonly report: (error: unknown) => void;
}

/** How long the engine has to float the video before the reservation lapses (the Mac's check). */
const settleDelay = 600;

export class AutomaticPictureInPicture {
    private readonly host: AutomaticPictureInPictureHost;
    private presented: readonly Guid[] = [];
    /** The tab whose video is asked to float, until the engine settles it. */
    private pending: Guid | null = null;
    private reservation = 0;

    constructor(host: AutomaticPictureInPictureHost) {
        this.host = host;
    }

    /** Follows the tabs the window presents: the ones that left may float, the ones that came back cancel. */
    follow(presented: readonly Guid[]): void {
        const departed = this.presented.filter((tabId) => !presented.includes(tabId));
        const arrived = presented.filter((tabId) => !this.presented.includes(tabId));
        this.presented = [...presented];
        for (const tabId of departed) {
            if (!this.presentedElsewhere(tabId)) this.request(tabId);
        }
        if (this.pending && arrived.includes(this.pending)) this.release();
    }

    private request(tabId: Guid): void {
        const page = this.host.model.pageFor(tabId);
        if (!page || !this.host.isEnabled() || this.pending !== null) return;
        const media = page.live.media;
        if (!(media & PageMediaActivity.Playing) || media & PageMediaActivity.PictureInPicture) return;
        for (const other of this.host.model.pages.values()) {
            if (other.live.media & PageMediaActivity.PictureInPicture) return;
        }
        const token = ++this.reservation;
        this.pending = tabId;
        void pageRequest("EnterPictureInPicture", { pageId: page.id })
            .then((entered) => {
                if (!entered) {
                    if (this.reservation === token) this.release();
                    return;
                }
                // The engine asks the renderer; its answer reaches the page's
                // media activity shortly after.
                setTimeout(() => {
                    if (this.reservation === token) this.release();
                }, settleDelay);
            })
            .catch((error: unknown) => {
                if (this.reservation === token) this.release();
                this.host.report(error);
            });
    }

    private release(): void {
        this.pending = null;
        this.reservation++;
    }

    /** Whether another window still shows `tabId` in the Space it shows. */
    private presentedElsewhere(tabId: Guid): boolean {
        for (const window of this.host.model.windows.values()) {
            if (window.id === this.host.windowId()) continue;
            if (window.shownTabs.some((shown) => shown.spaceId === window.shownSpaceId && shown.tabId === tabId)) return true;
        }
        return false;
    }
}
