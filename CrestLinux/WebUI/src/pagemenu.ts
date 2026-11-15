// The rows Crest puts in the context menu Chromium shows over a page, which
// the window hands here to run, since they need the core: a search for the
// selection in a new tab, as the Mac's BrowserPageContextMenuAction does,
// and the address the menu copies, which leaves Crest as the core's clean
// copy (Super Copy).

import { copyLink, query, registerPageMenu, setSelectionSearch } from "./bridge.js";
import type { Guid, Intent, PageState, SpaceSettings } from "../generated/crest_contracts.js";
import type { Model } from "./model.js";

/** What the page menu reads and acts through. */
export interface PageMenuContext {
    readonly model: Model;
    readonly windowId: () => Guid;
    readonly send: (intent: Intent) => void;
    readonly report: (error: unknown) => void;
}

export class PageMenu {
    private readonly context: PageMenuContext;
    /** The page, and its Space's settings, the window last named a search engine for. */
    private followed: { readonly pageId: Guid | null; readonly settings: SpaceSettings | undefined } = {
        pageId: null,
        settings: undefined,
    };

    constructor(context: PageMenuContext) {
        this.context = context;
        registerPageMenu(
            (pageId, text) => this.search(pageId, text),
            (url) => this.copy(url),
        );
    }

    /**
     * Tells the window which engine a selection on `page` searches with, as
     * its Space searches. A page without a tab, as a Peek shows, offers no
     * search, as on the Mac.
     */
    follow(page: PageState | undefined): void {
        const space = page ? this.context.model.workspaces.get(page.workspaceId)?.spaces.get(page.spaceId) : undefined;
        const searches = page?.tabId && space ? page : undefined;
        const settings = space?.state.settings;
        const pageId = searches?.id ?? null;
        if (this.followed.pageId === pageId && this.followed.settings === settings) return;
        const followed = { pageId, settings };
        this.followed = followed;
        if (!searches) {
            setSelectionSearch("", "");
            return;
        }
        void query("SelectionSearch", { workspaceId: searches.workspaceId, spaceId: searches.spaceId, text: "" })
            .then((answer) => {
                if (this.followed === followed) setSelectionSearch(searches.id, answer.engineTitle);
            })
            .catch(this.context.report);
    }

    /** Opens the search for `text` in a new tab after the page's own, in the page's Space. */
    private search(pageId: Guid, text: string): void {
        const page = this.context.model.pages.get(pageId);
        const tabId = page?.tabId;
        if (!page || !tabId) return;
        void query("SelectionSearch", { workspaceId: page.workspaceId, spaceId: page.spaceId, text })
            .then((answer) => {
                if (!answer.url) return;
                this.context.send({
                    kind: "OpenTab",
                    value: {
                        workspaceId: page.workspaceId,
                        windowId: this.context.windowId(),
                        spaceId: page.spaceId,
                        tabId: crypto.randomUUID(),
                        content: { address: answer.url, view: null, title: null },
                        placement: "Current",
                        afterTabId: tabId,
                        shows: true,
                    },
                });
            })
            .catch(this.context.report);
    }

    /** Copies the core's clean copy of `url`, without the trackers it carries. */
    private copy(url: string): void {
        void query("LinkToCopy", { url })
            .then((clean) => copyLink(clean))
            .catch(this.context.report);
    }
}
