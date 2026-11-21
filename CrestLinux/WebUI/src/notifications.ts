// Web notifications on Linux, as the Mac's BrowserPage+WebNotifications and
// ChromiumProfileNotifications show them: the engine presents each
// notification a page's document, a worker or an extension posts; the core
// decides whether the page's Space (or the profile) shows the site's
// notifications; the desktop's notification service shows it as Crest's; a
// click brings the page's tab and its window forward before the engine
// answers the document (AnswerWebNotification). One that will not show is
// declined, so the document hears it closed.
//
// Every window's page hears every notification; the browser window used
// last is the one that shows them, and the others leave them to it.
//
// TODO(linux): the Mac also takes down what shows once the core stops letting
// a Space or profile show a site's notifications (followNotificationAccess),
// and shows the site's icon; Linux shows neither yet.

import {
    closeNotification,
    listenToNotificationClicks,
    pageRequest,
    presentThisWindow,
    query,
    showNotification,
    showsNotifications,
} from "./bridge.js";
import type {
    EnginePresentation,
    Guid,
    Intent,
    ProfileNotificationPosted,
    SiteOrigin,
    WebNotificationAnswer,
    WebNotificationPosted,
} from "../generated/crest_contracts.js";
import type { Model } from "./model.js";

export interface WebNotificationHost {
    readonly model: Model;
    readonly windowId: () => Guid;
    readonly send: (intent: Intent) => void;
    readonly report: (error: unknown) => void;
}

/** A notification the engine posted, until it is clicked, declined or withdrawn. */
type Posted =
    | { readonly kind: "page"; readonly posted: WebNotificationPosted }
    | { readonly kind: "profile"; readonly posted: ProfileNotificationPosted };

/** The most profile notifications kept at once, as the Mac keeps. */
const profileLimit = 256;

export class WebNotifications {
    private readonly host: WebNotificationHost;
    private readonly posted = new Map<string, Posted>();

    constructor(host: WebNotificationHost) {
        this.host = host;
        listenToNotificationClicks((key) => this.clicked(key));
    }

    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "WebNotificationPosted": {
                const posted = presentation.value;
                const key = pageKey(posted.pageId, posted.notificationId);
                this.posted.set(key, { kind: "page", posted });
                void this.show(key).catch(this.host.report);
                break;
            }
            case "ProfileNotificationPosted": {
                const posted = presentation.value;
                const key = profileKey(posted.profileId, posted.notificationId);
                if (!this.posted.has(key) && this.profileCount() >= profileLimit) {
                    this.answer({ kind: "profile", posted }, "Declined");
                    break;
                }
                this.posted.set(key, { kind: "profile", posted });
                void this.show(key).catch(this.host.report);
                break;
            }
            case "WebNotificationClosed":
                this.withdraw(pageKey(presentation.value.pageId, presentation.value.notificationId));
                break;
            case "ProfileNotificationClosed":
                this.withdraw(profileKey(presentation.value.profileId, presentation.value.notificationId));
                break;
            default:
                break;
        }
    }

    /**
     * Shows the notification `key` names when the core lets it show, and
     * declines it when the core or the desktop does not. The window that
     * leaves notifications to another neither shows nor declines it.
     */
    private async show(key: string): Promise<void> {
        const entry = this.posted.get(key);
        if (!entry || !(await showsNotifications())) return;
        const allowed = await this.allows(entry);
        // Withdrawn or posted again while the core answered.
        if (this.posted.get(key) !== entry) return;
        if (!allowed) {
            this.decline(key, entry);
            return;
        }
        const { title, body, silent, origin } = entry.posted;
        const shown = await showNotification(key, { title, site: origin.host || siteText(origin), body, silent });
        if (shown === "declined" && this.posted.get(key) === entry) this.decline(key, entry);
    }

    private async allows(entry: Posted): Promise<boolean> {
        if (entry.kind === "profile") {
            const { profileId, origin, source } = entry.posted;
            return (await query("ProfileNotificationDisplayCheck", { profileId, origin, source })).shows;
        }
        const page = this.host.model.pages.get(entry.posted.pageId);
        if (!page) return false;
        return (await query("NotificationDisplayCheck", { spaceId: page.spaceId, origin: entry.posted.origin })).shows;
    }

    private decline(key: string, entry: Posted): void {
        this.posted.delete(key);
        this.answer(entry, "Declined");
    }

    private withdraw(key: string): void {
        if (!this.posted.delete(key)) return;
        closeNotification(key);
    }

    /**
     * The person clicked a notification this window showed: the page's tab
     * comes forward in this window, and Crest with it, before the document
     * hears the click.
     */
    private clicked(key: string): void {
        const entry = this.posted.get(key);
        if (!entry) return;
        this.posted.delete(key);
        if (entry.kind === "page") {
            const page = this.host.model.pages.get(entry.posted.pageId);
            if (page?.tabId) {
                this.host.send({ kind: "ShowTab", value: { windowId: this.host.windowId(), spaceId: page.spaceId, tabId: page.tabId } });
            }
        }
        presentThisWindow();
        this.answer(entry, "Clicked");
    }

    private answer(entry: Posted, answer: WebNotificationAnswer): void {
        const request =
            entry.kind === "page"
                ? pageRequest("AnswerWebNotification", { pageId: entry.posted.pageId, notificationId: entry.posted.notificationId, answer })
                : pageRequest("AnswerProfileNotification", {
                      profileId: entry.posted.profileId,
                      notificationId: entry.posted.notificationId,
                      answer,
                  });
        void request.catch(this.host.report);
    }

    private profileCount(): number {
        let count = 0;
        for (const entry of this.posted.values()) if (entry.kind === "profile") count++;
        return count;
    }
}

function pageKey(pageId: Guid, notificationId: string): string {
    return `page.${pageId}.${notificationId}`;
}

function profileKey(profileId: Guid, notificationId: string): string {
    return `profile.${profileId}.${notificationId}`;
}

function siteText(origin: SiteOrigin): string {
    return `${origin.scheme}://${origin.host}${origin.port ? `:${origin.port}` : ""}`;
}
