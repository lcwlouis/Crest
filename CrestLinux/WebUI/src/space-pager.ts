// The sidebar's Space pager, as the Mac's SpacePagerGesture,
// SpaceScrollGestureRecognizer and SpacePagerViewport handle it: a
// two-finger horizontal scroll over the sidebar slides the shown Space's page
// aside and the neighbouring Space's page in with the fingers, and on release
// settles on whichever the swipe carried past half way, or a quick flick
// reached; an ordinary wheel's horizontal step moves one Space per burst.
// Scrolling the tab list up and down stays the list's.
//
// The core says which Space the window shows; the pager only slides the
// pages and sends ShowSpace (or ShowAdjacentSpace for a wheel step) once it
// settles.
//
// Chromium hands the page wheel events without the touchpad's phases, so a
// gesture ends after a short quiet gap rather than at its lift-off, and the
// fling Chromium synthesises after it counts as part of the swipe.
//
// TODO(linux): blend the window's backdrop between the two Spaces' colours
// with the swipe, as SpacePagerViewport does; the backdrop changes when the
// core shows the new Space.

import type { Guid, Intent } from "../generated/crest_contracts.js";
import { dispatch } from "./bridge.js";
import type { Model, Space } from "./model.js";
import { SpaceGroups } from "./space-groups.js";

// MARK: - Types

export interface SpacePagerHost {
    readonly model: Model;
    readonly windowId: () => Guid;
    readonly send: (intent: Intent) => void;
    /** The page `space` shows, drawn for sliding in beside the shown one. */
    readonly pageOf: (space: Space) => HTMLElement;
    /** Whether another gesture holds the sidebar, such as a drag. */
    readonly isLocked: () => boolean;
}

type Axis = "undecided" | "horizontal" | "vertical";

interface Swipe {
    axis: Axis;
    accumulatedX: number;
    accumulatedY: number;
    /** -1 shows the next Space from the trailing edge, +1 the previous from the leading edge; 0 until it moves. */
    direction: number;
    /** Whether a wheel's step has been taken, so a burst steps once. */
    resolved: boolean;
    offset: number;
    neighbor: Space | null;
    incoming: HTMLElement | null;
    samples: { time: number; offset: number }[];
}

// MARK: - Constants

/** SpaceScrollGestureRecognizer: precise deltas are points, wheel deltas line steps. */
const preciseRecognition = 8;
const wheelRecognition = 1;
const horizontalDominance = 1.35;
const phaseLessIdle = 350;
/** The quiet gap that ends a precise swipe, since Chromium sends no lift-off. */
const swipeEnd = 120;
/** How far ahead a release's speed carries the swipe, in seconds (SpacePagerViewport.endInteractiveMotion). */
const projection = 0.15;
const velocityWindow = 80;

export class SpacePager {
    private readonly host: SpacePagerHost;
    private readonly page: HTMLElement;
    private swipe: Swipe | null = null;
    private lastEvent = -Infinity;
    private endTimer = 0;
    private settling = false;

    constructor(host: SpacePagerHost, page: HTMLElement) {
        this.host = host;
        this.page = page;
        page.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    }

    /** Whether a swipe is moving the pages, or settling them. */
    get isMoving(): boolean {
        return this.settling || (this.swipe?.axis === "horizontal" && this.swipe.incoming !== null);
    }

    // MARK: - Actions - Recognizing

    private wheel(event: WheelEvent): void {
        if (this.settling) {
            event.preventDefault();
            return;
        }
        const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.width : 1;
        const dx = event.deltaX * scale;
        const dy = event.deltaY * scale;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        // A touchpad sends small, often fractional, pixel steps; a wheel's notches are large and whole.
        const precise = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && (Math.abs(event.deltaX) < 50 && Math.abs(event.deltaY) < 50 || !Number.isInteger(event.deltaX));
        const now = event.timeStamp;
        const idle = now - this.lastEvent > (precise ? swipeEnd * 2 : phaseLessIdle);
        this.lastEvent = now;
        if (!this.swipe || (idle && this.swipe.incoming === null)) {
            if (this.host.isLocked()) return;
            this.swipe = { axis: "undecided", accumulatedX: 0, accumulatedY: 0, direction: 0, resolved: false, offset: 0, neighbor: null, incoming: null, samples: [] };
        }
        const swipe = this.swipe;
        if (swipe.axis === "vertical") return;
        if (swipe.axis === "undecided") {
            swipe.accumulatedX += dx;
            swipe.accumulatedY += dy;
            const recognition = precise ? preciseRecognition : wheelRecognition;
            const x = Math.abs(swipe.accumulatedX);
            const y = Math.abs(swipe.accumulatedY);
            if (y >= recognition && y >= x * horizontalDominance) {
                swipe.axis = "vertical";
                return;
            }
            if (x < recognition || x < y * horizontalDominance) return;
            swipe.axis = "horizontal";
            event.preventDefault();
            if (!precise) {
                swipe.resolved = true;
                this.step(swipe.accumulatedX > 0 ? -1 : 1);
                return;
            }
            this.begin(swipe, swipe.accumulatedX > 0 ? -1 : 1);
            this.track(swipe, -swipe.accumulatedX, now);
            return;
        }
        event.preventDefault();
        if (swipe.resolved || !precise) return;
        this.track(swipe, -dx, now);
    }

    // MARK: - Actions - Moving

    private get width(): number {
        return this.page.clientWidth || 1;
    }

    /** The Space beside the shown one on the side `direction` reveals, in the switcher's order. */
    private neighbor(direction: number): Space | null {
        const workspace = this.host.model.workspace;
        const window = this.host.model.windows.get(this.host.windowId());
        if (!workspace || !window) return null;
        const spaces = new SpaceGroups(workspace).available;
        const index = spaces.findIndex((space) => space.state.id === window.shownSpaceId);
        return spaces[index - direction] ?? null;
    }

    /** Starts sliding toward the side `direction` reveals, with the neighbour's page beside the shown one. */
    private begin(swipe: Swipe, direction: number): void {
        swipe.direction = direction;
        swipe.neighbor = this.neighbor(direction);
        if (!swipe.neighbor) return;
        const incoming = this.host.pageOf(swipe.neighbor);
        incoming.classList.add("pager-incoming");
        incoming.style.top = `${this.page.offsetTop}px`;
        incoming.style.height = `${this.page.offsetHeight}px`;
        incoming.style.width = `${this.page.offsetWidth}px`;
        this.page.after(incoming);
        swipe.incoming = incoming;
        this.page.parentElement?.classList.add("paging");
        this.position(swipe, false);
    }

    /** Moves the pages with the fingers, never past the neighbour, and reverses at once. */
    private track(swipe: Swipe, delta: number, time: number): void {
        if (!swipe.incoming) return;
        const travel = Math.min(this.width, Math.max(0, (swipe.offset + delta) * swipe.direction));
        swipe.offset = travel * swipe.direction;
        swipe.samples.push({ time, offset: swipe.offset });
        swipe.samples = swipe.samples.filter((sample) => sample.time >= time - velocityWindow);
        this.position(swipe, false);
        clearTimeout(this.endTimer);
        this.endTimer = window.setTimeout(() => this.release(swipe), swipeEnd);
    }

    /** Settles where the swipe was carried: the neighbour past half way or a quick flick, else back. */
    private release(swipe: Swipe): void {
        if (this.swipe !== swipe) return;
        const first = swipe.samples[0];
        const last = swipe.samples[swipe.samples.length - 1];
        const velocity = first && last && last.time > first.time ? (last.offset - first.offset) / ((last.time - first.time) / 1000) : 0;
        const travel = swipe.offset * swipe.direction;
        const projected = travel + velocity * swipe.direction * projection;
        void this.settle(swipe, travel > 0 && projected >= this.width / 2);
    }

    /** A wheel's step: the neighbouring Space slides in whole, as the Mac's pager steps. */
    private step(direction: number): void {
        const swipe = this.swipe;
        if (!swipe) return;
        this.begin(swipe, direction);
        if (!swipe.incoming) {
            this.host.send({ kind: "ShowAdjacentSpace", value: { windowId: this.host.windowId(), direction: direction < 0 ? "Next" : "Previous" } });
            this.swipe = null;
            return;
        }
        // Lay the incoming page out before it slides.
        void swipe.incoming.offsetWidth;
        void this.settle(swipe, true);
    }

    /** Slides the pages home (SpaceMotion.spaceSwipe) and shows the Space they settled on. */
    private async settle(swipe: Swipe, completes: boolean): Promise<void> {
        clearTimeout(this.endTimer);
        this.settling = true;
        swipe.offset = completes ? swipe.direction * this.width : 0;
        this.position(swipe, true);
        const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--crest-dur-space-swipe")) || 320;
        await new Promise((resolve) => setTimeout(resolve, duration));
        if (completes && swipe.neighbor) {
            try {
                await dispatch({ kind: "ShowSpace", value: { windowId: this.host.windowId(), spaceId: swipe.neighbor.state.id } });
            } catch (error) {
                console.error(error);
            }
        }
        // The shown page now draws the Space it settled on, in place of the copy that slid in.
        swipe.incoming?.remove();
        this.page.style.transition = "";
        this.page.style.transform = "";
        this.page.parentElement?.classList.remove("paging");
        this.settling = false;
        if (this.swipe === swipe) this.swipe = null;
    }

    private position(swipe: Swipe, animated: boolean): void {
        const transition = animated ? "transform var(--crest-dur-space-swipe) var(--crest-ease-snappy)" : "none";
        this.page.style.transition = transition;
        this.page.style.transform = swipe.offset ? `translateX(${swipe.offset}px)` : "";
        if (swipe.incoming) {
            swipe.incoming.style.transition = transition;
            swipe.incoming.style.transform = `translateX(${swipe.offset - swipe.direction * this.width}px)`;
        }
    }
}
