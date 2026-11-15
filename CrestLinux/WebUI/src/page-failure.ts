// A page whose engine could not make it, as the Mac's BrowserWebPageFailureOverlay
// shows a process failure: in the page's card, the words the core gives a
// stopped web content process, and Try Again. The core decides what the card
// shows (PresentPage) from the tab's surface and its page: a page that failed
// to load shows the navigation failure, which outranks this. A renderer that
// stops is the core's to bring back; once it gives up, the page carries that
// as its navigation failure, which the card's failure view shows.

import { NavigationError } from "../generated/crest_contracts.js";
import type { Guid, PagePresentation, PageState, PresentPage, TabState } from "../generated/crest_contracts.js";
import { dispatch, query } from "./bridge.js";

/** What the core answered for each question the card asked, so each is asked once. */
const answers = new Map<string, PagePresentation>();
const asking = new Set<string>();

export class ProcessFailureView {
    private readonly tab: () => TabState | undefined;
    private readonly page: () => PageState | undefined;
    private readonly report: (error: unknown) => void;
    private readonly view: HTMLElement;
    private shownPageId: Guid | null = null;

    constructor(tab: () => TabState | undefined, page: () => PageState | undefined, report: (error: unknown) => void) {
        this.tab = tab;
        this.page = page;
        this.report = report;
        this.view = document.createElement("div");
        this.view.className = "failure";
        this.view.hidden = true;
        document.getElementById("page")!.append(this.view);
    }

    /** Shows the view while the core says the shown tab's card shows a process failure. */
    follow(): void {
        const tab = this.tab();
        const page = this.page();
        const question: PresentPage = {
            surface: tab?.surface ?? null,
            hasPage: page !== undefined,
            hasNavigationFailure: page?.live.failure != null,
            hasProcessFailure: page?.phase === "Failed",
            restoresUnloaded: false,
        };
        const key = JSON.stringify(question);
        const answer = answers.get(key);
        if (answer === undefined) {
            if (asking.has(key)) return;
            asking.add(key);
            void query("PresentPage", question)
                .then((presented) => {
                    answers.set(key, presented.presentation);
                    this.follow();
                })
                .catch(this.report)
                .finally(() => asking.delete(key));
            return;
        }
        this.show(answer === "ProcessFailure" && page ? page : null);
    }

    private show(page: PageState | null): void {
        this.view.hidden = page === null;
        if (page?.id === this.shownPageId) return;
        this.shownPageId = page?.id ?? null;
        if (!page) {
            this.view.replaceChildren();
            return;
        }
        const facts = NavigationError.facts.WebContentProcessStopped;
        const text = (tag: keyof HTMLElementTagNameMap, className: string, words: string): HTMLElement => {
            const made = document.createElement(tag);
            made.className = className;
            made.textContent = words;
            return made;
        };
        // Trying again lets the page go, so the tab opens a page anew.
        const retry = text("button", "failure-button prominent", "Try Again");
        retry.addEventListener("click", () =>
            void dispatch({ kind: "ReleasePage", value: { pageId: page.id, keepsState: false } }).catch(this.report),
        );
        const actions = text("div", "failure-actions", "");
        actions.append(retry);
        this.view.replaceChildren(
            text("h1", "failure-title", facts.title.text),
            text("p", "failure-message", facts.message.text),
            text("p", "failure-suggestion", facts.primarySuggestion.text),
            text("p", "failure-suggestion", facts.secondarySuggestion.text),
            actions,
            text("p", "failure-code", facts.code),
        );
    }
}
