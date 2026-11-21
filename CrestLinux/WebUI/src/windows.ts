// This browser window among Crest's windows on Linux, as the Mac's
// BrowserMacWindows and BrowserMacWindowCoordinator handle it: the window
// opens as the core's window under its own identity, opens others (a new
// window, a Quick Window, the launch's saved windows), closes as the core
// says, and moves a tab to another window.
//
// A tab's page is one live page, whichever window shows the tab, as the
// Mac's windows share their pages: the window in use shows it, and moves it
// into its own part of the engine; a window in the background that the page
// left shows its card empty until the person comes back to it, or until no
// window shows the page.

import type { Change, Guid, Intent, TabState } from "../generated/crest_contracts.js";
import {
    adoptWindow,
    closeWindow,
    dispatch,
    listenToWindow,
    openWindow,
    pageRequest,
    presentWindow,
    query,
    useThisWindow,
    Refused,
    requestClose,
    setWindowTitle,
    stackedWindows,
} from "./bridge.js";
import type { Model, Space, Workspace } from "./model.js";

/** What the window reads and asks of the rest of its WebUI. */
export interface WindowsContext {
    readonly model: Model;
    readonly workspace: () => Workspace | undefined;
    readonly space: () => Space | undefined;
    readonly tab: () => TabState | undefined;
    readonly report: (error: unknown) => void;
    /** The pages the window may show changed: it lays them out again. */
    readonly relayout: () => void;
    /** Another window took the page `pageId`, which this one no longer shows. */
    readonly pageLeft: (pageId: Guid) => void;
}

/** How this window's WebUI was opened, from the parameters in its address. */
interface Opening {
    /** The core's id for the window, or null for the launch's first window, which takes the startup window's. */
    readonly windowId: Guid | null;
    /** The window it opens as, when it has no record of its own. */
    readonly copyingWindowId: Guid | null;
    /** The Space it opens on. */
    readonly spaceId: Guid | null;
    /** A tab it opens showing, which it takes from `fromWindowId`, as Move to New Window does. */
    readonly tabId: Guid | null;
    readonly fromWindowId: Guid | null;
    /** A link another app handed Crest, which opens in a new tab once the window is open. */
    readonly url: string | null;
}

function opening(): Opening {
    const parameters = new URLSearchParams(location.search);
    const id = (name: string): Guid | null => parameters.get(name)?.toLowerCase() ?? null;
    return {
        windowId: id("window"),
        copyingWindowId: id("copying"),
        spaceId: id("space"),
        tabId: id("tab"),
        fromWindowId: id("from"),
        url: parameters.get("url"),
    };
}

/** How long a launch's reopened pages take to settle (BrowserMacWindows.reopenedPagesSettle). */
const reopenedPagesSettle = 60_000;

export class Windows {
    private readonly context: WindowsContext;
    private readonly opening = opening();
    /** The core's id for this window: a stand-in until the launch names the startup window. */
    private id: Guid = this.opening.windowId ?? crypto.randomUUID();
    /** Whether the person is using this window. A window opens in use. */
    private active = true;
    /** Pages another window took while this one was in the background. */
    private readonly left = new Set<Guid>();
    /** Pages this window asked the core and the engine to move here, until they did. */
    private readonly claiming = new Set<Guid>();
    private title = "";

    constructor(context: WindowsContext) {
        this.context = context;
        listenToWindow({
            closeRequested: (last) => void this.closeAsked(last),
            activeChanged: (active) => this.activeChanged(active),
            pageLeft: (pageId) => {
                this.left.add(pageId);
                this.context.pageLeft(pageId);
                this.context.relayout();
            },
            // The window that took the page let it go: this one shows it again where its card shows the tab.
            pageFree: (pageId) => {
                if (this.left.delete(pageId)) this.context.relayout();
            },
            pageArrived: (pageId) => void this.claim(pageId),
            showSpace: (spaceId) => void this.send({ kind: "ShowSpace", value: { windowId: this.id, spaceId } }),
            openExternal: (urls) => void this.openExternal(urls),
        });
        // The person using the window's WebUI makes it the window in use,
        // though the window manager may keep the focus elsewhere, so what it
        // asks for opens over it and the pages it shows stay in it.
        for (const event of ["pointerdown", "keydown"]) {
            window.addEventListener(event, () => this.used(), { capture: true, passive: true });
        }
    }

    /** The core's id for this window. */
    get windowId(): Guid {
        return this.id;
    }

    /** Whether this is the launch's first window, which asks the core what the launch opens. */
    get launches(): boolean {
        return this.opening.windowId === null;
    }

    /** Whether the window shows `pageId` where its tab is: always while in use, else unless another window took it. */
    shows(pageId: Guid): boolean {
        return this.active || !this.left.has(pageId);
    }

    /**
     * Opens this window in the core, as the Mac's window store does when its
     * window opens: the launch's first window opens the windows the core
     * reopens, behind it, and takes the frontmost itself; any other opens
     * under the id it was given, as the window it copies shows, or on the
     * Space and tab it was opened for.
     */
    async open(workspaceId: Guid, launch: () => Promise<{ windowIds: readonly Guid[]; startupWindowId: Guid }>): Promise<void> {
        const { windowId, copyingWindowId, spaceId, tabId, fromWindowId, url } = this.opening;
        if (windowId === null) {
            const plan = await launch();
            this.id = plan.startupWindowId;
            // The pages of the windows the launch reopens start showing; the
            // core keeps that until they settle, so the next launch knows if
            // this one ended while they opened.
            await this.send({ kind: "BeginReopeningPages", value: {} });
            setTimeout(() => void this.send({ kind: "FinishReopeningPages", value: {} }), reopenedPagesSettle);
            for (const id of plan.windowIds) {
                if (id !== this.id) openWindow("browser", id, { window: id }, false);
            }
        }
        const moving = tabId !== null && spaceId !== null;
        await dispatch({
            kind: "OpenWindow",
            value: {
                windowId: this.id,
                workspaceId,
                saved: true,
                copyingWindowId,
                showingSpaceId: spaceId,
                showingTabs: moving ? [{ spaceId, tabId }] : [],
                restoresTabs: !moving,
            },
        });
        adoptWindow(this.id);
        // Move to New Window: the tab leaves the window it came from.
        if (moving && fromWindowId) {
            await this.send({
                kind: "MoveTabToWindow",
                value: { workspaceId, windowId: fromWindowId, spaceId, tabId, destinationWindowId: this.id },
            });
        }
        if (url && spaceId) await this.openLink(url, spaceId);
    }

    /** Follows the core: the window's title is what its shown tab shows, as BrowserWindowTitle names it. */
    follow(_changes: readonly Change[]): void {
        const tab = this.context.tab();
        const page = tab ? this.context.model.pageFor(tab.id) : undefined;
        const title = page?.live.title || tab?.displayTitle || "Crest";
        if (title === this.title) return;
        this.title = title;
        setWindowTitle(title);
    }

    /** New Window: a window that starts as this one shows, in front. */
    openNewWindow(): void {
        const id = crypto.randomUUID();
        openWindow("browser", id, { window: id, copying: this.id }, true);
    }

    /** New Quick Window: an empty Quick Window in the Space this window shows, which promotes into this window. */
    openQuickWindow(): void {
        const space = this.context.space();
        if (space) openWindow("quick", null, { target: this.id, space: space.state.id }, true);
    }

    /** Close Window: asks this window first, as the person's close does. */
    close(): void {
        requestClose();
    }

    /** The other browser windows open now, each named by the tab it shows, for Move to Window. */
    otherWindows(): { readonly windowId: Guid; readonly title: string }[] {
        const workspace = this.context.workspace();
        return [...this.context.model.windows.values()]
            .filter((window) => window.id !== this.id && window.workspaceId === workspace?.id)
            .map((window) => {
                const space = workspace?.spaces.get(window.shownSpaceId);
                const tabId = window.shownTabs.find((shown) => shown.spaceId === window.shownSpaceId)?.tabId;
                const tab = tabId ? space?.tabs.find((held) => held.id === tabId) : undefined;
                return { windowId: window.id, title: tab?.displayTitle || space?.state.settings.name || "Window" };
            });
    }

    /**
     * Moves a tab of the Space `spaceId` to the window `destination`, which
     * shows it and comes forward, as dropping a tab on another window does;
     * with none, to a new window that opens on it.
     */
    async moveTab(spaceId: Guid, tabId: Guid, destination: Guid | null): Promise<void> {
        const workspace = this.context.workspace();
        if (!workspace) return;
        if (destination === null) {
            const id = crypto.randomUUID();
            openWindow("browser", id, { window: id, space: spaceId, tab: tabId, from: this.id }, true);
            return;
        }
        const moved = await this.send({
            kind: "MoveTabToWindow",
            value: { workspaceId: workspace.id, windowId: this.id, spaceId, tabId, destinationWindowId: destination },
        });
        if (moved) presentWindow(destination);
    }

    /** The person used the window: the shell makes it the one in use, which it then hears. */
    private used(): void {
        if (!this.active) useThisWindow();
    }

    /** The person came to the window, or left it: in use, it shows every page it shows a tab of. */
    private activeChanged(active: boolean): void {
        this.active = active;
        if (!active || this.left.size === 0) return;
        this.left.clear();
        this.context.relayout();
    }

    /**
     * The window shows a page another window's part of the engine keeps: the
     * core and the engine move it here, keeping its history and renderer, as
     * the Mac moves a page into the window that shows it.
     */
    private async claim(pageId: Guid): Promise<void> {
        const page = this.context.model.pages.get(pageId);
        if (!page || this.claiming.has(pageId)) return;
        this.claiming.add(pageId);
        try {
            const moved = await this.send({
                kind: "MovePage",
                value: { pageId, workspaceId: page.workspaceId, spaceId: page.spaceId, tabId: page.tabId, windowId: this.id },
            });
            if (moved) await pageRequest("MovePageToWindow", { pageId, windowId: this.id });
        } catch (error) {
            this.context.report(error);
        } finally {
            this.claiming.delete(pageId);
            // A page that moved between the engine's windows shows where its card is.
            this.context.relayout();
        }
    }

    /**
     * The person closed the window. The core forgets it for the next launch;
     * the last browser window's close quits instead, which keeps the windows
     * open now for the next launch, as a quit the core allowed does.
     */
    private async closeAsked(last: boolean): Promise<void> {
        try {
            if (last) await dispatch({ kind: "RememberWindowsForLaunch", value: { windowIds: await stackedWindows() } });
            else await dispatch({ kind: "CloseWindow", value: { windowId: this.id } });
        } catch (error) {
            console.error(error);
        }
        closeWindow();
    }

    /**
     * Opens links another app handed Crest where the core routes each, as the
     * Mac's BrowserMacExternalOpening: a Quick Window alone, over the window
     * the core names or none, or a new tab in the window the core names,
     * which opens when it is not open yet.
     */
    private async openExternal(urls: readonly string[]): Promise<void> {
        for (const url of urls) {
            try {
                const placement = await query("RouteExternalLink", { windowIds: await stackedWindows(), url });
                const { spaceId, windowId } = placement;
                if (!spaceId) continue;
                if (placement.opensQuickWindow) {
                    const target = placement.opensWindow ? null : windowId;
                    openWindow("quick", null, { ...(target ? { target } : {}), space: spaceId, url }, true);
                } else if (windowId && placement.opensWindow) {
                    openWindow("browser", windowId, { window: windowId, space: spaceId, url }, true);
                } else if (windowId === this.id) {
                    await this.openLink(url, spaceId);
                } else if (windowId) {
                    // The window the core names opens the tab; this one asks the core for it.
                    await this.openLink(url, spaceId, windowId);
                    presentWindow(windowId);
                }
            } catch (error) {
                this.context.report(error);
            }
        }
    }

    /** Opens `url` in a new tab of `spaceId`, after the tab the window shows there, which the window shows. */
    private async openLink(url: string, spaceId: Guid, windowId: Guid = this.id): Promise<void> {
        const workspace = this.context.workspace();
        if (!workspace) return;
        await this.send({
            kind: "OpenTab",
            value: {
                workspaceId: workspace.id,
                windowId,
                spaceId,
                tabId: crypto.randomUUID(),
                content: { address: url, view: null, title: null },
                placement: "Current",
                afterTabId: null,
                shows: true,
            },
        });
    }

    /** Sends an intent; false when the core refused it, which is reported unless the window simply is not open. */
    private async send(intent: Intent): Promise<boolean> {
        try {
            await dispatch(intent);
            return true;
        } catch (error) {
            if (!(error instanceof Refused && error.rejection.kind === "WindowNotOpen")) this.context.report(error);
            return false;
        }
    }
}
