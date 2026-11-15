// The floating view over the page draws what its owners want shown: the find
// bar, a site's permission request, a dialog, the page's info bars, a notice,
// the link under the pointer, and the cover of a page still opening. The view
// is one rectangle, and the page under it takes no input there, so it draws
// together only what sits along one edge of the page's card: the find bar and
// a notice at the top together, but the link under the pointer, at the
// bottom, only while nothing shows at the top. Of the find bar, a permission
// request and a dialog, only the highest-ranked shows; when it ends the one
// under it comes back.

import { setFloat } from "./bridge.js";
import type { FloatEvent, FloatLayer, FloatScene, FloatState } from "./float.js";

/** Where on the page's card a surface sits; see `fits`. */
export type FloatBand = "card" | "top" | "middle" | "bottom";

/** Where a surface goes, in this page's CSS pixels, what it draws and whether it takes the keyboard. */
export interface FloatPlacement {
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly focus: boolean;
    readonly state: FloatState;
    /** The card's edge it sits along; a surface covering the card goes with anything. */
    readonly band: FloatBand;
}

/** One owner of the floating surface. */
export interface FloatSurface {
    /** Higher ranks win a place, and draw over lower ones: `FloatRank`. */
    readonly rank: number;
    /** Whether it shows only while no higher-ranked exclusive surface does. */
    readonly exclusive: boolean;
    /** Shows itself again, as it rests, after a higher surface ended. */
    restore(): void;
    /** Hears what the person did on the surface; ignores what is not its own. */
    handle(event: FloatEvent): void;
    /**
     * The scene left it out for a surface it does not fit with. One that
     * should not come back on its own when that surface ends puts itself
     * away here.
     */
    displaced?(): void;
}

/**
 * The surfaces' order. A notice draws over everything, as the Mac's feedback
 * layer does; the info bars over the find bar, which they share the top with.
 */
export const FloatRank = {
    linkHover: 1,
    opening: 5,
    find: 15,
    infoBars: 17,
    permission: 20,
    modal: 30,
    notice: 40,
} as const;

/** Whether surfaces along `a` and `b` show together without the view covering the page between them. */
function fits(a: FloatBand, b: FloatBand): boolean {
    return a === b || a === "card" || b === "card";
}

const hidden = { x: 0, y: 0, width: 0, height: 0 };

export class FloatSurfaces {
    private readonly surfaces: FloatSurface[] = [];
    private readonly wanted = new Map<FloatSurface, FloatPlacement>();
    /** The exclusive surface showing. */
    private primary: FloatSurface | null = null;
    /** The surface that took the keyboard from the page, while it holds it. */
    private focusOwner: FloatSurface | null = null;
    /** What the floating page last drew, so a scene that changed nothing is not sent again. */
    private sent = "";
    /** The scene showing, and where. */
    private drawn: { bounds: FloatPlacement["bounds"]; scene: FloatScene } | null = null;

    add(surface: FloatSurface): void {
        this.surfaces.push(surface);
    }

    /** `surface` wants to show `placement`, or nothing. */
    post(surface: FloatSurface, placement: FloatPlacement | null): void {
        if (placement) this.wanted.set(surface, placement);
        else this.wanted.delete(surface);
        const primary = this.topExclusive();
        if (primary !== this.primary) {
            this.primary = primary;
            // What comes back under an ended surface shows as it rests; its
            // own post draws the scene.
            if (primary && primary !== surface) {
                primary.restore();
                return;
            }
        }
        this.draw(placement?.focus === true && this.wanted.has(surface) ? surface : null);
    }

    /** The floating page (re)started: it draws the scene again. */
    restore(): void {
        this.sent = "";
        if (this.primary) this.primary.restore();
        else this.draw(null);
    }

    handle(event: FloatEvent): void {
        for (const surface of this.surfaces) surface.handle(event);
    }

    /**
     * Hands the keyboard back to the page, after the person used a surface
     * that does not keep it, such as an info bar's button.
     */
    returnKeyboard(): void {
        // The window gives the page the keyboard as the view hides only when
        // the view had asked for it, so it asks first.
        this.focusOwner = null;
        if (this.drawn) setFloat(this.drawn.bounds, true, this.drawn.scene);
        setFloat(hidden, false, { layers: [] } satisfies FloatScene);
        this.sent = "";
        this.drawn = null;
        this.draw(null);
    }

    private topExclusive(): FloatSurface | null {
        let top: FloatSurface | null = null;
        for (const surface of this.wanted.keys()) if (surface.exclusive && (!top || surface.rank > top.rank)) top = surface;
        return top;
    }

    /** The surfaces that show now: the primary and the others it fits with, highest first. */
    private scene(): FloatSurface[] {
        const candidates = [...this.wanted.keys()]
            .filter((surface) => !surface.exclusive || surface === this.primary)
            .sort((a, b) => b.rank - a.rank);
        const shown: FloatSurface[] = [];
        for (const surface of candidates) {
            const band = this.wanted.get(surface)!.band;
            if (shown.every((other) => fits(band, this.wanted.get(other)!.band))) shown.push(surface);
        }
        return shown;
    }

    /** Sends the scene, giving the keyboard to `focusing` when it asked for it. */
    private draw(focusing: FloatSurface | null): void {
        const shown = this.scene();
        const focus = focusing !== null && shown.includes(focusing);
        if (this.focusOwner && !shown.includes(this.focusOwner) && !focus) {
            // The keyboard goes back to the page before what stays shows on.
            this.focusOwner = null;
            setFloat(hidden, false, { layers: [] } satisfies FloatScene);
            this.sent = "";
            this.drawn = null;
        }
        if (focus) this.focusOwner = focusing;
        if (shown.length === 0) {
            this.focusOwner = null;
            this.send(hidden, false, { layers: [] });
            return;
        }
        const placements = shown.map((surface) => this.wanted.get(surface)!);
        const left = Math.min(...placements.map((placement) => placement.bounds.x));
        const top = Math.min(...placements.map((placement) => placement.bounds.y));
        const right = Math.max(...placements.map((placement) => placement.bounds.x + placement.bounds.width));
        const bottom = Math.max(...placements.map((placement) => placement.bounds.y + placement.bounds.height));
        // Drawn lowest first, so the higher ones lie over them.
        const layers: FloatLayer[] = placements.reverse().map((placement) => ({
            x: Math.round(placement.bounds.x - left),
            y: Math.round(placement.bounds.y - top),
            width: Math.round(placement.bounds.width),
            height: Math.round(placement.bounds.height),
            state: placement.state,
        }));
        this.send({ x: left, y: top, width: right - left, height: bottom - top }, focus, { layers });
        const displaced = [...this.wanted.keys()].filter((surface) => !surface.exclusive && !shown.includes(surface));
        for (const surface of displaced) surface.displaced?.();
    }

    private send(bounds: FloatPlacement["bounds"], focus: boolean, scene: FloatScene): void {
        const drawn = JSON.stringify([bounds, scene]);
        if (drawn === this.sent && !focus) return;
        this.sent = drawn;
        this.drawn = bounds.width === 0 ? null : { bounds, scene };
        setFloat(bounds, focus, scene);
    }
}
