// The engine's bars for a page (InfoBarShown, InfoBarRemoved), stacked at
// the top of the page's card as the Mac's BrowserEngineInfoBarStack shows
// them: the engine's message with its buttons, a control that hides a bar
// the person can come back to, and one that dismisses a bar that allows it.
// The engine takes the answer (AnswerInfoBar) and withdraws the bar itself;
// a bar it no longer knows leaves at once. A hidden bar shows again once its
// page leaves the screen and comes back.

import type { Change, Guid, InfoBarRemoved, InfoBarShown, PageState } from "../generated/crest_contracts.js";
import { pageRequest } from "./bridge.js";
import type { FloatEvent } from "./float.js";
import { infoBarMaxWidth, infoBarPadding, infoBarStack, measure } from "./page-layers.js";
import type { InfoBarState, PageLayerState } from "./page-layers.js";
import { shownCard } from "./page-cards.js";
import { FloatRank } from "./surfaces.js";
import type { FloatSurface, FloatSurfaces } from "./surfaces.js";

export class InfoBars implements FloatSurface {
    readonly rank = FloatRank.infoBars;
    readonly exclusive = false;
    private readonly page: () => PageState | undefined;
    private readonly surfaces: FloatSurfaces;
    private readonly bars = new Map<Guid, InfoBarState[]>();
    private readonly minimized = new Map<Guid, Set<number>>();
    /** The page whose bars show now. */
    private shownPageId: Guid | null = null;

    constructor(page: () => PageState | undefined, surfaces: FloatSurfaces) {
        this.page = page;
        this.surfaces = surfaces;
        surfaces.add(this);
        new ResizeObserver(() => this.place()).observe(document.getElementById("page")!);
    }

    added(shown: InfoBarShown): void {
        const bar: InfoBarState = {
            id: shown.infoBarId,
            message: shown.message,
            acceptLabel: shown.acceptLabel,
            cancelLabel: shown.cancelLabel,
            closeable: shown.closeable,
            minimizable: shown.minimizable,
        };
        const bars = (this.bars.get(shown.pageId) ?? []).filter((held) => held.id !== bar.id);
        this.bars.set(shown.pageId, [...bars, bar]);
        this.place();
    }

    removed(removed: InfoBarRemoved): void {
        this.drop(removed.pageId, removed.infoBarId);
    }

    /** Follows the core's pages and the page the window shows. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            if (change.kind !== "PageRemoved") continue;
            this.bars.delete(change.value.pageId);
            this.minimized.delete(change.value.pageId);
        }
        this.place();
    }

    restore(): void {
        this.place();
    }

    handle(event: FloatEvent): void {
        switch (event.kind) {
            case "infoBarAnswer":
                void pageRequest("AnswerInfoBar", { pageId: event.pageId, infoBarId: event.infoBarId, answer: event.answer })
                    .then((taken) => {
                        if (!taken) this.drop(event.pageId, event.infoBarId);
                    })
                    .catch((error: unknown) => {
                        console.error(error);
                        this.drop(event.pageId, event.infoBarId);
                    });
                this.surfaces.returnKeyboard();
                break;
            case "infoBarMinimize": {
                const hidden = this.minimized.get(event.pageId) ?? new Set<number>();
                hidden.add(event.infoBarId);
                this.minimized.set(event.pageId, hidden);
                this.place();
                this.surfaces.returnKeyboard();
                break;
            }
            default:
                break;
        }
    }

    private drop(pageId: Guid, infoBarId: number): void {
        const bars = this.bars.get(pageId);
        if (!bars) return;
        this.bars.set(
            pageId,
            bars.filter((bar) => bar.id !== infoBarId),
        );
        this.minimized.get(pageId)?.delete(infoBarId);
        this.place();
    }

    private place(): void {
        const pageId = this.page()?.id ?? null;
        if (pageId !== this.shownPageId) {
            // The bars the person hid show again when they come back to the page.
            if (this.shownPageId) this.minimized.delete(this.shownPageId);
            this.shownPageId = pageId;
        }
        const hidden = pageId ? this.minimized.get(pageId) : undefined;
        const bars = (pageId ? (this.bars.get(pageId) ?? []) : []).filter((bar) => !hidden?.has(bar.id));
        if (!pageId || bars.length === 0) {
            this.surfaces.post(this, null);
            return;
        }
        const card = shownCard().getBoundingClientRect();
        const width = Math.min(infoBarMaxWidth, Math.max(0, card.width - 2 * infoBarPadding)) + 2 * infoBarPadding;
        const state: PageLayerState = { kind: "infoBars", pageId, bars };
        const size = measure(infoBarStack(state, () => {}), width);
        this.surfaces.post(this, {
            bounds: { x: card.left + (card.width - width) / 2, y: card.top, width, height: size.height },
            focus: false,
            state,
            band: "top",
        });
    }
}
