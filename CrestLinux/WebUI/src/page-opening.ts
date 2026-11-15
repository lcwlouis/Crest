// A page that has not drawn its first document yet, as the Mac's page
// surface shows it: the page's view stays hidden behind the card's own
// colour until the first navigation commits, and once the first load has
// run for 0.4 seconds the card says it is opening, with a spinner and the
// host it opens. A load that finishes sooner goes straight from the card to
// the page.

import type { Change, Guid, PageState } from "../generated/crest_contracts.js";
import type { FloatEvent } from "./float.js";
import type { PageLayerState } from "./page-layers.js";
import { shownCard } from "./page-cards.js";
import { FloatRank } from "./surfaces.js";
import type { FloatSurface, FloatSurfaces } from "./surfaces.js";

/** How long a first load runs before the card says the page is opening. */
const statusDelay = 400;

/** The card's own colour, as sidebar.css paints it where no page shows. */
function cardColour(): string {
    const probe = document.createElement("div");
    probe.style.background = "color-mix(in srgb, var(--sidebar), white 50%)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
}

export class PageOpening implements FloatSurface {
    readonly rank = FloatRank.opening;
    readonly exclusive = false;
    private readonly page: () => PageState | undefined;
    private readonly surfaces: FloatSurfaces;
    /** Pages that drew a document: their first navigation committed, or they were seen settled on one. */
    private readonly drawn = new Set<Guid>();
    /** The page whose first load has run long enough to say it is opening. */
    private due: Guid | null = null;
    /** The page the wait runs for. */
    private waiting: Guid | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(page: () => PageState | undefined, surfaces: FloatSurfaces) {
        this.page = page;
        this.surfaces = surfaces;
        surfaces.add(this);
        new ResizeObserver(() => this.place()).observe(document.getElementById("page")!);
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.place());
    }

    /** Follows the core's pages: one that settled on a document has drawn it. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            if (change.kind === "PageRemoved") this.drawn.delete(change.value.pageId);
            if (change.kind !== "PageOpened" && change.kind !== "PageChanged") continue;
            const { id, live } = change.value.page;
            if (live.url !== null && !live.isLoading) this.drawn.add(id);
        }
        this.place();
    }

    /** The engine committed a navigation of `pageId`. */
    committed(pageId: Guid): void {
        this.drawn.add(pageId);
        this.place();
    }

    restore(): void {
        this.place();
    }

    handle(_event: FloatEvent): void {}

    /** Whether `page` shows in the card but has drawn no document yet. */
    private covers(page: PageState | undefined): page is PageState {
        return page !== undefined && page.phase === "Live" && page.live.failure === null && !this.drawn.has(page.id);
    }

    private place(): void {
        const page = this.page();
        if (!this.covers(page)) {
            this.wait(null);
            this.surfaces.post(this, null);
            return;
        }
        const navigating = page.live.isLoading || page.live.pendingUrl !== null;
        this.wait(navigating ? page.id : null);
        const card = shownCard().getBoundingClientRect();
        const state: PageLayerState = {
            kind: "opening",
            background: cardColour(),
            status: navigating && this.due === page.id ? this.status(page) : null,
        };
        this.surfaces.post(this, {
            bounds: { x: card.left, y: card.top, width: card.width, height: card.height },
            focus: false,
            state,
            band: "card",
        });
    }

    /** Starts the wait before `pageId` says it is opening, unless it already runs or ran. */
    private wait(pageId: Guid | null): void {
        if (pageId !== null && (this.due === pageId || this.waiting === pageId)) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.waiting = pageId;
        this.due = null;
        if (pageId === null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.waiting = null;
            this.due = pageId;
            this.place();
        }, statusDelay);
    }

    /** "Opening example.com…", or without a host to name, "Opening page…". */
    private status(page: PageState): string {
        let host = "";
        try {
            host = new URL(page.live.pendingUrl ?? page.live.url ?? "").hostname;
        } catch {
            // No address to name.
        }
        return host ? `Opening ${host}…` : "Opening page…";
    }
}
