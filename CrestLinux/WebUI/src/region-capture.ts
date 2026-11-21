// Capturing a part of a page, as the Mac's BrowserRegionCaptureOverlay: the
// page dims, the person drags a rectangle over it, and the part inside is
// copied. Escape, or a drag too small to be meant, ends it without a capture.
//
// The selection floats over the page, so the window raises the WebUI over the
// page's view while it shows; the page shows through the dimmed ground.

import type { Guid, PageArea } from "../generated/crest_contracts.js";
import { holdOverlay } from "./overlay.js";
import { sfSymbol } from "./symbols.js";

/** The shortest side a capture may have. */
const minimumSelectionLength = 12;

/** Where a page's view sits in the window, in CSS pixels. */
export interface PageRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

interface Shown {
    readonly pageId: Guid;
    readonly layer: HTMLElement;
    readonly release: () => void;
    readonly onKey: (event: KeyboardEvent) => void;
    readonly ended: () => void;
}

export class RegionCapture {
    private readonly copy: (pageId: Guid, area: PageArea) => void;
    private shown: Shown | null = null;

    /** Captures with `copy`, which copies the page's `area`, in its view's points. */
    constructor(copy: (pageId: Guid, area: PageArea) => void) {
        this.copy = copy;
    }

    /** The page whose selection shows, if one does. */
    get pageId(): Guid | null {
        return this.shown?.pageId ?? null;
    }

    /** Begins a selection over the page `pageId`, which sits at `rect` in the window; `ended` hears it end. */
    begin(pageId: Guid, rect: PageRect, ended: () => void = () => {}): void {
        this.cancel();
        const layer = document.createElement("div");
        layer.className = "region-capture";
        layer.style.left = `${rect.x}px`;
        layer.style.top = `${rect.y}px`;
        layer.style.width = `${rect.width}px`;
        layer.style.height = `${rect.height}px`;
        layer.tabIndex = -1;
        layer.setAttribute("role", "application");
        layer.setAttribute("aria-label", "Page capture selection");
        layer.setAttribute("aria-description", "Drag a rectangle to copy that part of the page");
        const canvas = document.createElement("canvas");
        canvas.className = "region-capture-canvas";
        const instruction = document.createElement("div");
        instruction.className = "region-capture-instruction";
        instruction.innerHTML = `${sfSymbol("camera.viewfinder", 16)}<span>Drag to capture a portion of this page</span>`;
        layer.append(canvas, instruction);
        document.body.append(layer);

        const scale = window.devicePixelRatio || 1;
        canvas.width = Math.round(rect.width * scale);
        canvas.height = Math.round(rect.height * scale);
        const draw = (selection: PageArea | null): void => {
            const context = canvas.getContext("2d");
            if (!context) return;
            context.setTransform(scale, 0, 0, scale, 0, 0);
            context.clearRect(0, 0, rect.width, rect.height);
            context.fillStyle = "rgb(0 0 0 / 0.46)";
            context.beginPath();
            context.rect(0, 0, rect.width, rect.height);
            if (selection) context.rect(selection.x, selection.y, selection.width, selection.height);
            context.fill("evenodd");
            if (selection) {
                context.strokeStyle = "white";
                context.lineWidth = 1.5;
                context.setLineDash([6, 4]);
                context.beginPath();
                context.roundRect(selection.x, selection.y, selection.width, selection.height, 4);
                context.stroke();
            }
        };
        draw(null);

        let start: { x: number; y: number } | null = null;
        const local = (event: PointerEvent): { x: number; y: number } => ({ x: event.clientX - rect.x, y: event.clientY - rect.y });
        layer.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            layer.setPointerCapture(event.pointerId);
            start = local(event);
        });
        layer.addEventListener("pointermove", (event) => {
            if (start) draw(selectionRect(start, local(event), rect));
        });
        layer.addEventListener("pointerup", (event) => {
            if (!start) return;
            const selection = selectionRect(start, local(event), rect);
            start = null;
            draw(null);
            if (!selection) return;
            this.cancel();
            this.copy(pageId, selection);
        });
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            this.cancel();
        };
        document.addEventListener("keydown", onKey, true);
        this.shown = { pageId, layer, release: holdOverlay(), onKey, ended };
        layer.focus();
    }

    /** Ends the selection without a capture. */
    cancel(): void {
        const shown = this.shown;
        if (!shown) return;
        this.shown = null;
        document.removeEventListener("keydown", shown.onKey, true);
        shown.layer.remove();
        shown.release();
        shown.ended();
    }
}

/** The area a drag from `start` to `end` selects, inside the page, or null when too small to be meant. */
function selectionRect(start: { x: number; y: number }, end: { x: number; y: number }, rect: PageRect): PageArea | null {
    const left = Math.max(0, Math.min(start.x, end.x));
    const top = Math.max(0, Math.min(start.y, end.y));
    const right = Math.min(rect.width, Math.max(start.x, end.x));
    const bottom = Math.min(rect.height, Math.max(start.y, end.y));
    const width = right - left;
    const height = bottom - top;
    if (width < minimumSelectionLength || height < minimumSelectionLength) return null;
    return { x: left, y: top, width, height };
}
