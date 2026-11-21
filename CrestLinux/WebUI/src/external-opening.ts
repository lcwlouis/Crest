// What another app hands Crest on Linux, a web link or a document, opened
// where the core places it, as the Mac's BrowserMacExternalOpening: the core
// says which addresses Crest takes at all (ExternalWebLink,
// ExternalLocalDocument), then names the window and the Space: the window in
// use over the person's own Spaces, or with none open, one to open, or for a
// link, a Quick Window alone.

import type { Guid } from "../generated/crest_contracts.js";
import { openWindow, presentWindow, query, stackedWindows } from "./bridge.js";

/** What the opening asks of the browser window that received the addresses. */
export interface ExternalOpeningContext {
    /** The core's id for the window that received them. */
    readonly windowId: () => Guid;
    /** Opens each of `urls` in a new tab of `spaceId` in the window `windowId`, the last one shown. */
    readonly openTabs: (urls: readonly string[], spaceId: Guid, windowId: Guid) => Promise<void>;
    readonly report: (error: unknown) => void;
}

/** What separates the addresses a window opens with in the `url` parameter of its address. */
export const addressSeparator = "\n";

export class ExternalOpening {
    private readonly context: ExternalOpeningContext;

    constructor(context: ExternalOpeningContext) {
        this.context = context;
    }

    /**
     * Opens `urls`, as another app handed them: the documents Crest accepts
     * together, then each link it accepts in turn. Crest refuses the rest,
     * so another app cannot steer it at other schemes or remote files.
     */
    async open(urls: readonly string[]): Promise<void> {
        const documents: string[] = [];
        const links: string[] = [];
        for (const url of urls) {
            try {
                const parsed = new URL(url);
                if (parsed.protocol === "file:") {
                    if (await acceptsDocument(parsed)) documents.push(parsed.href);
                } else if (await acceptsLink(parsed)) {
                    links.push(parsed.href);
                }
            } catch (error) {
                // An address the platform cannot parse is refused, as the Mac's answers fail closed.
                if (!(error instanceof TypeError)) this.context.report(error);
            }
        }
        if (documents.length > 0) await this.openDocuments(documents);
        for (const url of links) await this.openLink(url);
    }

    /**
     * Opens a link where the core routes it: a Quick Window alone, over the
     * window the core names or none, or a new tab in the window the core
     * names, which opens when it is not open yet.
     */
    private async openLink(url: string): Promise<void> {
        try {
            const placement = await query("RouteExternalLink", { windowIds: await stackedWindows(), url });
            const { spaceId, windowId } = placement;
            if (!spaceId) return;
            if (placement.opensQuickWindow) {
                const target = placement.opensWindow ? null : windowId;
                openWindow("quick", null, { ...(target ? { target } : {}), space: spaceId, url }, true);
            } else if (windowId) {
                await this.openTabs([url], spaceId, windowId, placement.opensWindow);
            }
        } catch (error) {
            this.context.report(error);
        }
    }

    /**
     * Opens documents as tabs in the Space the core names, the one on screen,
     * in the window that shows it, or in the window that opens when none is.
     */
    private async openDocuments(urls: readonly string[]): Promise<void> {
        try {
            const placement = await query("RouteLocalDocument", { windowIds: await stackedWindows() });
            // TODO(linux): the Mac unlocks a locked Space before it opens a
            // document there; Linux has no Space lock prompt yet, and the
            // core refuses tabs for a Space that stays locked.
            if (placement.spaceId && placement.windowId) {
                await this.openTabs(urls, placement.spaceId, placement.windowId, placement.opensWindow);
            }
        } catch (error) {
            this.context.report(error);
        }
    }

    /**
     * Opens `urls` as new tabs of `spaceId` in the window `windowId`: the one
     * that received them, another open one, which comes forward, or one the
     * core names to open, which opens them itself once it is open.
     */
    private async openTabs(urls: readonly string[], spaceId: Guid, windowId: Guid, opensWindow: boolean): Promise<void> {
        if (opensWindow) {
            openWindow("browser", windowId, { window: windowId, space: spaceId, url: urls.join(addressSeparator) }, true);
            return;
        }
        await this.context.openTabs(urls, spaceId, windowId);
        if (windowId !== this.context.windowId()) presentWindow(windowId);
    }
}

/** Whether the core takes `url` as a web link: HTTP or HTTPS with a host. */
async function acceptsLink(url: URL): Promise<boolean> {
    const scheme = url.protocol.replace(/:$/, "");
    const verdict = await query("ExternalWebLink", { scheme: scheme || null, host: url.hostname || null });
    return verdict.accepted;
}

/** Whether the core takes `url` as a document on this device. */
async function acceptsDocument(url: URL): Promise<boolean> {
    const facts = {
        isFile: url.protocol === "file:",
        hasUser: url.username.length > 0,
        hasPath: url.pathname.length > 0,
        host: url.hostname || null,
    };
    const verdict = await query("ExternalLocalDocument", { facts });
    return verdict.accepted;
}
