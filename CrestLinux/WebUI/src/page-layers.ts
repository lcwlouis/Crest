// What Crest draws over a page while the page stays in use: a notice, the
// link under the pointer, the cover of a page still opening, and the page's
// info bars. The main WebUI decides what shows and measures it with these
// same builders; the floating page (float.ts) draws them over the page. Both
// load page-states.css.

import type { Guid, InfoBarAnswer } from "../generated/crest_contracts.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

/** One of the engine's bars for a page, as BrowserEngineInfoBar. */
export interface InfoBarState {
    readonly id: number;
    readonly message: string;
    readonly acceptLabel: string | null;
    readonly cancelLabel: string | null;
    readonly closeable: boolean;
    readonly minimizable: boolean;
}

export type PageLayerState =
    | {
          readonly kind: "notice";
          /** Counts the notices shown, so a new one replaces one still showing. */
          readonly id: number;
          readonly message: string;
          /** The notice's symbol, as an SF Symbol name. */
          readonly symbol: string;
          /** What a screen reader says, when the words alone leave out what they report. */
          readonly label: string | null;
          /** The notice is on its way out. */
          readonly leaving: boolean;
      }
    | {
          readonly kind: "linkHover";
          /** The link's address, already shortened to the line it fits on unless expanded. */
          readonly text: string;
          readonly expanded: boolean;
          readonly maxWidth: number;
      }
    | {
          readonly kind: "opening";
          /** The card's own colour, which shows in place of a page with nothing drawn yet. */
          readonly background: string;
          /** "Opening example.com…", once the first load has run long enough to say so. */
          readonly status: string | null;
      }
    | { readonly kind: "infoBars"; readonly pageId: Guid; readonly bars: readonly InfoBarState[] };

export type PageLayerEvent =
    | { readonly kind: "infoBarAnswer"; readonly pageId: Guid; readonly infoBarId: number; readonly answer: InfoBarAnswer }
    | { readonly kind: "infoBarMinimize"; readonly pageId: Guid; readonly infoBarId: number };

/** Whether the main WebUI asks for one of these. */
export function isPageLayerState(state: { readonly kind: string }): state is PageLayerState {
    return state.kind === "notice" || state.kind === "linkHover" || state.kind === "opening" || state.kind === "infoBars";
}

// MARK: - Metrics

/** BrowserRootMetrics: where a notice stands and the room its shadow takes. */
export const noticeTop = 18;
export const noticeShadowRoom = 24;
/** BrowserLinkHoverPreview: the label's distance from the card's corner, and its widest. */
export const linkHoverInset = 12;
export const linkHoverMaxWidth = 560;
/** Room around the label for its shadow. */
export const linkHoverShadowRoom = 4;
/** BrowserWebPageSurfaceMetrics: the info bars' padding from the card, and their widest. */
export const infoBarPadding = 12;
export const infoBarMaxWidth = 640;

// MARK: - Building

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const made = document.createElement(tag);
    made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
}

/** The capsule a notice shows in, as BrowserNoticeView: its symbol and its words. */
export function noticeCapsule(state: Extract<PageLayerState, { kind: "notice" }>): HTMLElement {
    const capsule = node("div", "notice-capsule");
    capsule.setAttribute("role", "status");
    if (state.label) capsule.setAttribute("aria-label", state.label);
    const glyph = node("span", "notice-symbol");
    glyph.innerHTML = sfSymbol(state.symbol, 15);
    capsule.append(glyph, node("span", "notice-message", state.message));
    capsule.classList.toggle("leaving", state.leaving);
    return capsule;
}

/** The link's address at the card's bottom corner, as BrowserLinkHoverPreview. */
export function linkHoverLabel(state: Extract<PageLayerState, { kind: "linkHover" }>): HTMLElement {
    const label = node("div", state.expanded ? "link-hover expanded" : "link-hover", state.text);
    label.style.maxWidth = `${state.maxWidth}px`;
    label.setAttribute("aria-label", "Link destination");
    return label;
}

/**
 * What a page shows before its first navigation commits, as the Mac's page
 * surface: the card's own colour in place of the page, and after a while
 * a spinner and the host it opens.
 */
export function openingCover(state: Extract<PageLayerState, { kind: "opening" }>): HTMLElement {
    const cover = node("div", "page-opening");
    cover.style.background = state.background;
    if (state.status) {
        const status = node("div", "opening-status");
        status.setAttribute("role", "status");
        status.append(node("span", "opening-spinner"), node("span", "opening-label", state.status));
        cover.append(status);
    }
    return cover;
}

/** The engine's bars for a page, stacked at its top edge, as BrowserEngineInfoBarStack. */
export function infoBarStack(
    state: Extract<PageLayerState, { kind: "infoBars" }>,
    send: (event: PageLayerEvent) => void,
): HTMLElement {
    const stack = node("div", "infobar-stack");
    for (const bar of state.bars) {
        const row = node("div", "infobar");
        const glyph = node("span", "infobar-symbol");
        glyph.innerHTML = sfSymbol("info.circle", 15);
        row.append(glyph, node("span", "infobar-message", bar.message));
        const answer = (answer: InfoBarAnswer): void =>
            send({ kind: "infoBarAnswer", pageId: state.pageId, infoBarId: bar.id, answer });
        if (bar.cancelLabel) {
            const cancel = node("button", "infobar-button", bar.cancelLabel);
            cancel.addEventListener("click", () => answer("Cancel"));
            row.append(cancel);
        }
        if (bar.acceptLabel) {
            const accept = node("button", "infobar-button prominent", bar.acceptLabel);
            accept.addEventListener("click", () => answer("Accept"));
            row.append(accept);
        }
        if (bar.minimizable) {
            const minimize = node("button", "infobar-control");
            minimize.title = "Hide until you come back to this tab";
            minimize.setAttribute("aria-label", "Minimize");
            minimize.innerHTML = sfSymbol("chevron.up", 14);
            minimize.addEventListener("click", () => send({ kind: "infoBarMinimize", pageId: state.pageId, infoBarId: bar.id }));
            row.append(minimize);
        }
        if (bar.closeable) {
            const close = node("button", "infobar-control");
            close.setAttribute("aria-label", "Dismiss");
            close.innerHTML = sfSymbol("xmark", 14);
            close.addEventListener("click", () => answer("Dismiss"));
            row.append(close);
        }
        stack.append(row);
    }
    return stack;
}

// MARK: - Measuring

/** Lays `element` out off screen, as it will draw, and answers its size. */
export function measure(element: HTMLElement, width?: number): { width: number; height: number } {
    const holder = document.createElement("div");
    holder.className = "page-layer-measure";
    if (width !== undefined) holder.style.width = `${width}px`;
    holder.append(element);
    document.body.append(holder);
    const box = element.getBoundingClientRect();
    holder.remove();
    return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

/**
 * `text` cut in its middle to fit `width` on one line of the link label, as
 * SwiftUI's middle truncation does.
 */
export function truncateMiddle(text: string, width: number): string {
    const holder = document.createElement("div");
    holder.className = "page-layer-measure";
    const probe = node("span", "link-hover probe");
    holder.append(probe);
    document.body.append(holder);
    // The probe draws as the label does, its padding included.
    const fits = (candidate: string): boolean => {
        probe.textContent = candidate;
        return probe.getBoundingClientRect().width <= width;
    };
    let result = text;
    if (!fits(text)) {
        // The longest cut whose two ends, joined by an ellipsis, still fit.
        let low = 0;
        let high = text.length;
        while (low < high) {
            const keep = Math.ceil((low + high) / 2);
            const head = Math.ceil(keep / 2);
            if (fits(`${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`)) low = keep;
            else high = keep - 1;
        }
        const head = Math.ceil(low / 2);
        result = `${text.slice(0, head)}…${text.slice(text.length - (low - head))}`;
    }
    holder.remove();
    return result;
}
