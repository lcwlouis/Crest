// Crest's sidebar on Linux. It opens the person's session and a window over
// it, as the Mac app does at launch, then draws the shown Space's tabs and
// shows the selected tab's page beside the sidebar, the cards of the split it
// belongs to beside it, and a Peek over them. Each browser window runs its
// own copy of this page, as the core's window its address names.

import {
    connect,
    decodePresentation,
    dispatch,
    listenToFloat,
    openWindow,
    pageRequest,
    query,
    Refused,
    registerShortcuts,
    relayoutInspector,
    updateShortcuts,
} from "./bridge.js";
import { Commands, shortcutTable, useShortcutBindings } from "./commands.js";
import { FindBar } from "./find.js";
import type { FloatEvent } from "./float.js";
import { NavigationError, ShortcutCommand } from "../generated/crest_contracts.js";
import { Palette } from "./palette.js";
import { Prompts } from "./prompts.js";
import { FloatSurfaces } from "./surfaces.js";
import { TabIcons } from "./icons.js";
import type { Change, Guid, Intent, LaunchEnvironment, PageState, TabState } from "../generated/crest_contracts.js";
import { Model } from "./model.js";
import { Onboarding } from "./onboarding.js";
import { CredentialPrompts } from "./credential-prompts.js";
import { PageStates } from "./page-states.js";
import { WebNotifications } from "./notifications.js";
import type { Space, Workspace } from "./model.js";
import { InlineRename } from "./rename.js";
import { element, Sidebar, symbol } from "./sidebar.js";
import { SidebarMenus } from "./sidebar-menus.js";
import { SpaceActions } from "./space-actions.js";
import { SpaceEditor } from "./space-editor.js";
import { DownloadDestinations } from "./download-destinations.js";
import { PageCards } from "./page-cards.js";
import { Peek } from "./peek.js";
import { Utilities } from "./utilities.js";
import { Windows } from "./windows.js";
import { applyDeviceAppearance } from "./device-appearance.js";
import { Preferences } from "./preferences.js";
import { isSettingsKey, Settings, settingsShortcut } from "./settings.js";
import { settingsPages, spaceSectionPages } from "./settings-pages.js";

const model = new Model();
const preferences = new Preferences();
applyDeviceAppearance();
const icons = new TabIcons(() => render());
/** This browser window among Crest's: the core's window it draws, and the windows it opens. */
const windows = new Windows({
    model,
    workspace: () => model.workspace,
    space: shownSpace,
    tab: shownTab,
    report,
    relayout: () => pageCards.layout(),
    pageLeft: (pageId) => pageStates.pageLeft(pageId),
});

/** Setup, which the launch shows over this window before it opens, when the core says it is due. */
const onboarding = new Onboarding({ model });
/** Whether this launch found no session stored, as a first launch does. */
let isFirstLaunch = false;
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
        isFirstLaunch = true;
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
    const window = model.windows.get(windows.windowId);
    return window ? model.workspace?.spaces.get(window.shownSpaceId) : undefined;
}

function shownTab(): TabState | undefined {
    const tabId = shownTabId();
    return tabId ? shownSpace()?.tabs.find((tab) => tab.id === tabId) : undefined;
}

function shownTabId(): Guid | null {
    const window = model.windows.get(windows.windowId);
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
    windowId: () => windows.windowId,
    space: shownSpace,
    workspace: () => model.workspace,
    send: sendChecked,
    redraw: () => render(),
});
const spaces = new SpaceActions({
    model,
    windowId: () => windows.windowId,
    send: sendChecked,
    edit: (spaceId, intent) => settings.openSpace(spaceId, intent),
});
const spaceEditor = new SpaceEditor({ model, actions: spaces });
const settings = new Settings(
    {
        model,
        preferences,
        windowId: () => windows.windowId,
        space: shownSpace,
        tab: shownTab,
        spaces,
        spaceEditor,
        pages: settingsPages,
        spaceSections: spaceSectionPages,
    },
    document.getElementById("page")!,
);
const downloadDestinations = new DownloadDestinations((intent) => dispatch(intent).catch((error: unknown) => console.error(error)));
const sidebar = new Sidebar(
    {
        model,
        icons,
        windowId: () => windows.windowId,
        shownTabId,
        send: (intent) => void dispatch(intent).catch(report),
        openNewTab: () => palette.open("newTab"),
        menus: new SidebarMenus({
            model,
            icons,
            rename,
            windowId: () => windows.windowId,
            shownTabId,
            send: sendChecked,
            report,
            perform: (command) => void commands.perform(command),
            openSettings: () => settings.open(),
            windows,
        }),
        rename,
        utilities,
        spaces,
    },
    root,
);

const commands = new Commands({
    model,
    windowId: () => windows.windowId,
    workspace: () => model.workspace,
    space: shownSpace,
    tab: shownTab,
    page: shownPage,
    send: (intent) => void dispatch(intent).catch(report),
    report,
    openPalette: (mode) => palette.open(mode, mode === "current" ? (address.dataset.url ?? "") : ""),
    find: (action) => (action === "open" ? findBar.open() : findBar.step(action === "previous")),
    toggleUtility: (surface) => utilities.toggleSurface(surface),
    cards: () => pageCards.shownCards(),
    peek: {
        get isOpen() {
            return peek.isOpen;
        },
        close: () => peek.close(),
    },
    windows,
});

// The page cards: the shown tab's, or its split's side by side, with a Peek
// over them.
const pageCards: PageCards = new PageCards({
    model,
    windowId: () => windows.windowId,
    workspace: () => model.workspace,
    space: shownSpace,
    shownTabId,
    send: sendChecked,
    report,
    peek: () => peek.placement(),
    shows: (pageId) => windows.shows(pageId),
});
const peek: Peek = new Peek({
    model,
    windowId: () => windows.windowId,
    workspace: () => model.workspace,
    shownCards: () => pageCards.shownCards(),
    report,
    relayout: () => pageCards.layout(),
    shortcutsChanged: () => updateShortcuts(windowShortcuts()),
});

/**
 * The keys the window takes for Crest while a page has the keyboard: the
 * commands', and while a Peek shows, Escape and Ctrl+O, which close and keep
 * it before its page sees them.
 */
function windowShortcuts(): [string, boolean, boolean, boolean, number, boolean][] {
    const table = [...shortcutTable(commands), settingsShortcut];
    if (peek.isOpen) table.push(["Escape", false, false, false, -1, true], ["o", true, false, false, 0, true]);
    return table;
}

// The surfaces floating over the page.
const surfaces = new FloatSurfaces();
const findBar = new FindBar(shownPage, report, surfaces);
const prompts = new Prompts({ model, page: shownPage }, surfaces);
const pageStates = new PageStates({ model, tab: shownTab, page: shownPage, report }, surfaces);
const webNotifications = new WebNotifications({
    model,
    windowId: () => windows.windowId,
    send: (intent) => void dispatch(intent).catch(report),
    report,
});
const credentialPrompts = new CredentialPrompts({ model, page: shownPage, zoom: (pageId) => commands.zoomOf(pageId) }, surfaces);
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
    windowId: () => windows.windowId,
    workspace: () => model.workspace,
    space: shownSpace,
    tab: shownTab,
    page: shownPage,
    send: (intent) => void dispatch(intent).catch(report),
    report,
    openSettings: (name) => settings.openPage(name),
});

// The Start Page, which Crest draws in the page's card for a tab that shows
// it (and when the window shows no tab), as the Mac's BrowserStartPage: the
// mark, its title and a command bar embedded in the page.
const startPage = element("div", "start-page card-content");
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
        windowId: () => windows.windowId,
        workspace: () => model.workspace,
        space: shownSpace,
        tab: shownTab,
        page: shownPage,
        send: (intent) => void dispatch(intent).catch(report),
        report,
        openSettings: (name) => settings.openPage(name),
    },
    startBar,
);

// A page that failed to load shows Crest's own explanation in the card, as
// the Mac's BrowserNavigationFailureView, over the page it hides.
const failureView = element("div", "failure card-content");
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
    if (onboarding.isOpen || palette.isOpen || event.defaultPrevented) return;
    if (isSettingsKey(event)) {
        event.preventDefault();
        settings.open();
    } else if (peek.handleKey(event) || commands.handleKey(event)) event.preventDefault();
});
registerShortcuts(
    windowShortcuts(),
    (key) => {
        if (onboarding.isOpen) return;
        if (palette.isOpen) palette.close();
        if (isSettingsKey(key)) settings.open();
        else if (!peek.handleKey(key)) commands.handleKey(key);
    },
    (command) => {
        if (onboarding.isOpen) return;
        if (ShortcutCommand.all.includes(command as ShortcutCommand)) commands.perform(command as ShortcutCommand);
    },
);

// The person's own keys, once the core publishes them, replace the defaults.
let appliedBindings: readonly unknown[] | null = null;
preferences.listen(() => {
    const bindings = preferences.shortcuts?.bindings;
    if (!bindings || bindings === appliedBindings) return;
    appliedBindings = bindings;
    useShortcutBindings(bindings);
    updateShortcuts(windowShortcuts());
});

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

/**
 * Shows what the shown tab's card holds besides its page, the Start Page or
 * the failure, and lays the cards out: each card's tab gets a page, which the
 * window shows once the engine made it live.
 */
function followShownPage(): void {
    const tab = shownTab();
    const page = shownPage();
    // A tab with no page of its own, or no tab: the card shows Crest's own
    // view, and the window shows no page over it. Not before the window is
    // open: the Start Page's bar asks the core for suggestions for it.
    const open = model.windows.has(windows.windowId);
    showStartPage(open && (!tab || (!page && tab.surface === "StartPage")));
    showFailure(page?.live.failure != null ? page : undefined);
    pageCards.follow();
}

/** Whether the changes arriving are new, not the history a page that starts late replays. */
let live = false;

/**
 * A page a page of this window opened as a window of its own shows as a
 * Quick Window over this one, in the opener's Space, as the Mac's popups do:
 * the person keeps it as a tab or lets it go.
 */
function openPopups(changes: readonly Change[]): void {
    for (const change of changes) {
        if (change.kind !== "OfferedWindowAdopted" || change.value.windowId !== windows.windowId) continue;
        const { pageId, spaceId, url } = change.value;
        openWindow("quick", null, { target: windows.windowId, space: spaceId, page: pageId, url }, true);
    }
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
            preferences.apply(changes);
            icons.apply(changes);
            render();
            peek.apply(changes);
            followShownPage();
            findBar.follow();
            prompts.apply(changes);
            pageStates.apply(changes);
            credentialPrompts.apply(changes);
            downloadDestinations.apply(changes);
            spaces.apply(changes);
            spaceEditor.follow();
            settings.follow();
            windows.follow(changes);
            onboarding.follow(changes);
            if (live) openPopups(changes);
        },
        (bytes) => {
            try {
                const presentation = decodePresentation(bytes);
                if (presentation.kind === "FindFinished") findBar.finished(presentation.value);
                if (presentation.kind === "PeekRequested") peek.requested(presentation.value);
                if (presentation.kind === "InspectorLayoutChanged") relayoutInspector(presentation.value.pageId);
                pageStates.present(presentation);
                credentialPrompts.present(presentation);
                webNotifications.present(presentation);
            } catch (error) {
                console.error(error);
            }
        },
    );
    live = true;
    const workspaceId = await openSession();
    await preferences.adopt(report);
    // The launch reopens the windows the person left, each with the Space and
    // tabs it showed, as the Mac's launch does; a window opened later opens
    // as its address says.
    if (!windows.launches) {
        await windows.open(workspaceId, () => query("LaunchWindows", { environment: launchEnvironment }));
        say("");
        return;
    }
    // Setup shows first where the core says it is due, as the Mac's launch
    // shows its onboarding window: on a first launch, until setup completes.
    // Whether an earlier run completed it comes in once, as the Mac's
    // BrowserMacApplication adopts it: here, a run that left a session did.
    await dispatch({ kind: "AdoptSetupCompletion", value: { completed: !isFirstLaunch } });
    const plan = await query("LaunchWindows", { environment: launchEnvironment });
    let guideSpaceId: Guid | null = null;
    if (plan.setup) {
        say("");
        guideSpaceId = await onboarding.run(workspaceId, plan.startupWindowId, plan.setup);
    }
    await windows.open(workspaceId, () => Promise.resolve(plan));
    // TODO(linux): the Mac opens Getting Started in the guide Space after
    // setup; Linux shows the Space until it draws the guide.
    if (guideSpaceId) await dispatch({ kind: "ShowSpace", value: { windowId: windows.windowId, spaceId: guideSpaceId } });
    say("");
}

start().catch(report);
