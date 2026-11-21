// The media sessions Crest's pages publish, as the Mac's
// BrowserMediaSessionStore and BrowserMediaSessionPageCoordinator keep them
// for the Now Playing card. The engine presents each page's session under a
// document identity Crest issues once the page commits a document
// (ActivateMediaSession); the core decides which reports count and what they
// do (MediaSessionReport) and the order the sessions show in
// (MediaSessionOrder); this keeps what the card shows and asks the engine for
// the card's actions.
//
// Every window hears every report and keeps the same sessions; the browser
// window used last issues the document identities, so the engine follows one.
//
// Chromium's own MPRIS service, which the desktop's media controls and keys
// reach, follows the same pages on its own: no Crest patch turns its hardware
// media key handling off on Linux.
// TODO(linux): MPRIS's Raise brings the page's window forward through the
// engine's browser window, but not the page's tab in Crest's sidebar, as the
// Mac's BrowserSystemNowPlayingCoordinator does.

import { isFrontWindow, pageRequest, query } from "./bridge.js";
import type {
    EnginePresentation,
    Guid,
    MediaPlaybackState,
    MediaSessionAction,
    MediaSessionChanged,
    MediaSessionEventDecision,
} from "../generated/crest_contracts.js";
import type { Model } from "./model.js";

/** One session the card shows, as the Mac's BrowserMediaSessionSnapshot. */
export interface MediaSession {
    /** The tab and the document, which name the session. */
    readonly id: string;
    readonly pageId: Guid;
    readonly tabId: Guid;
    readonly spaceId: Guid;
    readonly document: string;
    /** The tab's title when the session was reported. */
    readonly ownerTitle: string | null;
    readonly title: string | null;
    readonly artist: string | null;
    readonly album: string | null;
    /** The artwork, as an address the card's image loads. */
    readonly artwork: string | null;
    readonly playback: MediaPlaybackState;
    readonly audible: boolean;
    readonly muted: boolean;
    readonly actions: readonly MediaSessionAction[];
    readonly ordinal: bigint;
}

/** The tab's title the card names, or the Mac's stand-in. */
export function ownerDisplayTitle(session: MediaSession): string {
    return session.ownerTitle ?? "Media tab";
}

/** The media's title the card names, or the Mac's stand-in. */
export function mediaDisplayTitle(session: MediaSession): string {
    return session.title ?? "Media from this tab";
}

/** The artist and album, as the Mac joins them. */
export function secondaryMetadata(session: MediaSession): string | null {
    const parts = [session.artist, session.album].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(" · ") : null;
}

/** Whether the card offers mute: Crest saw the session play, whatever handlers the page set. */
export function exposesMute(session: MediaSession): boolean {
    return session.playback !== "None";
}

// The bounds the Mac's page event decoder holds a report to.
const maximumTextLength = 512;
const maximumDocumentLength = 128;
const maximumLocationLength = 4_096;
const maximumArtworkBytes = 4 * 1_024 * 1_024;

function bounded(text: string | null): string | null {
    const trimmed = text?.trim() ?? "";
    return trimmed.length > 0 && trimmed.length <= maximumTextLength ? trimmed : null;
}

/** What a page shows now, as the coordinator follows its navigations. */
interface PageDocument {
    document: string | null;
    location: string | null;
}

export interface MediaSessionHost {
    readonly model: Model;
    readonly report: (error: unknown) => void;
    /** The sessions or the cards changed. */
    readonly changed: () => void;
}

export class MediaSessions {
    private readonly host: MediaSessionHost;
    /** Published sessions in the core's display order. */
    private ordered: MediaSession[] = [];
    private readonly snapshots = new Map<string, MediaSession>();
    private readonly pages = new Map<string, Guid>();
    private readonly lastSequence = new Map<string, bigint>();
    private sequenceOrder: string[] = [];
    private readonly retired = new Set<string>();
    private readonly ordinals = new Map<string, bigint>();
    private nextOrdinal = 1n;
    /** Sessions the person hid; each comes back once its tab plays again. */
    private readonly dismissed = new Set<string>();
    private readonly documents = new Map<Guid, PageDocument>();
    /** Reports wait for the one before, since the core decides each against what the last left. */
    private queue: Promise<void> = Promise.resolve();

    constructor(host: MediaSessionHost) {
        this.host = host;
    }

    /** Every session, in the core's order. */
    get sessions(): readonly MediaSession[] {
        return this.ordered;
    }

    /** The sessions the card shows: all but the ones the person hid. */
    get shown(): readonly MediaSession[] {
        return this.ordered.filter((session) => !this.dismissed.has(session.id));
    }

    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "PageNavigationStarted":
                this.prepareForNavigation(presentation.value.pageId);
                break;
            case "PageNavigationCommitted": {
                const { pageId, url } = presentation.value;
                this.documents.set(pageId, { document: crypto.randomUUID(), location: url });
                this.issue(pageId);
                break;
            }
            case "PageLoadingChanged":
                if (!presentation.value.isLoading) this.issue(presentation.value.pageId);
                break;
            case "PageViewClosed":
            case "PageRendererGone":
                this.prepareForNavigation(presentation.value.pageId);
                this.documents.delete(presentation.value.pageId);
                break;
            case "MediaSessionChanged": {
                const event = presentation.value;
                this.enqueue(() => this.receive(event));
                break;
            }
            default:
                break;
        }
    }

    // --- The card's actions -----------------------------------------------

    /** Hides the session's card until its tab plays again. */
    dismiss(session: MediaSession): void {
        if (this.dismissed.has(session.id)) return;
        this.dismissed.add(session.id);
        this.host.changed();
    }

    toggleMute(session: MediaSession): void {
        if (!exposesMute(session)) return;
        const { pageId, document } = session;
        void pageRequest("MuteMediaSession", { pageId, document, muted: !session.muted }).catch(this.host.report);
    }

    perform(action: MediaSessionAction, session: MediaSession): void {
        if (!session.actions.includes(action)) return;
        const { pageId, document } = session;
        void pageRequest("PerformMediaAction", { pageId, document, action }).catch(this.host.report);
    }

    // --- The pages ----------------------------------------------------------

    /** The page leaves its document, and the sessions it published go with it. */
    private prepareForNavigation(pageId: Guid): void {
        const shown = this.documents.get(pageId);
        if (shown) shown.document = null;
        let changed = false;
        for (const [id, owner] of this.pages) {
            if (owner !== pageId) continue;
            this.retire(id);
            changed = true;
        }
        if (changed) this.enqueue(() => this.publish());
    }

    /** Tells the engine the document identity its reports for the page carry. */
    private issue(pageId: Guid): void {
        const document = this.documents.get(pageId)?.document;
        if (!document) return;
        void isFrontWindow()
            .then((front) => (front ? pageRequest("ActivateMediaSession", { pageId, document }) : false))
            .catch(this.host.report);
    }

    private enqueue(work: () => Promise<void>): void {
        this.queue = this.queue.then(work).catch(this.host.report);
    }

    /**
     * Applies one report, as the Mac's store receives one: the core decides
     * whether it counts and whether it publishes, clears or retires the
     * session. A window that did not issue the document still follows the
     * session the engine reports for the page's committed address.
     */
    private async receive(event: MediaSessionChanged): Promise<void> {
        if (!event.document || event.document.length > maximumDocumentLength || event.location.length > maximumLocationLength) return;
        const shown = this.documents.get(event.pageId);
        if (shown?.location !== undefined && shown.location !== null && shown.location !== event.location) return;
        const page = this.host.model.pages.get(event.pageId);
        if (!page?.tabId) return;
        const id = `${page.tabId}.${event.document}`;
        const previous = this.snapshots.get(id);
        const decision: MediaSessionEventDecision = await query("MediaSessionReport", {
            event: {
                sequence: event.sequence < 0n ? 0n : event.sequence,
                isInvalidated: false,
                hasActiveSession: event.active,
                playback: event.playback,
                isMuted: event.muted,
                actions: event.actions,
            },
            identity: {
                isRetired: this.retired.has(id),
                lastSequence: this.lastSequence.get(id) ?? null,
                ordinal: this.ordinals.get(id) ?? null,
                isDismissed: this.dismissed.has(id),
                previousPlayback: previous?.playback ?? null,
            },
            retainedIdentities: this.lastSequence.size,
            nextOrdinal: this.nextOrdinal,
        });
        if (!decision.accepted || decision.evictOldest < 0) return;
        this.recordSequence(id, event.sequence < 0n ? 0n : event.sequence, decision.evictOldest);
        this.pages.set(id, event.pageId);
        switch (decision.disposition) {
            case "Retire":
                this.retire(id);
                break;
            case "Clear":
                this.drop(id);
                break;
            case "Publish":
                if (!this.publishSession(id, event, page.tabId, page.spaceId, decision)) return;
                break;
        }
        await this.publish();
    }

    private publishSession(id: string, event: MediaSessionChanged, tabId: Guid, spaceId: Guid, decision: MediaSessionEventDecision): boolean {
        if (decision.supersedesTabSiblings) {
            for (const other of [...this.pages.keys()]) {
                if (other !== id && other.startsWith(`${tabId}.`)) this.retire(other);
            }
        }
        if (decision.ordinal === null) return false;
        this.ordinals.set(id, decision.ordinal);
        this.nextOrdinal = decision.nextOrdinal;
        if (decision.clearsDismissal) this.dismissed.delete(id);
        const tab = this.host.model.workspace?.spaces.get(spaceId)?.tabs.find((candidate) => candidate.id === tabId);
        this.drop(id);
        this.snapshots.set(id, {
            id,
            pageId: event.pageId,
            tabId,
            spaceId,
            document: event.document,
            ownerTitle: bounded(tab?.displayTitle ?? null),
            title: bounded(event.title),
            artist: bounded(event.artist),
            album: bounded(event.album),
            artwork: event.artwork && event.artwork.length <= maximumArtworkBytes ? URL.createObjectURL(new Blob([new Uint8Array(event.artwork)])) : null,
            playback: event.playback,
            audible: event.audible,
            muted: event.muted,
            actions: event.actions,
            ordinal: decision.ordinal,
        });
        return true;
    }

    /** Orders the sessions as the core arbitrates them, or keeps the order they had. */
    private async publish(): Promise<void> {
        const current = [...this.snapshots.values()];
        let next: MediaSession[] | null = null;
        try {
            const answer = await query("MediaSessionOrder", {
                sessions: current.map((session) => ({
                    id: session.id,
                    ordinal: session.ordinal,
                    playback: session.playback,
                    isAudible: session.audible,
                })),
            });
            const valid =
                answer.order.length === current.length &&
                new Set(answer.order).size === answer.order.length &&
                answer.order.every((index) => index >= 0 && index < current.length);
            if (valid) next = answer.order.map((index) => current[index]!);
        } catch (error) {
            console.error(error);
        }
        if (!next) {
            const placed = this.ordered.filter((session) => this.snapshots.get(session.id) === session);
            const placedIds = new Set(placed.map((session) => session.id));
            const arrivals = current.filter((session) => !placedIds.has(session.id)).sort((a, b) => (a.ordinal < b.ordinal ? -1 : 1));
            next = [...placed, ...arrivals];
        }
        this.ordered = next;
        this.host.changed();
    }

    private drop(id: string): void {
        const artwork = this.snapshots.get(id)?.artwork;
        if (artwork) URL.revokeObjectURL(artwork);
        this.snapshots.delete(id);
    }

    private retire(id: string): void {
        this.drop(id);
        this.pages.delete(id);
        this.ordinals.delete(id);
        this.dismissed.delete(id);
        this.retired.add(id);
    }

    private recordSequence(id: string, sequence: bigint, requested: number): void {
        if (!this.lastSequence.has(id)) this.sequenceOrder.push(id);
        this.lastSequence.set(id, sequence);
        const overflow = Math.min(requested, Math.max(this.sequenceOrder.length - 1, 0));
        if (overflow <= 0) return;
        for (const expired of this.sequenceOrder.slice(0, overflow)) {
            this.lastSequence.delete(expired);
            this.retired.delete(expired);
            if (!this.snapshots.has(expired)) {
                this.pages.delete(expired);
                this.ordinals.delete(expired);
                this.dismissed.delete(expired);
            }
        }
        this.sequenceOrder = this.sequenceOrder.slice(overflow);
    }
}
