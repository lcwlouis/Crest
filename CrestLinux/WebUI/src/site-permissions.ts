// Each open page's side of the core's site permission choices, as the Mac's
// BrowserPageSitePermissionSession and PlatformPage+BlockedPopups keep it.
//
// The core decides every answer: this only carries them to the page's engine
// and keeps the page's one blocked-popup indication, whose rules are the
// core's too (BlockedPopupTransition). A change made anywhere (the page's own
// permission card, Site Controls, the Space's settings) reaches the page at
// once rather than on its next navigation:
//
// - Chromium enforces some permissions itself, so it is told the core's
//   answer for the page's site whenever the page commits a document and
//   whenever a change covers that site.
// - Automatic pop-ups stay blocked by the engine's own blocker until the
//   person allows them for the site; a popup it held back shows as the site
//   control's notice, which offers to allow them and opens the held popups.

import { BlockedPopupPageState, BlockedPopupStatus, SitePermission, SitePermissionDecision } from "../generated/crest_contracts.js";
import type {
    BlockedPopupEvent,
    Change,
    EnginePresentation,
    Guid,
    PageState,
    SiteOrigin,
    SitePermissionScope,
} from "../generated/crest_contracts.js";
import { dispatch, pageRequest, query } from "./bridge.js";
import type { Model } from "./model.js";
import { sameSite, siteOriginOf } from "./site-origin.js";

// MARK: - Types

/** The one blocked-popup indication a page shows, as BrowserBlockedPopupNotice. */
export interface BlockedPopupNotice {
    readonly origin: SiteOrigin;
    readonly status: BlockedPopupStatus;
}

/** What one page keeps between the engine's reports. */
interface PageSession {
    /** Documents the page committed, which names the one it shows to the popup rules. */
    commits: number;
    popups: BlockedPopupPageState;
    /** The popup work in flight, which runs in order so each step reads the state the last one left. */
    queue: Promise<void>;
}

/** The permissions the engine enforces itself; Crest's record decides them and the engine is told. */
const engineEnforced: readonly SitePermission[] = SitePermission.all.filter(
    (permission) => SitePermission.facts[permission].isEngineEnforced,
);

/** The permissions whose changes a page follows. */
const observed: readonly SitePermission[] = [...engineEnforced, "Popups"];

export class SitePermissionSessions {
    // MARK: - Variables

    private readonly model: Model;
    private readonly sessions = new Map<Guid, PageSession>();
    private readonly listeners: (() => void)[] = [];

    // MARK: - Initializers

    constructor(model: Model) {
        this.model = model;
    }

    // MARK: - Actions - Reading

    /** Hears a page's blocked-popup indication change. */
    onChange(listener: () => void): void {
        this.listeners.push(listener);
    }

    /** The indication the page's site control draws, or null. */
    notice(pageId: Guid): BlockedPopupNotice | null {
        const popups = this.sessions.get(pageId)?.popups;
        return popups?.status && popups.origin ? { origin: popups.origin, status: popups.status } : null;
    }

    /**
     * The choice that answers `permission` for `origin` in the Space, as the
     * Mac's BrowserSitePermissionCenter asks it. An unavailable core asks.
     */
    static async decision(spaceId: Guid, origin: SiteOrigin, permission: SitePermission): Promise<SitePermissionDecision> {
        try {
            const facts = SitePermission.facts[permission];
            const answer =
                facts.isMedia && facts.isEngineEnforced
                    ? await query("CaptureDecision", { spaceId, origin, media: permission })
                    : await query("SiteDecision", { spaceId, origin, permission, detail: null });
            return answer.decision;
        } catch (error) {
            console.error(error);
            return "Ask";
        }
    }

    // MARK: - Actions - Following the core and the engine

    /** Follows a batch of the core's changes. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            switch (change.kind) {
                case "SitePermissionsChanged":
                    for (const page of this.model.pages.values()) {
                        if (page.spaceId === change.value.spaceId) this.follow(page, change.value.touched);
                    }
                    break;
                case "PageRemoved":
                    this.sessions.delete(change.value.pageId);
                    break;
                default:
                    break;
            }
        }
    }

    /** Hears one of the engine's presentations. */
    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "PageNavigationStarted":
                // What belonged to the document the page leaves ends with it.
                this.transition(presentation.value.pageId, "Navigation");
                break;
            case "PageNavigationCommitted": {
                const { pageId, url } = presentation.value;
                this.session(pageId).commits += 1;
                const page = this.model.pages.get(pageId);
                const origin = siteOriginOf(url);
                if (!page || !origin) break;
                this.synchronizePopups(page, origin);
                for (const permission of engineEnforced) void this.tellEngine(page, origin, permission);
                break;
            }
            case "PopupBlocked":
                void this.blocked(presentation.value.pageId, presentation.value.pageUrl);
                break;
            default:
                break;
        }
    }

    // MARK: - Actions - Blocked popups

    /**
     * Allows automatic pop-ups for the site whose popup the page blocked, in
     * the page's Space, and opens the popups the engine kept, as
     * allowAutomaticPopupsForBlockedSite.
     */
    async allowBlockedPopups(page: PageState): Promise<void> {
        const notice = this.notice(page.id);
        const origin = siteOriginOf(page.live.address ?? page.live.url);
        if (!notice || !BlockedPopupStatus.facts[notice.status].offersAllow || !sameSite(origin, notice.origin)) return;
        await dispatch({
            kind: "DecideSitePermission",
            value: {
                spaceId: page.spaceId,
                origin: notice.origin,
                permission: "Popups",
                detail: null,
                decision: "GrantPersistently",
            },
        });
        // The engine takes the allowance and the notice moves on before the
        // popups the engine kept open.
        this.synchronizePopups(page, notice.origin);
        await this.session(page.id).queue;
        const opened = await pageRequest("ShowBlockedPopups", { pageId: page.id }).catch((error: unknown) => {
            console.error(error);
            return false;
        });
        if (opened) this.transition(page.id, "PopupAllowed");
    }

    private async blocked(pageId: Guid, pageUrl: string): Promise<void> {
        const page = this.model.pages.get(pageId);
        const origin = siteOriginOf(pageUrl);
        if (!page || !origin) return;
        // The popup belongs to the document the page showed when it was held back.
        const documentId = String(this.session(pageId).commits);
        const decision = await SitePermissionSessions.decision(page.spaceId, origin, "Popups");
        if (SitePermissionDecision.facts[decision].grants) return;
        this.transition(pageId, "Blocked", origin, documentId);
    }

    /** Tells the engine the site's popup choice, and moves the notice the page shows for that site. */
    private synchronizePopups(page: PageState, origin: SiteOrigin): void {
        const session = this.session(page.id);
        session.queue = session.queue.then(async () => {
            const decision = await SitePermissionSessions.decision(page.spaceId, origin, "Popups");
            const allows = SitePermissionDecision.facts[decision].grants;
            // The engine's own blocker takes the site's allowance, and
            // otherwise its default of blocking.
            await pageRequest("SetSitePermission", { pageId: page.id, permission: "Popups", allowed: allows ? true : null }).catch(
                (error: unknown) => console.error(error),
            );
            if (!sameSite(session.popups.origin, origin)) return;
            await this.step(page.id, allows ? "PermissionAllowed" : "PermissionBlockedAgain");
        });
    }

    /** Moves the page's indication on by `event`, after the work already in flight. */
    private transition(pageId: Guid, event: BlockedPopupEvent, origin: SiteOrigin | null = null, documentId: string | null = null): void {
        const session = this.session(pageId);
        session.queue = session.queue.then(() => this.step(pageId, event, origin, documentId));
    }

    /** The page's indication after `event`, as the core's notice rules answer it; nothing changes when they refuse it. */
    private async step(
        pageId: Guid,
        event: BlockedPopupEvent,
        origin: SiteOrigin | null = null,
        documentId: string | null = null,
    ): Promise<void> {
        const session = this.sessions.get(pageId);
        if (!session) return;
        try {
            const answer = await query("BlockedPopupTransition", {
                state: session.popups,
                event,
                documentIdentifier: documentId,
                origin,
            });
            if (!answer.state) return;
            session.popups = answer.state;
        } catch (error) {
            console.error(error);
            return;
        }
        for (const listener of this.listeners) listener();
    }

    // MARK: - Actions - Engine-enforced permissions

    /** Carries a change that covered the page's site to its engine. */
    private follow(page: PageState, touched: readonly SitePermissionScope[]): void {
        const origin = siteOriginOf(page.live.url);
        if (!origin) return;
        const affected = new Set<SitePermission>();
        for (const scope of touched) {
            if (scope.detail !== null || (scope.origin && !sameSite(scope.origin, origin))) continue;
            for (const permission of observed) if (covers(scope.permission, permission)) affected.add(permission);
        }
        for (const permission of affected) {
            if (permission === "Popups") this.synchronizePopups(page, origin);
            else void this.tellEngine(page, origin, permission);
        }
    }

    /**
     * Tells the engine the core's answer for `permission` at `origin`: a
     * capture device by the core's capture rule, which reads a combined
     * camera and microphone choice too, any other by the site's own. Ask
     * leaves the engine to ask.
     */
    private async tellEngine(page: PageState, origin: SiteOrigin, permission: SitePermission): Promise<void> {
        const decision = await SitePermissionSessions.decision(page.spaceId, origin, permission);
        const facts = SitePermissionDecision.facts[decision];
        await pageRequest("SetSitePermission", {
            pageId: page.id,
            permission,
            allowed: facts.asks ? null : facts.grants,
        }).catch((error: unknown) => console.error(error));
    }

    private session(pageId: Guid): PageSession {
        let session = this.sessions.get(pageId);
        if (!session) {
            session = { commits: 0, popups: BlockedPopupPageState.empty, queue: Promise.resolve() };
            this.sessions.set(pageId, session);
        }
        return session;
    }
}

/** Whether a change to `changed` (every permission when null) covers `permission`; a combined capture choice answers each of its devices. */
function covers(changed: SitePermission | null, permission: SitePermission): boolean {
    return changed === null || changed === permission || SitePermission.facts[changed].components.includes(permission);
}
