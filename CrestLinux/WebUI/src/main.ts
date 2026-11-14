// Crest's sidebar on Linux. It opens the person's session and a window over
// it, as the Mac app does at launch, then draws the shown Space's tabs and
// shows the selected tab's page beside the sidebar.

import { connect, dispatch, pageRequest, query, Refused, setPageBounds, showPage } from "./bridge.js";
import { TabIcons } from "./icons.js";
import type { Guid, LaunchEnvironment, PageState, TabState } from "../generated/crest_contracts.js";
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

/** The page the window shows, if the engine has one for the shown tab. */
function shownPage(): PageState | undefined {
    const tabId = shownTabId();
    return tabId ? model.pageFor(tabId) : undefined;
}

const icon = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    forward: '<path d="M9 18l6-6-6-6"/>',
    reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    stop: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
};

function symbol(paths: string): string {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function control(label: string, act: () => void): HTMLButtonElement {
    const button = element("button", "nav-control");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", act);
    return button;
}

// The sidebar's top: the navigation controls and the address field, which
// stay in place while the tabs below draw again, so typing is never lost.
const navigation = element("div", "nav");
const back = control("Back", () => step(-1));
const forward = control("Forward", () => step(1));
const reload = control("Reload", () => reloadOrStop());
back.innerHTML = symbol(icon.back);
forward.innerHTML = symbol(icon.forward);
navigation.append(back, forward, reload);
const spaceName = element("div", "space-name");
const address = element("input", "address");
address.placeholder = "Search or enter address";
address.spellcheck = false;
address.addEventListener("keydown", (event) => {
    const space = shownSpace();
    const workspace = model.workspace;
    if (event.key !== "Enter" || !space || !workspace || address.value.trim().length === 0) return;
    const text = address.value.trim();
    address.value = "";
    address.blur();
    void openAddress(workspace.id, space.state.id, text).catch(report);
});
const list = element("div", "tabs");
const switcher = element("div", "spaces");
root.append(navigation, address, list, switcher);

/** Steps the shown page through its history, as the Mac's back and forward controls do. */
function step(offset: number): void {
    const page = shownPage();
    if (page) void dispatch({ kind: "StepHistory", value: { pageId: page.id, offset } }).catch(report);
}

function reloadOrStop(): void {
    const page = shownPage();
    if (!page) return;
    const request = page.live.isLoading
        ? pageRequest("StopLoading", { pageId: page.id })
        : pageRequest("ReloadPage", { pageId: page.id, bypassesCache: false });
    void request.catch(report);
}

function render(): void {
    const workspace = model.workspace;
    const space = shownSpace();
    root.hidden = !workspace || !space;
    if (!workspace || !space) return;
    const selected = shownTabId();
    const page = shownPage();

    back.disabled = !page?.live.canGoBack;
    forward.disabled = !page?.live.canGoForward;
    reload.disabled = !page;
    const loading = page?.live.isLoading ?? false;
    if (reload.dataset.loading !== String(loading)) {
        reload.dataset.loading = String(loading);
        reload.innerHTML = symbol(loading ? icon.stop : icon.reload);
        reload.title = loading ? "Stop" : "Reload";
    }
    spaceName.textContent = space.state.settings.name;

    list.replaceChildren();
    const pinned = space.tabs.filter((tab) => tab.placement === "Pinned");
    if (pinned.length > 0) {
        const grid = element("div", "pinned");
        for (const tab of pinned) grid.append(tabRow(space, tab, tab.id === selected));
        list.append(grid);
    }
    list.append(spaceName);
    const saved = space.tabs.filter((tab) => tab.placement === "Saved");
    for (const tab of saved) list.append(tabRow(space, tab, tab.id === selected));
    list.append(element("div", "divider"));
    for (const tab of space.tabs.filter((tab) => tab.placement === "Current")) {
        list.append(tabRow(space, tab, tab.id === selected));
    }

    switcher.replaceChildren();
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
