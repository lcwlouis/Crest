// Find in page, as the Mac's BrowserFindPort: the bar floats over the page's
// top corner on the floating surface, the engine finds (FindInPage) and says
// how many matches it found (FindFinished), and closing the bar clears the
// highlights.

import type { FindFinished, Guid, PageState } from "../generated/crest_contracts.js";
import { pageRequest, setFloat } from "./bridge.js";
import type { FloatEvent, FloatState } from "./float.js";

/** The bar and the margin its shadow draws in, BrowserFindBarMetrics. */
const width = 360;
const height = 52;
const inset = 6;

export class FindBar {
    private readonly page: () => PageState | undefined;
    private readonly report: (error: unknown) => void;
    private pageId: Guid | null = null;
    private query = "";
    private matches: number | null = null;
    private activeMatch = 0;

    constructor(page: () => PageState | undefined, report: (error: unknown) => void) {
        this.page = page;
        this.report = report;
        new ResizeObserver(() => this.place(false, null)).observe(document.getElementById("page")!);
    }

    get isOpen(): boolean {
        return this.pageId !== null;
    }

    open(): void {
        const page = this.page();
        if (!page) return;
        if (this.pageId !== page.id) {
            this.close();
            this.pageId = page.id;
            this.matches = null;
        }
        this.place(true, this.query);
    }

    close(): void {
        if (this.pageId && this.query) this.find(this.pageId, "", false);
        this.pageId = null;
        this.query = "";
        this.matches = null;
        setFloat({ x: 0, y: 0, width: 0, height: 0 }, false, { kind: "none" } satisfies FloatState);
    }

    step(backwards: boolean): void {
        if (!this.pageId) {
            this.open();
            return;
        }
        if (this.query) this.find(this.pageId, this.query, backwards);
    }

    /** The shown page changed: the bar belongs to the page it opened on. */
    follow(): void {
        if (this.pageId && this.page()?.id !== this.pageId) this.close();
    }

    handle(event: FloatEvent): void {
        if (!this.pageId) return;
        switch (event.kind) {
            case "findQuery":
                this.query = event.text;
                if (!event.text) this.matches = null;
                this.find(this.pageId, event.text, false);
                this.place(false, null);
                break;
            case "findNext":
            case "findPrevious":
                this.step(event.kind === "findPrevious");
                break;
            case "findClose":
                this.close();
                break;
        }
    }

    finished(result: FindFinished): void {
        if (result.pageId !== this.pageId) return;
        this.matches = result.matches;
        this.activeMatch = result.activeMatch;
        this.place(false, null);
    }

    /** Sends the bar where the page's card is, and what it shows. */
    place(focus: boolean, query: string | null): void {
        if (!this.pageId) return;
        const card = document.getElementById("page")!.getBoundingClientRect();
        const state: FloatState = { kind: "find", query, matches: this.matches, activeMatch: this.activeMatch };
        setFloat({ x: card.right - width - inset, y: card.top + inset, width, height }, focus, state);
    }

    private find(pageId: Guid, query: string, backwards: boolean): void {
        void pageRequest("FindInPage", { pageId, query, backwards, caseSensitive: false }).catch(this.report);
    }
}
