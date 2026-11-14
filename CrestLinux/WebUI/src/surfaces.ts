// The floating surface over the page shows one thing at a time. Each owner
// (the find bar, a site's permission request, a dialog) says what it would
// show; the highest-ranked one that wants to show is drawn, and when it ends
// the one under it comes back.

import { setFloat } from "./bridge.js";
import type { FloatEvent, FloatState } from "./float.js";

/** Where a surface goes, in this page's CSS pixels, what it draws and whether it takes the keyboard. */
export interface FloatPlacement {
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly focus: boolean;
    readonly state: FloatState;
}

/** One owner of the floating surface. */
export interface FloatSurface {
    /** Higher ranks cover lower ones: `FloatRank`. */
    readonly rank: number;
    /** Shows itself again, as it rests, after a higher surface ended. */
    restore(): void;
    /** Hears what the person did on the surface; ignores what is not its own. */
    handle(event: FloatEvent): void;
}

/** The surfaces' order: modal questions over a permission request over the find bar. */
export const FloatRank = { find: 1, permission: 2, modal: 3 } as const;

const hidden: FloatPlacement = { bounds: { x: 0, y: 0, width: 0, height: 0 }, focus: false, state: { kind: "none" } };

export class FloatSurfaces {
    private readonly surfaces: FloatSurface[] = [];
    private readonly wanted = new Map<FloatSurface, FloatPlacement>();
    private shown: FloatSurface | null = null;
    /** Whether the shown surface took the keyboard from the page. */
    private focused = false;
    /** What the floating page last drew, so a placement that changed nothing is not sent again. */
    private sent = "";

    add(surface: FloatSurface): void {
        this.surfaces.push(surface);
    }

    /** `surface` wants to show `placement`, or nothing. */
    post(surface: FloatSurface, placement: FloatPlacement | null): void {
        if (placement) this.wanted.set(surface, placement);
        else this.wanted.delete(surface);
        const top = this.top();
        if (top !== this.shown) {
            const ended = this.shown;
            this.shown = top;
            if (!top || (ended && top.rank < ended.rank && this.focused)) {
                // The keyboard goes back to the page before what lies under comes back.
                this.send(hidden);
            }
            if (top && top !== surface) {
                top.restore();
                return;
            }
        }
        if (top === surface && placement) this.send(placement);
    }

    /** The floating page (re)started: it draws the shown surface again. */
    restore(): void {
        this.sent = "";
        this.shown?.restore();
    }

    handle(event: FloatEvent): void {
        for (const surface of this.surfaces) surface.handle(event);
    }

    private top(): FloatSurface | null {
        let top: FloatSurface | null = null;
        for (const surface of this.wanted.keys()) if (!top || surface.rank > top.rank) top = surface;
        return top;
    }

    private send(placement: FloatPlacement): void {
        const drawn = JSON.stringify([placement.bounds, placement.state]);
        if (drawn === this.sent && !placement.focus) return;
        this.sent = drawn;
        if (placement.bounds.width === 0) this.focused = false;
        else if (placement.focus) this.focused = true;
        setFloat(placement.bounds, placement.focus, placement.state);
    }
}
