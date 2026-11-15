// The page of the small surfaces that float over a web page: the find bar,
// the questions sites ask (prompt-float.ts), Crest's password prompts
// (credential-float.ts), and what Crest shows over a page
// while it stays in use (page-layers.ts). It keeps no state of its own: the
// window's main WebUI sends the scene to draw (setFloat), each surface in a
// layer of its own, and hears what the person did here (floatEvent); it
// talks to the core itself. Crest's keys pressed here go to the main WebUI,
// which performs them as it does those the window takes from the page.

import { credentialCard, isCredentialState } from "./credential-float.js";
import type { CredentialFloatEvent, CredentialPromptState } from "./credential-float.js";
import { infoBarStack, isPageLayerState, linkHoverLabel, noticeCapsule, openingCover } from "./page-layers.js";
import type { PageLayerEvent, PageLayerState } from "./page-layers.js";
import { isPromptState, PromptView } from "./prompt-float.js";
import type { PromptFloatEvent, PromptFloatState } from "./prompt-float.js";

declare const chrome: { send(message: string, args?: unknown[]): void };

/** What one layer of the scene draws. */
export type FloatState =
    | {
          readonly kind: "find";
          /** Set when the bar opens, to replace what the field holds. */
          readonly query: string | null;
          readonly matches: number | null;
          readonly activeMatch: number;
      }
    | PromptFloatState
    | CredentialPromptState
    | PageLayerState;

/** A layer of the scene, placed in this page's CSS pixels. */
export interface FloatLayer {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly state: FloatState;
}

/** What the main WebUI asks this page to draw, lowest layer first. */
export interface FloatScene {
    readonly layers: readonly FloatLayer[];
}

/** What the person did here. */
export type FloatEvent =
    | { readonly kind: "findQuery"; readonly text: string }
    | { readonly kind: "findNext" }
    | { readonly kind: "findPrevious" }
    | { readonly kind: "findClose" }
    /** A key press with Ctrl, Alt or Meta that nothing here took, for the window's shortcuts. */
    | {
          readonly kind: "key";
          readonly key: string;
          readonly code: string;
          readonly ctrlKey: boolean;
          readonly altKey: boolean;
          readonly metaKey: boolean;
          readonly shiftKey: boolean;
      }
    | PromptFloatEvent
    | CredentialFloatEvent
    | PageLayerEvent;

const surface = document.getElementById("surface")!;

function send(event: FloatEvent): void {
    chrome.send("floatEvent", [JSON.stringify(event)]);
}

function svg(paths: string): string {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function button(label: string, paths: string, event: FloatEvent): HTMLButtonElement {
    const control = document.createElement("button");
    control.className = "find-control";
    control.title = label;
    control.setAttribute("aria-label", label);
    control.innerHTML = svg(paths);
    control.addEventListener("mousedown", (pressed) => pressed.preventDefault());
    control.addEventListener("click", () => send(event));
    return control;
}

// The find bar, as the Mac's BrowserFindBar: the query, the match status, the
// previous and next controls and the close control.
const bar = document.createElement("div");
bar.className = "find-bar";
bar.setAttribute("role", "search");
const field = document.createElement("input");
field.className = "find-field";
field.placeholder = "Find in Page";
field.spellcheck = false;
field.setAttribute("aria-label", "Find in Page");
const status = document.createElement("span");
status.className = "find-status";
const previous = button("Previous Match", '<path d="M6 15l6-6 6 6"/>', { kind: "findPrevious" });
const next = button("Next Match", '<path d="M6 9l6 6 6-6"/>', { kind: "findNext" });
const close = button("Close Find", '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>', { kind: "findClose" });
bar.append(field, status, previous, next, close);

field.addEventListener("input", () => send({ kind: "findQuery", text: field.value }));
// Escape closes on key up: closing hands the keyboard back to the page, and a
// page handed the key up of a press it never saw was seen to stop scrolling
// by key until it lost focus.
let escapePressed = false;
field.addEventListener("blur", () => { escapePressed = false; });
field.addEventListener("keyup", (event) => {
    if (event.key !== "Escape" || !escapePressed) return;
    escapePressed = false;
    event.preventDefault();
    send({ kind: "findClose" });
});
field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        escapePressed = true;
    } else if (event.key === "Enter") {
        event.preventDefault();
        send({ kind: event.shiftKey ? "findPrevious" : "findNext" });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        send({ kind: event.shiftKey ? "findPrevious" : "findNext" });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        field.select();
    }
});

/**
 * The keys a text field edits with, as Ctrl and the key: select all, copy,
 * cut and paste (without Shift, which Copy Page Link adds to C), undo and redo
 * (Shift too), and moving, selecting or deleting by word (Shift too).
 */
const editingKeys = new Set(["a", "c", "v", "x"]);
const editingKeysWithShift = new Set(["z", "ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete"]);

function edits(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable === true;
    if (!editable || !event.ctrlKey || event.altKey || event.metaKey) return false;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    return editingKeysWithShift.has(key) || (!event.shiftKey && editingKeys.has(key));
}

// Crest's shortcuts while this view has the keyboard, as while the page has
// it: what a surface here did not take, and a field does not edit with, goes
// to the main WebUI.
document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || (!event.ctrlKey && !event.altKey && !event.metaKey)) return;
    if (["Control", "Alt", "Meta", "Shift"].includes(event.key) || edits(event)) return;
    send({
        kind: "key",
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
    });
});

/** The slots the layers draw in, one for each kind of surface. */
type Slot = "find" | "prompt" | "credential" | "notice" | "linkHover" | "opening" | "infoBars";

function slotOf(state: FloatState): Slot {
    return isPromptState(state) ? "prompt" : state.kind;
}

/** Draws a password prompt, keeping its card while it shows the same thing. */
function drawCredential(into: HTMLElement, state: CredentialPromptState): void {
    const key = JSON.stringify(state);
    if (into.dataset.key === key && into.firstElementChild) return;
    into.dataset.key = key;
    into.replaceChildren(credentialCard(state, send));
}

const slots = new Map<Slot, HTMLElement>();

function slot(name: Slot): HTMLElement {
    let made = slots.get(name);
    if (!made) {
        made = document.createElement("div");
        // The find bar and the prompts leave room around them for their shadows.
        made.className = name === "find" || name === "prompt" ? "float-slot padded" : "float-slot";
        if (name === "notice") made.classList.add("notice-layer");
        // A password prompt leaves the room the main WebUI placed around it (credential-prompts.ts).
        if (name === "credential") made.classList.add("credential-slot");
        made.hidden = true;
        surface.append(made);
        slots.set(name, made);
    }
    return made;
}

const prompts = new PromptView(slot("prompt"), send);

function drawPageLayer(into: HTMLElement, state: PageLayerState): void {
    // A layer that shows what it showed keeps its elements, so nothing
    // starts its entrance again; a notice on its way out only leaves.
    const key = JSON.stringify(state.kind === "notice" ? { ...state, leaving: false } : state);
    if (into.dataset.key === key && into.firstElementChild) {
        if (state.kind === "notice") into.firstElementChild.classList.toggle("leaving", state.leaving);
        return;
    }
    into.dataset.key = key;
    switch (state.kind) {
        case "notice":
            into.replaceChildren(noticeCapsule(state));
            break;
        case "linkHover":
            into.replaceChildren(linkHoverLabel(state));
            break;
        case "opening":
            into.replaceChildren(openingCover(state));
            break;
        case "infoBars":
            into.replaceChildren(infoBarStack(state, send));
            break;
    }
}

function draw(scene: FloatScene): void {
    const shown = new Set<Slot>();
    scene.layers.forEach((layer, index) => {
        const name = slotOf(layer.state);
        shown.add(name);
        const into = slot(name);
        into.hidden = false;
        into.style.left = `${layer.x}px`;
        into.style.top = `${layer.y}px`;
        into.style.width = `${layer.width}px`;
        into.style.height = `${layer.height}px`;
        into.style.zIndex = String(index);
        if (layer.state.kind === "find") drawFind(into, layer.state);
        else if (isPromptState(layer.state)) prompts.draw(layer.state);
        else if (isCredentialState(layer.state)) drawCredential(into, layer.state);
        else if (isPageLayerState(layer.state)) drawPageLayer(into, layer.state);
    });
    for (const [name, into] of slots) {
        if (shown.has(name) || into.hidden) continue;
        into.hidden = true;
        delete into.dataset.key;
        if (name === "prompt") prompts.clear();
        into.replaceChildren();
    }
}

function drawFind(into: HTMLElement, state: Extract<FloatState, { kind: "find" }>): void {
    if (!bar.isConnected) into.replaceChildren(bar);
    if (state.query !== null) field.value = state.query;
    const empty = field.value.length === 0;
    previous.disabled = empty;
    next.disabled = empty;
    status.classList.toggle("none", !empty && state.matches === 0);
    status.textContent = empty || state.matches === null ? "" : state.matches === 0 ? "No matches" : `${state.activeMatch} of ${state.matches}`;
    if (state.query !== null) {
        field.focus();
        field.select();
    }
}

(globalThis as unknown as { cr: unknown }).cr = {
    webUIResponse(): void {},
    webUIListenerCallback(event: string, json: unknown): void {
        if (event === "crest-float-state") draw(JSON.parse(json as string) as FloatScene);
    },
};

chrome.send("floatReady", []);
