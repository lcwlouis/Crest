// The page of the small surfaces that float over a web page: the find bar,
// and the questions sites ask (prompt-float.ts). It keeps no state of its
// own: the window's main WebUI sends what to draw (setFloat) and hears what
// the person did here (floatEvent), and talks to the core itself.

import { isPromptState, PromptView } from "./prompt-float.js";
import type { PromptFloatEvent, PromptFloatState } from "./prompt-float.js";

declare const chrome: { send(message: string, args?: unknown[]): void };

/** What the main WebUI asks this page to draw. */
export type FloatState =
    | { readonly kind: "none" }
    | {
          readonly kind: "find";
          /** Set when the bar opens, to replace what the field holds. */
          readonly query: string | null;
          readonly matches: number | null;
          readonly activeMatch: number;
      }
    | PromptFloatState;

/** What the person did here. */
export type FloatEvent =
    | { readonly kind: "findQuery"; readonly text: string }
    | { readonly kind: "findNext" }
    | { readonly kind: "findPrevious" }
    | { readonly kind: "findClose" }
    | PromptFloatEvent;

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

const prompts = new PromptView(surface, send);

function draw(state: FloatState): void {
    if (isPromptState(state)) {
        prompts.draw(state);
        return;
    }
    prompts.clear();
    if (state.kind !== "find") {
        surface.replaceChildren();
        return;
    }
    if (!bar.isConnected) surface.replaceChildren(bar);
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
        if (event === "crest-float-state") draw(JSON.parse(json as string) as FloatState);
    },
};

chrome.send("floatReady", []);
