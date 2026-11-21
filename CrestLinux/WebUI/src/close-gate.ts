// Closing a window and quitting on Linux ask the core first, as the Mac's
// BrowserWindowCloseGate and BrowserQuitPreparation do: the core asks every
// page that goes whether it may leave (a page's beforeunload), and before a
// quit, the person whether to stop the downloads still in progress. The
// window closes, or Crest quits, only once the core says every page agreed.

import { textsOfSpaceDeletionUnderway } from "../generated/crest_contracts.js";
import type { Change, CloseIntent, Guid } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { dispatch, Refused } from "./bridge.js";
import { Notices, postNotice } from "./notices.js";

export class CloseGate {
    /** The close preparations this window started, by request, each answered once the core says. */
    private readonly waiting = new Map<Guid, (allowed: boolean) => void>();
    /** How to close the question about downloads in progress, while it waits. */
    private readonly dismissals = new Map<Guid, () => void>();
    /** The quit waits for a Space's deletion, and the person was told. */
    private isDeferred = false;

    /** Whether the core is asking this window's pages now. */
    get isAsking(): boolean {
        return this.waiting.size > 0;
    }

    /** Follows the core: a preparation this window started ended, or asks the person something. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            if (change.kind === "CloseReady") {
                const answer = this.waiting.get(change.value.requestId);
                this.waiting.delete(change.value.requestId);
                answer?.(change.value.allowed);
            } else if (change.kind === "QuitWithDownloadsAsked" && this.waiting.has(change.value.requestId)) {
                this.askToQuitWithDownloads(change.value.promptId, change.value.liveDownloads);
            } else if (change.kind === "PromptSettled") {
                this.dismissals.get(change.value.promptId)?.();
                this.dismissals.delete(change.value.promptId);
            }
        }
    }

    /** Whether the pages `pageIds` may go, once each agreed, as a Quick Window's close asks. */
    mayClosePages(pageIds: readonly Guid[]): Promise<boolean> {
        return this.prepare((requestId) => ({ kind: "PrepareToClosePages", value: { requestId, pageIds } }));
    }

    /** Whether the windows `windowIds` may close, once the pages that go with them agreed. */
    mayCloseWindows(windowIds: readonly Guid[]): Promise<boolean> {
        return this.prepare((requestId) => ({ kind: "PrepareToCloseWindows", value: { requestId, windowIds } }));
    }

    /**
     * Whether Crest may quit, once every page agreed and the person agreed to
     * stop the downloads in progress. While a Space's data is being erased
     * the core defers the quit, which the person is told once.
     */
    async mayQuit(): Promise<boolean> {
        try {
            const allowed = await this.prepare((requestId) => ({ kind: "PrepareToQuit", value: { requestId } }), true);
            this.isDeferred = false;
            return allowed;
        } catch (error) {
            if (!(error instanceof Refused) || error.rejection.kind !== "SpaceDeletionUnderway") throw error;
            if (!this.isDeferred) {
                this.isDeferred = true;
                postNotice({ ...Notices.failure(textsOfSpaceDeletionUnderway(error.rejection.value).message.text), symbol: "trash" });
            }
            // TODO(linux): the Mac asks to quit again once the deletion it
            // waits for ends; here the person closes the window again.
            return false;
        }
    }

    /**
     * Hands the core the preparation `intent` makes for a new request, and
     * answers whether it allowed the close. Another preparation under way
     * answers false; with `throws`, so does no other refusal.
     */
    private async prepare(intent: (requestId: Guid) => CloseIntent, throws = false): Promise<boolean> {
        const requestId = crypto.randomUUID();
        const answer = new Promise<boolean>((resolve) => this.waiting.set(requestId, resolve));
        try {
            // The core answers a preparation with nothing to wait for in the
            // changes it returns.
            this.apply(await dispatch(intent(requestId)));
        } catch (error) {
            this.waiting.delete(requestId);
            if (error instanceof Refused && error.rejection.kind === "ClosePreparationUnderway") return false;
            if (throws) throw error;
            console.error(error);
            return false;
        }
        return answer;
    }

    /** Asks whether to quit and stop the downloads in progress, as the Mac's alert does. */
    private askToQuitWithDownloads(promptId: Guid, count: number): void {
        const answer = (quits: boolean): void => {
            this.dismissals.delete(promptId);
            void dispatch({ kind: "AnswerQuitWithDownloads", value: { promptId, quits } }).catch(console.error);
        };
        const dismiss = showAlert({
            title: count === 1 ? "Quit and cancel the download in progress?" : `Quit and cancel ${count} downloads in progress?`,
            buttons: [
                { title: "Keep Browsing", role: "cancel", action: () => answer(false) },
                { title: "Quit", role: "default", action: () => answer(true) },
            ],
        });
        this.dismissals.set(promptId, dismiss);
    }
}
