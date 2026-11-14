// The page's line to Crest's core, through the browser process's CrestUI
// handler (crest_webui_linux.cc). Messages cross as base64 of the core's own
// wire format, which the generated codec reads and writes.

import {
    decodeChange,
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

/** Shows the engine's page `pageId` beside the sidebar. */
export function showPage(pageId: string): void {
    chrome.send("showPage", [pageId]);
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
