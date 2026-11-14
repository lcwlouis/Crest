// Crest's sidebar on Linux. It opens the person's session and a window over
// it, as the Mac app does at launch, then draws the shown Space's tabs and
// shows the selected tab's page beside the sidebar.

import { connect, dispatch, query, Refused, setPageBounds, showPage } from "./bridge.js";
import { TabIcons } from "./icons.js";
import type { Guid, LaunchEnvironment, TabState } from "../generated/crest_contracts.js";
import { Model } from "./model.js";
import type { Space, Workspace } from "./model.js";

const model = new Model();
const icons = new TabIcons(() => render());
/** The window this sidebar draws: the saved window the launch reopens, once known. */
let windowId: Guid = crypto.randomUUID();
let shownPageId: Guid | null = null;

const root = document.getElementById("sidebar")!;
const status = document.getElementById("status")!;

function say(text: string): void {
    status.textContent = text;
    status.hidden = text.length === 0;
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Opens the session the core keeps, or on a first launch the core's own first session. */
async function openSession(): Promise<Guid> {
    const open = model.workspace;
    if (open) return open.id;
    try {
        await dispatch({ kind: "OpenWorkspace", value: { kind: "Persistent", seed: null } });
    } catch (error) {
        if (!(error instanceof Refused) || error.rejection.kind !== "NoStoredSession") throw error;
        // The file holds no session yet: the core gives it the one a first
        // launch starts with, as the Mac's first launch does with nothing to
        // carry over, and the workspace opens from the file, which keeps it.
        await dispatch({
            kind: "AdoptLegacySession",
            value: { installed: { core: null, wholeGraph: null, history: [], journal: null }, seed: null },
        });
        await dispatch({ kind: "OpenWorkspace", value: { kind: "Persistent", seed: null } });
    }
    // Read again: the dispatches above changed the model.
    const opened: Workspace | undefined = model.workspaces.values().next().value;
    if (!opened) throw new Error("The core opened no workspace.");
    return opened.id;
}

function shownSpace(): Space | undefined {
    const window = model.windows.get(windowId);
    return window ? model.workspace?.spaces.get(window.shownSpaceId) : undefined;
}

function shownTabId(): Guid | null {
    const window = model.windows.get(windowId);
    return window?.shownTabs.find((shown) => shown.spaceId === window.shownSpaceId)?.tabId ?? null;
}

function tabRow(space: Space, tab: TabState, selected: boolean): HTMLElement {
    const row = element("button", selected ? "tab selected" : "tab");
    const icon = element("span", "tab-icon");
    const image = icons.imageOf(tab.id);
    if (image) {
        const img = element("img", "");
        img.src = image;
        img.alt = "";
        icon.append(img);
    } else {
        icon.textContent = (tab.displayTitle || "?").slice(0, 1).toUpperCase();
    }
    row.append(icon, element("span", "tab-title", tab.displayTitle || tab.url || "New Tab"));
    row.title = tab.url ?? tab.displayTitle;
    row.addEventListener("click", () => {
        void dispatch({ kind: "ShowTab", value: { windowId, spaceId: space.state.id, tabId: tab.id } }).catch(report);
    });
    return row;
}

/** Opens what the person typed in a new tab, as the core reads it. */
async function openAddress(workspaceId: Guid, spaceId: Guid, input: string): Promise<void> {
    const resolved = await query("ResolveAddress", { workspaceId, spaceId, input });
    // TODO(linux): searches go through the Space's search provider, as the
    // Mac's command bar sends them.
    const url = resolved.url ?? `https://duckduckgo.com/?q=${encodeURIComponent(resolved.searchQuery ?? input)}`;
    await dispatch({
        kind: "OpenTab",
        value: {
            workspaceId,
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

function render(): void {
    root.replaceChildren();
    const workspace = model.workspace;
    const space = shownSpace();
    if (!workspace || !space) return;
    const selected = shownTabId();

    root.append(element("div", "space-name", space.state.settings.name));

    const address = element("input", "address");
    address.placeholder = "Search or enter address";
    address.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || address.value.trim().length === 0) return;
        const text = address.value.trim();
        address.value = "";
        void openAddress(workspace.id, space.state.id, text).catch(report);
    });
    root.append(address);

    const pinned = space.tabs.filter((tab) => tab.placement === "Pinned");
    if (pinned.length > 0) {
        const grid = element("div", "pinned");
        for (const tab of pinned) grid.append(tabRow(space, tab, tab.id === selected));
        root.append(grid);
    }
    const saved = space.tabs.filter((tab) => tab.placement === "Saved");
    for (const tab of saved) root.append(tabRow(space, tab, tab.id === selected));
    root.append(element("div", "divider"));
    for (const tab of space.tabs.filter((tab) => tab.placement === "Current")) {
        root.append(tabRow(space, tab, tab.id === selected));
    }

    const switcher = element("div", "spaces");
    for (const id of workspace.order) {
        const other = workspace.spaces.get(id);
        if (!other) continue;
        const dot = element("button", id === space.state.id ? "space shown" : "space");
        dot.textContent = other.state.settings.name.slice(0, 1).toUpperCase();
        dot.title = other.state.settings.name;
        dot.addEventListener("click", () => {
            void dispatch({ kind: "ShowSpace", value: { windowId, spaceId: id } }).catch(report);
        });
        switcher.append(dot);
    }
    root.append(switcher);
}

/** Tabs this window asked the core to open a page for, until the page appears. */
const opening = new Set<Guid>();

/**
 * Gives the selected tab a page and shows it once the engine made it live.
 * The window asks the core for the page, as the Mac's window does when it
 * shows a tab that has none; the core asks the engine to create it.
 */
function followShownPage(): void {
    const workspace = model.workspace;
    const space = shownSpace();
    const tabId = shownTabId();
    const tab = tabId ? space?.tabs.find((held) => held.id === tabId) : undefined;
    if (!workspace || !space || !tab) return;
    const page = model.pageFor(tab.id);
    if (!page) {
        // TODO(linux): a tab with native content (the start page) shows a
        // view Crest draws itself, which the Linux window does not draw yet.
        if (tab.nativeContent || opening.has(tab.id)) return;
        opening.add(tab.id);
        const pageId = crypto.randomUUID();
        void dispatch({
            kind: "OpenPage",
            value: {
                pageId,
                workspaceId: workspace.id,
                spaceId: space.state.id,
                tabId: tab.id,
                windowId,
                transient: null,
                openerPageId: null,
            },
        })
            // A new page starts at its tab's address, which the window asks
            // the core to load, as the Mac's page pool does.
            // TODO(linux): restore the tab's archived history first, as the
            // Mac does, when the tab has one.
            .then(() => (tab.url ? dispatch({ kind: "LoadAddress", value: { pageId, url: tab.url } }) : undefined))
            .catch(report)
            .finally(() => opening.delete(tab.id));
        return;
    }
    if (page.phase !== "Live" || page.id === shownPageId) return;
    shownPageId = page.id;
    showPage(page.id);
}

function report(error: unknown): void {
    console.error(error);
    say(error instanceof Refused ? `Crest refused: ${error.rejection.kind}` : String(error));
}

const launchEnvironment: LaunchEnvironment = {
    isTestRuntime: false,
    isPreviewRuntime: false,
    requestsIsolatedSession: false,
    hasNamedProfile: false,
    requestsIsolatedCloudSync: false,
    resetsSession: false,
    presentsShowcase: false,
    presentsSubSpaces: false,
    usesInMemoryCredentials: false,
    forcesOnboardingWelcome: false,
    forcesDesktopSetup: false,
    forcesMobileSetup: false,
    usesUpdateTestFeed: false,
};

async function start(): Promise<void> {
    await connect(
        (changes) => {
            model.apply(changes);
            icons.apply(changes);
            render();
            followShownPage();
        },
        () => {},
    );
    const workspaceId = await openSession();
    // The launch reopens the window the person left, with the Space and tabs
    // it showed, as the Mac's launch does.
    // TODO(linux): reopen every saved window, and run the setup the plan
    // names, once the Linux shell draws more than one window and onboarding.
    const plan = await query("LaunchWindows", { environment: launchEnvironment });
    windowId = plan.startupWindowId;
    await dispatch({
        kind: "OpenWindow",
        value: {
            windowId,
            workspaceId,
            saved: true,
            copyingWindowId: null,
            showingSpaceId: null,
            showingTabs: [],
            restoresTabs: true,
        },
    });
    say("");
}

/**
 * Tells the window where the page goes: over the page's card, which the
 * WebUI lays out. The window places the page's own view there.
 */
function followPageCard(): void {
    const card = document.getElementById("page")!;
    const send = (): void => {
        const box = card.getBoundingClientRect();
        setPageBounds(Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height));
    };
    new ResizeObserver(send).observe(card);
    window.addEventListener("resize", send);
    send();
}

followPageCard();
start().catch(report);
