// The page's line to Crest's core, through the browser process's CrestUI
// handler (crest_webui_linux.cc). Messages cross as base64 of the core's own
// wire format, which the generated codec reads and writes.

import {
    decodeChange,
    decodeEnginePresentation,
    decodePageRequestAnswer,
    decodeQueryAnswer,
    decodeRejection,
    encodeIntent,
    encodePageRequest,
    encodeQuery,
    WireReader,
    WireWriter,
} from "../generated/crest_contracts.js";
import type {
    Change,
    EnginePresentation,
    Guid,
    Intent,
    PageRequest,
    PageRequestAnswers,
    Query,
    QueryAnswers,
    Rejection,
} from "../generated/crest_contracts.js";

declare const chrome: { send(message: string, args?: unknown[]): void };

const CREST_OK = 0;
const CREST_REJECTED = 6;

interface CallAnswer {
    readonly status: number;
    readonly bytes: string;
}

/** A rule refused the intent or query. */
export class Refused extends Error {
    readonly rejection: Rejection;

    constructor(rejection: Rejection) {
        super(`The core refused: ${rejection.kind}`);
        this.rejection = rejection;
        this.name = "Refused";
    }
}

type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };
const pending = new Map<string, Pending>();
const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
let nextCall = 0;

// What the handler calls: ResolveJavascriptCallback answers cr.webUIResponse,
// FireWebUIListener calls cr.webUIListenerCallback.
(globalThis as unknown as { cr: unknown }).cr = {
    webUIResponse(id: string, isSuccess: boolean, response: unknown): void {
        const call = pending.get(id);
        pending.delete(id);
        if (isSuccess) call?.resolve(response);
        else call?.reject(new Error(String(response)));
    },
    webUIListenerCallback(event: string, ...args: unknown[]): void {
        for (const listener of listeners.get(event) ?? []) listener(...args);
    },
};

function send<T>(message: string, ...args: unknown[]): Promise<T> {
    const id = `crest-${nextCall++}`;
    return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        chrome.send(message, [id, ...args]);
    });
}

function listen(event: string, listener: (...args: unknown[]) => void): void {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** One encoded batch: a count, then each change. */
export function decodeChanges(bytes: Uint8Array): Change[] {
    const reader = new WireReader(bytes);
    const count = reader.count();
    const changes: Change[] = [];
    for (let index = 0; index < count; index++) changes.push(decodeChange(reader));
    reader.finish();
    return changes;
}

function rejectionIn(bytes: Uint8Array): Rejection {
    const reader = new WireReader(bytes);
    const rejection = decodeRejection(reader);
    reader.finish();
    return rejection;
}

/**
 * Starts the line: hears every batch the core published before the page
 * started, then each new one, and each page presentation.
 */
export async function connect(
    onChanges: (changes: Change[]) => void,
    onPresentation: (bytes: Uint8Array) => void,
): Promise<void> {
    listen("crest-changes", (batch) => onChanges(decodeChanges(fromBase64(batch as string))));
    listen("crest-presentation", (bytes) => onPresentation(fromBase64(bytes as string)));
    const history = await send<string[]>("ready");
    for (const batch of history) onChanges(decodeChanges(fromBase64(batch)));
}

/** Sends an intent. Its changes also arrive through `onChanges`. */
export async function dispatch(intent: Intent): Promise<Change[]> {
    const writer = new WireWriter();
    encodeIntent(writer, intent);
    const answer = await send<CallAnswer>("dispatch", toBase64(writer.bytes()));
    const bytes = fromBase64(answer.bytes);
    if (answer.status === CREST_REJECTED) throw new Refused(rejectionIn(bytes));
    if (answer.status !== CREST_OK) throw new Error(`The core could not take ${intent.kind} (status ${answer.status}).`);
    return decodeChanges(bytes);
}

/** Asks the core a question about its state. */
export async function query<K extends Query["kind"] & keyof QueryAnswers>(
    kind: K,
    value: Extract<Query, { kind: K }>["value"],
): Promise<QueryAnswers[K]> {
    const writer = new WireWriter();
    encodeQuery(writer, { kind, value } as Query);
    const answer = await send<CallAnswer>("query", toBase64(writer.bytes()));
    const bytes = fromBase64(answer.bytes);
    if (answer.status === CREST_REJECTED) throw new Refused(rejectionIn(bytes));
    if (answer.status !== CREST_OK) throw new Error(`The core could not answer ${kind} (status ${answer.status}).`);
    const reader = new WireReader(bytes);
    const result = decodeQueryAnswer(kind, reader);
    reader.finish();
    return result;
}

/** Places the page's view over the window's page card, in CSS pixels. */
export function setPageBounds(x: number, y: number, width: number, height: number): void {
    chrome.send("setPageBounds", [x, y, width, height]);
}

/** Shows the engine's page `pageId` in the window's page card. */
export function showPage(pageId: string): void {
    chrome.send("showPage", [pageId]);
}

/** One page the window shows, where (in CSS pixels), and how its view stacks. */
export interface PagePlacement {
    readonly pageId: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** Whether the page stays over this WebUI while it is raised, as a Peek's page does. */
    readonly above: boolean;
    readonly cornerRadius: number;
}

/**
 * Shows these pages and no other, the later ones over the earlier: the cards
 * of a split side by side, and a Peek's page over them. `focusedPageId` is
 * the page in use, which takes the keyboard; empty when none is.
 */
export function setPageLayout(pages: readonly PagePlacement[], focusedPageId: string): void {
    chrome.send("setPageLayout", [
        pages.map((page) => [
            page.pageId,
            Math.round(page.x),
            Math.round(page.y),
            Math.round(page.width),
            Math.round(page.height),
            page.above,
            page.cornerRadius,
        ]),
        focusedPageId,
    ]);
}

/** Hears the person click into a page the window shows, by its page id. */
export function listenToPageFocus(onFocus: (pageId: string) => void): void {
    listen("crest-page-focused", (pageId) => onFocus((pageId as string).toLowerCase()));
}

/**
 * Raises the WebUI over the page while it draws a floating surface, such as
 * the command bar, and lowers it again after. Raised, the page shows through
 * wherever the WebUI paints nothing.
 */
export function setOverlay(raised: boolean): void {
    chrome.send("setOverlay", [raised]);
}

/**
 * Places the floating surface over the page, in CSS pixels of this page (an
 * empty rectangle hides it), and hands it the state it draws.
 */
export function setFloat(
    bounds: { x: number; y: number; width: number; height: number },
    focus: boolean,
    state: unknown,
): void {
    chrome.send("setFloat", [
        Math.round(bounds.x),
        Math.round(bounds.y),
        Math.round(bounds.width),
        Math.round(bounds.height),
        focus,
        JSON.stringify(state),
    ]);
}

/** Hears what the person does on the floating surface, and when it is ready for state. */
export function listenToFloat(onEvent: (event: unknown) => void, onReady: () => void): void {
    listen("crest-float-event", (json) => onEvent(JSON.parse(json as string)));
    listen("crest-float-ready", () => onReady());
}

/** Reads one of the engine's presentations, as the core's line relays it. */
export function decodePresentation(bytes: Uint8Array): EnginePresentation {
    const reader = new WireReader(bytes);
    const presentation = decodeEnginePresentation(reader);
    reader.finish();
    return presentation;
}

/** A key the window took from a page for one of Crest's shortcuts. */
export interface HostKey {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
}

/**
 * Tells the window which keys are Crest's, each as [key, ctrl, alt, meta,
 * shift (-1 when it does not matter), reserved from pages], and hears the
 * ones it takes from a page, and the commands Chromium asks for.
 */
export function registerShortcuts(
    shortcuts: readonly (readonly [string, boolean, boolean, boolean, number, boolean])[],
    onKey: (key: HostKey) => void,
    onCommand: (command: string) => void,
): void {
    listen("crest-shortcut", (key) => onKey(key as HostKey));
    listen("crest-command", (command) => onCommand(command as string));
    updateShortcuts(shortcuts);
}

/** The modifiers still held when a page's view saw one released, which this page cannot see itself. */
export type HeldModifiers = Omit<HostKey, "key">;

/** Hears the modifiers still held each time a page's view saw one released. */
export function listenToModifierRelease(onRelease: (held: HeldModifiers) => void): void {
    listen("crest-modifiers", (held) => onRelease(held as HeldModifiers));
}

/** Tells the window which keys are Crest's again, as `registerShortcuts` first did. */
export function updateShortcuts(shortcuts: readonly (readonly [string, boolean, boolean, boolean, number, boolean])[]): void {
    chrome.send("setShortcuts", shortcuts.map((shortcut) => [...shortcut]));
}

/** Asks the engine about one of its pages directly, as the Mac's views do. */
export async function pageRequest<K extends PageRequest["kind"] & keyof PageRequestAnswers>(
    kind: K,
    value: Extract<PageRequest, { kind: K }>["value"],
): Promise<PageRequestAnswers[K]> {
    const writer = new WireWriter();
    encodePageRequest(writer, { kind, value } as PageRequest);
    const answer = await send<CallAnswer>("pageRequest", toBase64(writer.bytes()));
    if (answer.status !== CREST_OK) throw new Error(`The engine could not answer ${kind} (status ${answer.status}).`);
    const reader = new WireReader(fromBase64(answer.bytes));
    const result = decodePageRequestAnswer(kind, reader);
    reader.finish();
    return result;
}

/** Opens a finished download's file, given as its `file:` address, in the desktop's default app. */
export function openDownload(fileUrl: string): void {
    chrome.send("openDownload", [fileUrl]);
}

/** Shows a finished download's file, given as its `file:` address, in the desktop's file manager. */
export function showDownloadInFolder(fileUrl: string): void {
    chrome.send("showDownloadInFolder", [fileUrl]);
}

/**
 * Where a download's file goes: the person's Downloads folder under a name
 * no file there has, or the place they choose in the save dialog when
 * `asks`. The path is null when they cancelled or the folder is unavailable.
 */
export function chooseDownloadPath(
    filename: string,
    asks: boolean,
): Promise<{ readonly path: string | null; readonly unavailable: boolean }> {
    return send("chooseDownloadPath", filename, asks);
}

// --- Windows (Linux shell) ----------------------------------------------------

/** A kind of window the shell opens, as the Mac's BrowserMacWindowKind names them. */
export type WindowKind = "browser" | "quick";

/**
 * Opens a window of `kind` whose WebUI reads `parameters`: a browser window
 * under the core's id `windowId`, or a Quick Window with none. A browser
 * window already open under the id comes forward instead. It comes forward
 * when `activates`, and otherwise opens behind the window in use.
 */
export function openWindow(kind: WindowKind, windowId: Guid | null, parameters: Record<string, string>, activates: boolean): void {
    chrome.send("openWindow", [kind, windowId ?? "", new URLSearchParams(parameters).toString(), activates]);
}

/** Brings the browser window `windowId` names forward, when it is open. */
export function presentWindow(windowId: Guid): void {
    openWindow("browser", windowId, {}, true);
}

/** Brings this page's window forward. */
export function presentThisWindow(): void {
    chrome.send("presentWindow");
}

/** Tells the shell the person used this page's window, which is the one in use, though the window manager may not have activated it. */
export function useThisWindow(): void {
    chrome.send("useWindow");
}

/** Tells the shell the core opened the window `windowId` for this page's window. */
export function adoptWindow(windowId: Guid): void {
    chrome.send("adoptWindow", [windowId]);
}

/** Closes this page's window as the person's close does, which asks this page first. */
export function requestClose(): void {
    chrome.send("requestClose");
}

/** Closes this page's window without asking again. */
export function closeWindow(): void {
    chrome.send("closeWindow");
}

/** Names this page's window for the desktop. */
export function setWindowTitle(title: string): void {
    chrome.send("setWindowTitle", [title]);
}

/** The core ids of the open browser windows, the one used last first. */
export function stackedWindows(): Promise<Guid[]> {
    return send<Guid[]>("stackedWindows");
}

/** What the shell tells a window's WebUI about its window. */
export interface WindowEvents {
    /** The person asked to close the window; `last` when no other browser window is open, so it quits. */
    closeRequested(last: boolean): void;
    /** The window came into use, or left it. */
    activeChanged(active: boolean): void;
    /** Another window shows the page `pageId` now. */
    pageLeft(pageId: Guid): void;
    /** No window shows the page `pageId` now. */
    pageFree(pageId: Guid): void;
    /** The window shows the page `pageId`, which the engine keeps for another window. */
    pageArrived(pageId: Guid): void;
    /** A tab the engine opened for this window joins the Space `spaceId`. */
    showSpace(spaceId: Guid): void;
    /** Links another app handed Crest. */
    openExternal(urls: readonly string[]): void;
}

/** Hears what the shell tells this page about its window. */
export function listenToWindow(events: WindowEvents): void {
    listen("crest-close-requested", (last) => events.closeRequested(last as boolean));
    listen("crest-window-active", (active) => events.activeChanged(active as boolean));
    listen("crest-page-left", (pageId) => events.pageLeft((pageId as string).toLowerCase()));
    listen("crest-page-free", (pageId) => events.pageFree((pageId as string).toLowerCase()));
    listen("crest-page-arrived", (pageId) => events.pageArrived((pageId as string).toLowerCase()));
    listen("crest-show-space", (spaceId) => events.showSpace((spaceId as string).toLowerCase()));
    listen("crest-open-external", (urls) => events.openExternal(urls as string[]));
}

// --- Setup (Linux shell) ------------------------------------------------------

/**
 * Asks the core a question it answers without waiting on its other work, such
 * as reading another browser's files, away from the browser's UI thread, as
 * the Mac asks it away from its main thread.
 */
export async function queryAway<K extends Query["kind"] & keyof QueryAnswers>(
    kind: K,
    value: Extract<Query, { kind: K }>["value"],
): Promise<QueryAnswers[K]> {
    const writer = new WireWriter();
    encodeQuery(writer, { kind, value } as Query);
    const answer = await send<CallAnswer>("queryAway", toBase64(writer.bytes()));
    const bytes = fromBase64(answer.bytes);
    if (answer.status === CREST_REJECTED) throw new Refused(rejectionIn(bytes));
    if (answer.status !== CREST_OK) throw new Error(`The core could not answer ${kind} (status ${answer.status}).`);
    const reader = new WireReader(bytes);
    const result = decodeQueryAnswer(kind, reader);
    reader.finish();
    return result;
}

/** The person's home folder and XDG config folder, where other browsers keep their data. */
export function homeFolders(): Promise<{ readonly home: string; readonly config: string }> {
    return send("homeFolders");
}

/** The folder the person picks in a folder picker titled `title`, opening at `folder`; null when they cancel. */
export function chooseImportFolder(title: string, folder: string): Promise<string | null> {
    return send("chooseImportFolder", title, folder);
}

/** Which of `folders` are folders on this computer, in their order. */
export function existingFolders(folders: readonly string[]): Promise<string[]> {
    return send("existingFolders", [...folders]);
}

// --- Passwords (Linux shell) --------------------------------------------------
// Crest's saved passwords live in the desktop's Secret Service, which the
// browser process reaches (crest_credentials_linux), as the Mac's Swift
// reaches the Keychain. The core never keeps them.

/** One item Crest keeps in the Secret Service, as the Mac's CredentialKeychainItem. */
export interface CredentialItem {
    readonly account: string;
    /** The item's descriptor, as JSON. */
    readonly metadata: string;
    readonly synchronizable: boolean;
    /** The password, when it was read. */
    readonly secret?: string;
}

/**
 * The items the Secret Service keeps under `service`, or only `account`'s
 * when one is named, with their passwords when `withSecrets`. Rejects when
 * the Secret Service cannot be reached or refuses.
 */
export function credentialItems(service: string, account: string, withSecrets: boolean): Promise<CredentialItem[]> {
    return send("credentialItems", service, account, withSecrets);
}

/** Stores `item` under `service`, in place of the account's earlier item. */
export function upsertCredential(service: string, item: Required<CredentialItem>): Promise<true> {
    return send("upsertCredential", service, item);
}

/** Removes `account`'s item from `service`, or every item of it when `account` is empty. */
export function deleteCredential(service: string, account: string): Promise<true> {
    return send("deleteCredential", service, account);
}

/**
 * Puts `password` on the clipboard, marked confidential, and takes it off
 * after `seconds` unless something else was copied since. Answers whether it
 * was copied.
 */
export function copyPassword(password: string, seconds: number): Promise<boolean> {
    return send("copyPassword", password, seconds);
}

/** One profile's password store, as the core found it (ImportPasswordStore). */
export interface PasswordStore {
    readonly id: string;
    readonly profileName: string;
    readonly path: string;
}

/** A login another browser keeps; `username` and `password` only once read to import. */
export interface ImportedLogin {
    readonly profileId: string;
    readonly profileName: string;
    readonly url: string;
    readonly username?: string;
    readonly password?: string;
}

/** Why another browser's passwords could not be read, as the Mac's BrowserPasswordImportError. */
export type PasswordImportFailure = "unreadableDatabase" | "safeStorageUnavailable";

/** The logins read, or why none could be. */
export interface PasswordImportAnswer {
    readonly logins?: readonly ImportedLogin[];
    readonly failure?: PasswordImportFailure;
}

/** The logins `stores` keep, without their passwords. */
export function passwordImportCandidates(stores: readonly PasswordStore[]): Promise<PasswordImportAnswer> {
    return send("passwordImportCandidates", [...stores]);
}

/**
 * The logins `stores` keep with their passwords, decrypted with the key the
 * Secret Service keeps under `safeStorage`, such as "Chrome Safe Storage".
 */
export function readImportPasswords(safeStorage: string, stores: readonly PasswordStore[]): Promise<PasswordImportAnswer> {
    return send("readImportPasswords", safeStorage, [...stores]);
}
