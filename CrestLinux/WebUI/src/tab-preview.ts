// One window's tab preview, as the Mac's BrowserTabPreviewState: the tab or
// folder the pointer rests on in the sidebar, and the one whose card shows.
//
// A card shows once a tab has been rested on for `restDelay`. While one
// shows, resting on another tab for `moveDelay` moves the card there. A tab
// the pointer crosses while heading for the card, inside the triangle from
// where it left the card's tab to the card's near edge, needs `aimDelay`
// instead, so a pointer crossing other tabs or pins on its way into the card
// keeps the card it aimed for. The card goes `leaveDelay` after the pointer
// leaves both the tab and the card, or at once when dismissed. A dismissed
// card stays away until a tab is entered again.

import type { Guid } from "../generated/crest_contracts.js";

// MARK: - Types

/** What a preview card is for: a tab, or a folder and the tabs it holds. */
export type PreviewSubject = { readonly kind: "tab"; readonly id: Guid } | { readonly kind: "folder"; readonly id: Guid };

/** A sidebar tab or folder a card is for, in its Space, and where its row or tile sits in the window. */
export interface PreviewTarget {
    readonly subject: PreviewSubject;
    readonly spaceId: Guid;
    readonly frame: DOMRect;
}

/** A point in the window, in CSS pixels. */
export interface Point {
    readonly x: number;
    readonly y: number;
}

/** One tab or folder in one Space, which tells one target from another. */
export function previewKey(target: PreviewTarget): string {
    return `${target.subject.kind}:${target.subject.id}:${target.spaceId}`;
}

/** How long a tab is rested on before its card shows, while no card does. */
const restDelay = 500;
/** How long another tab is rested on, while a card shows, before the card moves to it. */
const moveDelay = 120;
/** How long a tab the pointer crosses while heading for the card is rested on before the card moves to it. */
const aimDelay = 350;
/** How long a card stays after the pointer leaves its tab and the card. */
const leaveDelay = 150;
/** How long after the person last typed in the window a card's search leaves the keyboard where it is. */
const typingPause = 1000;

export class TabPreviewState {
    /** The tab or folder whose card shows, or null. */
    shown: PreviewTarget | null = null;
    /** Whether the pointer is over the card that shows. */
    isPointerInCard = false;
    /** Whether the card stays when the pointer leaves it, as while a folder's card holds a search. */
    isHeld = false;
    /** Whether something the card began is under way, such as a row's menu, which the card stays up for. */
    isInteracting = false;
    /** Where the card that shows is in the window, as its layer places it. */
    cardFrame: DOMRect | null = null;
    /** Where the pointer is in the window. */
    pointerLocation: () => Point | null = () => null;
    /** The preview of the tabs a folder's card lists, drawn beside that card; none for that preview itself. */
    readonly inner: TabPreviewState | null;
    private readonly parent: TabPreviewState | null;
    private readonly changed: () => void;
    private resting: PreviewTarget | null = null;
    private waiting = 0;
    private lastKeyPress = 0;
    /** Where the pointer was as it left the card's tab, or as it entered the last tab it crossed heading for the card. */
    private aimOrigin: Point | null = null;

    /** Hears every change in what shows through `changed`. */
    constructor(changed: () => void, parent: TabPreviewState | null = null) {
        this.changed = changed;
        this.parent = parent;
        this.inner = parent ? null : new TabPreviewState(changed, this);
    }

    /** Whether a card shows or one is on its way, which a click or a key in the window takes down. */
    get isEngaged(): boolean {
        return this.shown !== null || this.resting !== null;
    }

    /** Where the cards that show are in the window: this one's, and the card of a tab a folder's card lists. */
    get shownCardFrames(): DOMRect[] {
        const frames: DOMRect[] = [];
        if (this.shown && this.cardFrame) frames.push(this.cardFrame);
        if (this.inner?.shown && this.inner.cardFrame) frames.push(this.inner.cardFrame);
        return frames;
    }

    /** Whether the person typed in the window a moment ago, so a card's search leaves the keyboard with what they were typing in. */
    get isTyping(): boolean {
        return performance.now() - this.lastKeyPress < typingPause;
    }

    // MARK: - Actions - Resting

    /** The pointer came to rest on `target`. */
    enter(target: PreviewTarget): void {
        this.resting = target;
        window.clearTimeout(this.waiting);
        if (this.shown && previewKey(this.shown) === previewKey(target)) {
            this.show(target);
            return;
        }
        let delay: number;
        const location = this.pointerLocation();
        if (!this.shown) {
            delay = restDelay;
        } else if (location && this.isHeadingForCard(location)) {
            this.aimOrigin = location;
            delay = aimDelay;
        } else {
            delay = moveDelay;
        }
        this.waiting = window.setTimeout(() => {
            const resting = this.resting;
            if (this.isPointerInCard || !resting || previewKey(resting) !== previewKey(target)) return;
            this.show(resting);
        }, delay);
    }

    /** The tab rested on moved, as when the sidebar scrolls or draws again under it. */
    move(target: PreviewTarget): void {
        if (!this.resting || previewKey(this.resting) !== previewKey(target)) return;
        this.resting = target;
        if (!this.shown || previewKey(this.shown) !== previewKey(target)) return;
        // A row drawn again in the same place moves nothing, so drawing the card never feeds back into it.
        const before = this.shown.frame;
        const after = target.frame;
        if (before.left === after.left && before.top === after.top && before.width === after.width && before.height === after.height) {
            this.shown = target;
            return;
        }
        this.show(target);
    }

    /** The pointer left the tab or folder `key` names. */
    leave(key: string): void {
        if (this.shown && previewKey(this.shown) === key) this.aimOrigin = this.pointerLocation();
        if (!this.resting || previewKey(this.resting) !== key) return;
        this.resting = null;
        this.waitToLeave();
    }

    /** The person pressed a key in the window. */
    keyPressed(): void {
        this.lastKeyPress = performance.now();
    }

    /** The pointer went into the card or out of it. */
    pointerInCardChanged(isInside: boolean): void {
        if (this.isPointerInCard === isInside) return;
        this.isPointerInCard = isInside;
        if (isInside) {
            this.aimOrigin = null;
            window.clearTimeout(this.waiting);
        } else {
            this.waitToLeave();
            this.parent?.waitToLeave();
        }
        this.changed();
    }

    /** Something the card began started or ended. Once it ends, the card goes unless the pointer is back on it. */
    interactionChanged(isInteracting: boolean): void {
        if (this.isInteracting === isInteracting) return;
        this.isInteracting = isInteracting;
        if (isInteracting) window.clearTimeout(this.waiting);
        else this.waitToLeave();
    }

    /**
     * Takes the card down at once, as on Escape, a click, a scroll or a key,
     * and forgets the tab rested on, so the card comes back only when a tab
     * is entered again.
     */
    dismiss(): void {
        window.clearTimeout(this.waiting);
        this.resting = null;
        this.aimOrigin = null;
        this.isPointerInCard = false;
        this.isHeld = false;
        this.isInteracting = false;
        const had = this.shown !== null;
        this.shown = null;
        this.inner?.dismiss();
        if (had) this.changed();
    }

    private show(target: PreviewTarget): void {
        this.shown = target;
        this.changed();
    }

    /**
     * Whether the pointer, now at `location`, is inside the triangle from
     * where it left the card's tab to the card's near edge: on its way into
     * the card rather than to the tab it crosses.
     */
    private isHeadingForCard(location: Point): boolean {
        const origin = this.aimOrigin;
        const card = this.cardFrame;
        if (!origin || !card || (location.x === origin.x && location.y === origin.y)) return false;
        const edge = card.left + card.width / 2 > origin.x ? card.left : card.right;
        const corners: [Point, Point] = [
            { x: edge, y: card.top },
            { x: edge, y: card.bottom },
        ];
        const side = (a: Point, b: Point): number => (location.x - b.x) * (a.y - b.y) - (a.x - b.x) * (location.y - b.y);
        const sides = [side(origin, corners[0]), side(corners[0], corners[1]), side(corners[1], origin)];
        return !(sides.some((value) => value < 0) && sides.some((value) => value > 0));
    }

    /** Takes the card down after `leaveDelay` unless the pointer is back on its tab, in it, or in the card of a tab it lists. */
    private waitToLeave(): void {
        window.clearTimeout(this.waiting);
        if (!this.shown) return;
        this.waiting = window.setTimeout(() => {
            if (this.resting || this.isPointerInCard || this.isHeld || this.isInteracting) return;
            if (this.inner?.isPointerInCard) return;
            this.shown = null;
            this.inner?.dismiss();
            this.changed();
        }, leaveDelay);
    }
}
