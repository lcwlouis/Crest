// Crest's sidebar on Linux. It opens the person's session and a window over
// it, as the Mac app does at launch, then draws the shown Space's tabs and
// shows the selected tab's page beside the sidebar.

import {
    connect,
    decodePresentation,
    dispatch,
    listenToFloat,
    pageRequest,
    query,
    Refused,
    registerShortcuts,
    setPageBounds,
    showPage,
} from "./bridge.js";
import { Commands, shortcutTable } from "./commands.js";
import { FindBar } from "./find.js";
import type { FloatEvent } from "./float.js";
import { NavigationError, ShortcutCommand } from "../generated/crest_contracts.js";
import { Palette } from "./palette.js";
import { Prompts } from "./prompts.js";
import { FloatSurfaces } from "./surfaces.js";
import { TabIcons } from "./icons.js";
import type { Guid, Intent, LaunchEnvironment, PageState, TabState } from "../generated/crest_contracts.js";
import { Model } from "./model.js";
import { PageStates } from "./page-states.js";
import type { Space, Workspace } from "./model.js";
import { InlineRename } from "./rename.js";
import { element, Sidebar, symbol } from "./sidebar.js";
import { SidebarMenus } from "./sidebar-menus.js";
import { SpaceActions } from "./space-actions.js";
import { SpaceEditor } from "./space-editor.js";
import { DownloadDestinations } from "./download-destinations.js";
import { SitePermissionSessions } from "./site-permissions.js";
import { Utilities } from "./utilities.js";

const model = new Model();
/** Each page's side of the site permission choices: its engine and its blocked pop-ups. */
const sitePermissions = new SitePermissionSessions(model);
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

function shownTab(): TabState | undefined {
    const tabId = shownTabId();
    return tabId ? shownSpace()?.tabs.find((tab) => tab.id === tabId) : undefined;
}

function shownTabId(): Guid | null {
    const window = model.windows.get(windowId);
    return window?.shownTabs.find((shown) => shown.spaceId === window.shownSpaceId)?.tabId ?? null;
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
// The address field shows where the page is; clicking it opens the command
// bar over the shown tab, as the Mac's address field grows into it.
const address = element("button", "address");
address.addEventListener("click", () => palette.open("current", address.dataset.url ?? ""));
root.append(navigation, address);
const rename = new InlineRename(() => render());
const sendChecked = (intent: Intent): Promise<boolean> =>
    dispatch(intent).then(
        () => true,
        (error: unknown) => (report(error), false),
    );
const utilities = new Utilities({
    model,
    imageOf: (tabId) => icons.imageOf(tabId),
    windowId: () => windowId,
    space: shownSpace,
    workspace: () => model.workspace,
    send: sendChecked,
    redraw: () => render(),
});
const spaces = new SpaceActions({
    model,
    windowId: () => windowId,
    send: sendChecked,
    edit: (spaceId, intent) => spaceEditor.open(spaceId, intent),
});
const spaceEditor = new SpaceEditor({ model, actions: spaces });
const downloadDestinations = new DownloadDestinations((intent) => dispatch(intent).catch((error: unknown) => console.error(error)));
const sidebar = new Sidebar(
    {
        model,
        icons,
        windowId: () => windowId,
        shownTabId,
        send: (intent) => void dispatch(intent).catch(report),
        openNewTab: () => palette.open("newTab"),
        menus: new SidebarMenus({
            model,
            icons,
            rename,
            windowId: () => windowId,
            shownTabId,
            send: sendChecked,
            report,
            perform: (command) => void commands.perform(command),
        }),
        rename,
        utilities,
        spaces,
    },
    root,
);

const commands = new Commands({
    model,
    windowId: () => windowId,
    workspace: () => model.workspace,
    space: shownSpace,
    tab: shownTab,
    page: shownPage,
    send: (intent) => void dispatch(intent).catch(report),
    report,
    openPalette: (mode) => palette.open(mode, mode === "current" ? (address.dataset.url ?? "") : ""),
    find: (action) => (action === "open" ? findBar.open() : findBar.step(action === "previous")),
    toggleUtility: (surface) => utilities.toggleSurface(surface),
});

// The surfaces floating over the page.
const surfaces = new FloatSurfaces();
const findBar = new FindBar(shownPage, report, surfaces);
const prompts = new Prompts({ model, page: shownPage }, surfaces);
const pageStates = new PageStates({ model, tab: shownTab, page: shownPage, report }, surfaces);
listenToFloat(
    (event) => {
        const floatEvent = event as FloatEvent;
        // A key the floating view passed on is the window's, as one the page left.
        if (floatEvent.kind === "key") commands.handleKey(floatEvent);
        else surfaces.handle(floatEvent);
    },
    () => surfaces.restore(),
);

const palette = new Palette({
    icons,
    commands,
    windowId: () => windowId,
    workspace: () => model.workspace,
    space: shownSpace,
    tab: shownTab,
    page: shownPage,
    send: (intent) => void dispatch(intent).catch(report),
    report,
});

// The Start Page, which Crest draws in the page's card for a tab that shows
// it (and when the window shows no tab), as the Mac's BrowserStartPage: the
// mark, its title and a command bar embedded in the page.
const startPage = element("div", "start-page");
const startMark = element("div", "start-mark");
startMark.innerHTML =
    '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4l24 9v17c0 15-10 26-24 30C18 56 8 45 8 30V13z" fill="var(--space-tint)"/><path d="M32 16l4 9 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" fill="white" opacity="0.9"/></svg>';
startPage.append(startMark, element("h1", "start-title", "Start Page"));
const startBar = element("div", "start-bar");
startPage.append(startBar);
startPage.hidden = true;
document.getElementById("page")!.append(startPage);
const startPalette = new Palette(
    {
        icons,
        commands,
        windowId: () => windowId,
        workspace: () => model.workspace,
        space: shownSpace,
        tab: shownTab,
        page: shownPage,
        send: (intent) => void dispatch(intent).catch(report),
        report,
    },
    startBar,
);

// A page that failed to load shows Crest's own explanation in the card, as
// the Mac's BrowserNavigationFailureView, over the page it hides.
const failureView = element("div", "failure");
failureView.hidden = true;
document.getElementById("page")!.append(failureView);

function showFailure(page: PageState | undefined): void {
    const failure = page?.live.failure ?? null;
    failureView.hidden = !page || !failure;
    if (!page || !failure) return;
    const facts = NavigationError.facts[failure.error];
    let host = failure.url ?? page.live.url ?? "";
    try {
        host = new URL(host).host || host;
    } catch {
        // The address stays as the engine gave it.
    }
    const key = `${page.id}:${failure.error}:${host}`;
    if (failureView.dataset.key === key) return;
    failureView.dataset.key = key;
    const retry = element("button", "failure-button prominent", "Try Again");
    retry.addEventListener("click", () =>
        void pageRequest("ReloadPage", { pageId: page.id, bypassesCache: false }).catch(report),
    );
    const actions = element("div", "failure-actions");
    if (page.live.canGoBack) {
        const back = element("button", "failure-button", "Go Back");
        back.addEventListener("click", () => void dispatch({ kind: "StepHistory", value: { pageId: page.id, offset: -1 } }).catch(report));
        actions.append(back);
    }
    actions.append(retry);
    failureView.replaceChildren(
        element("h1", "failure-title", facts.title.text),
        element("p", "failure-message", facts.message.text.replace("%@", host)),
        element("p", "failure-suggestion", facts.primarySuggestion.text),
        element("p", "failure-suggestion", facts.secondarySuggestion.text),
        actions,
        element("p", "failure-code", facts.code),
    );
}

function showStartPage(shown: boolean): void {
    if (startPage.hidden !== shown) return;
    startPage.hidden = !shown;
    if (shown) startPalette.open("current");
}

// Crest's keys, while the window's own UI has the focus. The page's view
// hands Crest the keys it reserves from pages through the host.
document.addEventListener("keydown", (event) => {
    if (palette.isOpen || event.defaultPrevented) return;
    if (commands.handleKey(event)) event.preventDefault();
});
registerShortcuts(
    shortcutTable(commands),
    (key) => {
        if (palette.isOpen) palette.close();
        commands.handleKey(key);
    },
    (command) => {
        if (ShortcutCommand.all.includes(command as ShortcutCommand)) commands.perform(command as ShortcutCommand);
    },
);

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
    showAddress(page);
    // The list's search field stands in the address field's place, as on the Mac.
    address.hidden = utilities.isOpen;
    sidebar.render();
}

/**
 * The address field shows the page's host at rest, as the Mac's address
 * display does, and the whole address once the person starts editing.
 */
function showAddress(page: PageState | undefined): void {
    const url = page?.live.address ?? page?.live.url ?? null;
    address.dataset.url = url ?? "";
    address.classList.toggle("loading", page?.live.isLoading ?? false);
    let host = "";
    try {
        host = url ? new URL(url).host || url : "";
    } catch {
        host = url ?? "";
    }
    address.textContent = host.replace(/^www\./, "") || "Search or enter address";
    address.classList.toggle("empty", host.length === 0);
    address.title = url ?? "";
}

/** Tabs this window asked the core to open a page for, until the page appears. */
const opening = new Set<Guid>();

/**
 * Gives the selected tab a page and shows it once the engine made it live.
 * The window asks the core for the page, as the Mac's window does when it
 * shows a tab that has none; the core asks the engine to create it.
 */
function followShownPage(): void {
    followShownPageView();
    // The card is see-through only while the window shows a page under it.
    document.body.classList.toggle("has-page", shownPageId !== null);
}

function followShownPageView(): void {
    const workspace = model.workspace;
    const space = shownSpace();
    const tabId = shownTabId();
    const tab = tabId ? space?.tabs.find((held) => held.id === tabId) : undefined;
    if (!workspace || !space) return;
    const page = tab ? model.pageFor(tab.id) : undefined;
    // A tab with no page of its own, or no tab: the card shows Crest's own
    // view, and the window shows no page over it.
    const showsNoPage = !tab || (!page && tab.surface === "StartPage");
    showStartPage(showsNoPage && (!tab || tab.surface === "StartPage"));
    const failed = page?.live.failure != null;
    showFailure(failed ? page : undefined);
    if (!page || page.phase !== "Live" || failed) {
        if (shownPageId !== null && (showsNoPage || failed || model.pages.get(shownPageId)?.tabId !== tab?.id)) {
            shownPageId = null;
            showPage("");
        }
    }
    if (!tab) return;
    if (!page) {
        // TODO(linux): other native views (settings, history) are drawn
        // with the surfaces they belong to.
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
    if (page.phase !== "Live" || failed || page.id === shownPageId) return;
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
            findBar.follow();
            prompts.apply(changes);
            sitePermissions.apply(changes);
            pageStates.apply(changes);
            downloadDestinations.apply(changes);
            spaces.apply(changes);
            spaceEditor.follow();
        },
        (bytes) => {
            try {
                const presentation = decodePresentation(bytes);
                if (presentation.kind === "FindFinished") findBar.finished(presentation.value);
                pageStates.present(presentation);
                sitePermissions.present(presentation);
            } catch (error) {
                console.error(error);
            }
        },
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
