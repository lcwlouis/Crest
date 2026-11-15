// Site Controls on Linux, as the Mac's BrowserSiteControlButton: the slider
// glyph in the address field's trailing slot, marked in the warning colour
// while the page blocked a pop-up, and the popover it opens below it on
// Crest's flyout surface (BrowserSiteControlPopover, 292 wide, 520 tall
// while its permissions are open, never past 560). The popover holds, in the
// Mac's order:
//
// - the page's title and host (BrowserSiteControlHeader);
// - the blocked pop-up's notice, with Allow Automatic Pop-ups
//   (BrowserBlockedPopupSiteControlNotice);
// - the quick actions (BrowserSiteQuickActions);
// - the site's origin, its connection and certificate
//   (BrowserSiteSecuritySection), and each permission's choice for the site
//   in the page's Space (BrowserSitePermissionDisclosure);
// - clearing the site's cookies or cache (BrowserSiteDataActions).
//
// Every choice is the core's: the rows ask it (SiteDecision) and send the
// person's choice (DecideSitePermission), and draw what it answers after the
// change it publishes. The page's engine hears the choice from
// SitePermissionSessions.
//
// Left out until Linux has them: Capture and Inspect among the quick actions
// (region capture and docked DevTools), the extensions grid (step 16), the
// Developer Mode status (the developer toolbar), Open This Page in another
// Space (the Quick Window), and the Opens in engine row, which shows only
// where a device registered more than one engine.

import { BlockedPopupStatus, BrowsingDataCategory, PageSecurity, SitePermission, SitePermissionDecision } from "../generated/crest_contracts.js";
import type { Change, Guid, PageState, SiteOrigin } from "../generated/crest_contracts.js";
import { dispatch, pageRequest, query, showCertificate } from "./bridge.js";
import { Menu } from "./menu.js";
import type { MenuEntry } from "./menu.js";
import type { Model, Space } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import { holdOverlay } from "./overlay.js";
import { element } from "./sidebar.js";
import { siteName, siteOriginOf } from "./site-origin.js";
import { SitePermissionSessions } from "./site-permissions.js";
import type { BlockedPopupNotice } from "./site-permissions.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

export interface SiteControlsHost {
    readonly model: Model;
    readonly sessions: SitePermissionSessions;
    /** The page the window shows. */
    readonly page: () => PageState | undefined;
    readonly report: (error: unknown) => void;
}

/** BrowserSiteControlMetrics. */
const metrics = {
    width: 292,
    expandedHeight: 520,
    maximumHeight: 560,
    /** Between the trigger and the popover, and the popover and the window's edges. */
    gap: 6,
    margin: 8,
} as const;

/** The permissions list starts open where it first appears (BrowserSitePermissionDisclosure.defaultIsExpanded). */
const permissionsStartExpanded = true;

/** A blocked pop-up's notice as the site control names it (BrowserBlockedPopupNotice+Presentation). */
function noticeTitle(notice: BlockedPopupNotice): string {
    return BlockedPopupStatus.facts[notice.status].offersAllow
        ? `Pop-up blocked for ${notice.origin.host}`
        : `Pop-ups allowed for ${notice.origin.host}`;
}

/** The host of the address the page shows the person, or "" for none. */
function hostOf(address: string | null): string {
    if (!address) return "";
    try {
        return new URL(address).hostname;
    } catch {
        return "";
    }
}

function glyph(name: string, size: number, className = "site-control-glyph"): HTMLElement {
    const slot = element("span", className);
    slot.innerHTML = sfSymbol(name, size);
    return slot;
}

/** A quiet control on a resting fill, as CrestChromeButtonStyle(showsRestingFill:). */
function quietButton(label: string, symbolName: string, act: () => void, showsTitle: boolean): HTMLButtonElement {
    const button = element("button", showsTitle ? "site-control-action titled" : "site-control-action");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(glyph(symbolName, showsTitle ? 12 : 13));
    if (showsTitle) button.append(element("span", "site-control-action-title", label));
    button.addEventListener("click", act);
    return button;
}

// MARK: - Site Controls

export class SiteControls {
    // MARK: - Variables

    /** The control the address field shows in its trailing slot. */
    readonly trigger: HTMLButtonElement;
    private readonly host: SiteControlsHost;
    private popover: SiteControlsPopover | null = null;
    /** Site data clearings the core has yet to report, by request. */
    private readonly clearings = new Map<Guid, (deleted: boolean) => void>();

    // MARK: - Initializers

    constructor(host: SiteControlsHost) {
        this.host = host;
        this.trigger = element("button", "site-control-trigger");
        this.trigger.type = "button";
        this.trigger.innerHTML = sfSymbol("slider.horizontal.3", 12);
        this.trigger.append(element("span", "site-control-badge"));
        this.trigger.addEventListener("click", (event) => {
            event.stopPropagation();
            this.toggle();
        });
        host.sessions.onChange(() => this.follow());
        this.follow();
    }

    // MARK: - Actions - Following the window

    /** Whether the popover is open. */
    get isOpen(): boolean {
        return this.popover !== null;
    }

    /**
     * Draws the trigger for the shown page, which a page with no address
     * leaves out, and the open popover again; a popover whose page the window
     * no longer shows closes, as the Mac's ends at a Space change.
     */
    follow(): void {
        const page = this.host.page();
        const shows = page !== undefined && page.live.address !== null;
        this.trigger.hidden = !shows;
        const notice = page ? this.host.sessions.notice(page.id) : null;
        this.trigger.classList.toggle("warning", notice !== null);
        const label = notice ? `${noticeTitle(notice)}. Site Controls` : "Site Controls";
        this.trigger.title = label;
        this.trigger.setAttribute("aria-label", label);
        this.trigger.setAttribute("aria-description", notice ? "Opens the Automatic Pop-ups permission and retry guidance" : "Opens controls for this website");
        this.trigger.setAttribute("aria-expanded", String(this.popover !== null));
        if (!this.popover) return;
        if (!shows || page.id !== this.popover.pageId) this.close();
        else this.popover.render(page);
    }

    /** Follows a batch of the core's changes. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            if (change.kind === "DataDeleted") {
                const waiter = this.clearings.get(change.value.requestId);
                this.clearings.delete(change.value.requestId);
                waiter?.(change.value.deleted);
            } else if (change.kind === "SitePermissionsChanged" && this.popover) {
                const page = this.host.page();
                if (page && page.spaceId === change.value.spaceId) this.popover.refreshDecisions(page);
            }
        }
        this.follow();
    }

    toggle(): void {
        if (this.popover) {
            this.close();
            return;
        }
        const page = this.host.page();
        if (!page || page.live.address === null) return;
        this.popover = new SiteControlsPopover(this, page, this.trigger);
        this.follow();
    }

    close(): void {
        const popover = this.popover;
        if (!popover) return;
        this.popover = null;
        popover.remove();
        this.trigger.setAttribute("aria-expanded", "false");
    }

    // MARK: - Actions - What the popover does

    get model(): Model {
        return this.host.model;
    }

    get sessions(): SitePermissionSessions {
        return this.host.sessions;
    }

    report(error: unknown): void {
        this.host.report(error);
    }

    /** Runs `action` once the popover has closed, as the Mac's quick actions do. */
    dismissing(action: () => Promise<unknown> | void): void {
        this.close();
        window.setTimeout(() => {
            void Promise.resolve()
                .then(action)
                .catch((error: unknown) => this.report(error));
        });
    }

    /** Copies the page's address as Super Copy hands it out, and says so (copyDeveloperPageLink). */
    async copyLink(page: PageState): Promise<void> {
        if (!page.live.url) return;
        const link = await query("LinkToCopy", { url: page.live.url });
        await navigator.clipboard.writeText(link);
        postNotice(Notices.urlCopied);
    }

    reload(page: PageState): Promise<boolean> {
        return pageRequest("ReloadPage", { pageId: page.id, bypassesCache: false });
    }

    /**
     * Clears what the page's site keeps in `category` in its Space, reloads
     * the page from the network, then says how it went, as the Mac's
     * BrowserPage.clearSiteData.
     */
    async clearSiteData(page: PageState, category: BrowsingDataCategory): Promise<void> {
        const host = hostOf(page.live.address);
        const space = this.space(page);
        if (!host || !space) return;
        const requestId = crypto.randomUUID();
        const cleared = new Promise<boolean>((resolve) => this.clearings.set(requestId, resolve));
        try {
            await dispatch({
                kind: "DeleteSiteData",
                value: { requestId, profileId: space.state.profileId, ephemeral: false, hosts: [host], categories: [category] },
            });
        } catch (error) {
            this.clearings.delete(requestId);
            throw error;
        }
        const deleted = await cleared;
        await pageRequest("ReloadPage", { pageId: page.id, bypassesCache: true }).catch((error: unknown) => console.error(error));
        postNotice(Notices.siteData(category, deleted));
    }

    /** The Space the page belongs to. */
    space(page: PageState): Space | undefined {
        return this.host.model.workspaces.get(page.workspaceId)?.spaces.get(page.spaceId);
    }
}

// MARK: - The popover

class SiteControlsPopover {
    // MARK: - Variables

    readonly pageId: Guid;
    private readonly controls: SiteControls;
    private readonly anchor: HTMLElement;
    private readonly layer = element("div", "site-control-layer");
    private readonly panel = element("div", "site-controls");
    private readonly release = holdOverlay();
    private readonly restoreFocus: Element | null = document.activeElement;
    private readonly listeners: [EventTarget, string, EventListener][] = [];
    private permissionsExpanded = permissionsStartExpanded;
    /** Each permission's choice for the site, as the core last answered it. */
    private decisions = new Map<SitePermission, SitePermissionDecision>();
    /** Whether the engine verified a certificate the person can review, once it answered. */
    private hasCertificate = false;
    private lastPage: PageState;
    /** What the popover last drew from, so a change that touches none of it leaves the person's focus and pointer be. */
    private drawn = "";

    // MARK: - Initializers

    constructor(controls: SiteControls, page: PageState, anchor: HTMLElement) {
        this.controls = controls;
        this.pageId = page.id;
        this.anchor = anchor;
        this.lastPage = page;
        // A blocked pop-up opens the popover on the permission it is about.
        if (controls.sessions.notice(page.id)) this.permissionsExpanded = true;
        this.panel.setAttribute("role", "dialog");
        this.panel.setAttribute("aria-label", "Site Controls");
        this.panel.tabIndex = -1;
        this.layer.append(this.panel);
        document.body.append(this.layer);
        // A press outside the popover closes it and goes no further.
        this.layer.addEventListener("mousedown", (event) => {
            if (event.target !== this.layer) return;
            event.preventDefault();
            controls.close();
        });
        this.listen(window, "keydown", (event) => {
            if ((event as KeyboardEvent).key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            controls.close();
        });
        this.listen(window, "resize", () => controls.close());
        this.listen(window, "blur", () => {
            // A menu the popover opened keeps it.
            if (!Menu.isOpen) controls.close();
        });
        this.render(page);
        this.panel.focus({ preventScroll: true });
        this.refreshDecisions(page);
        void this.readCertificate(page);
    }

    remove(): void {
        for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener);
        this.layer.remove();
        this.release();
        if (this.restoreFocus instanceof HTMLElement && this.restoreFocus.isConnected) this.restoreFocus.focus({ preventScroll: true });
    }

    private listen(target: EventTarget, type: string, listener: EventListener): void {
        target.addEventListener(type, listener);
        this.listeners.push([target, type, listener]);
    }

    // MARK: - Actions - Reading the core

    /** Asks the core each permission's choice for the page's site, and draws the answers. */
    refreshDecisions(page: PageState): void {
        const origin = siteOriginOf(page.live.address);
        if (!origin) return;
        void Promise.all(
            SitePermission.all.map(
                async (permission) => [permission, await SitePermissionSessions.decision(page.spaceId, origin, permission)] as const,
            ),
        ).then((answers) => {
            if (!this.layer.isConnected) return;
            this.decisions = new Map(answers);
            this.render(this.lastPage);
        });
    }

    /** A certificate is offered for review only for an HTTPS document whose certificate the engine reports. */
    private async readCertificate(page: PageState): Promise<void> {
        if (siteOriginOf(page.live.address)?.scheme !== "https") return;
        try {
            const chain = await pageRequest("PageCertificates", { pageId: page.id });
            this.hasCertificate = chain.certificates.length > 0;
        } catch (error) {
            console.error(error);
            this.hasCertificate = false;
        }
        if (this.layer.isConnected) this.render(this.lastPage);
    }

    // MARK: - Drawing

    render(page: PageState): void {
        this.lastPage = page;
        const drawn = JSON.stringify([
            page.live.title,
            page.live.address,
            page.live.security,
            this.controls.sessions.notice(page.id),
            [...this.decisions],
            this.permissionsExpanded,
            this.hasCertificate,
        ]);
        if (drawn === this.drawn) return;
        this.drawn = drawn;
        const scroll = this.panel.scrollTop;
        const content = element("div", "site-controls-content");
        content.append(this.header(page));
        const notice = this.controls.sessions.notice(page.id);
        if (notice) content.append(this.notice(page, notice));
        content.append(this.quickActions(page), element("div", "site-control-divider"));
        const origin = siteOriginOf(page.live.address);
        if (origin) content.append(this.siteSettings(page, origin));
        if (hostOf(page.live.address)) content.append(element("div", "site-control-divider"), this.dataActions(page));
        this.panel.replaceChildren(content);
        this.panel.style.height = this.permissionsExpanded ? `${metrics.expandedHeight}px` : "";
        this.place();
        this.panel.scrollTop = scroll;
    }

    /** Below the trigger, as the Mac's popover with its arrow on the top edge, inside the window. */
    private place(): void {
        const anchor = this.anchor.getBoundingClientRect();
        const available = window.innerHeight - anchor.bottom - metrics.gap - metrics.margin;
        this.panel.style.maxHeight = `${Math.max(120, Math.min(metrics.maximumHeight, available))}px`;
        const left = anchor.left + anchor.width / 2 - metrics.width / 2;
        this.panel.style.left = `${Math.round(Math.max(metrics.margin, Math.min(left, window.innerWidth - metrics.margin - metrics.width)))}px`;
        this.panel.style.top = `${Math.round(anchor.bottom + metrics.gap)}px`;
    }

    private header(page: PageState): HTMLElement {
        const header = element("div", "site-control-header");
        header.append(element("div", "site-control-title", page.live.title || "Site Controls"));
        const host = hostOf(page.live.address);
        if (host) header.append(element("div", "site-control-host", host));
        return header;
    }

    private notice(page: PageState, notice: BlockedPopupNotice): HTMLElement {
        const facts = BlockedPopupStatus.facts[notice.status];
        const box = element("div", "site-control-notice");
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", noticeTitle(notice));
        const title = element("div", "site-control-notice-title");
        title.append(glyph(facts.symbol, 12), element("span", "", noticeTitle(notice)));
        box.append(title, element("p", "site-control-notice-guidance", facts.guidance.text));
        if (facts.offersAllow) {
            const allow = element("button", "site-control-primary", "Allow Automatic Pop-ups");
            allow.type = "button";
            allow.setAttribute("aria-label", `Allow automatic pop-ups for ${notice.origin.host}`);
            allow.setAttribute("aria-description", "Saves this permission in the current Space. Retry the action on the site afterward");
            allow.addEventListener("click", () => {
                this.permissionsExpanded = true;
                void this.controls.sessions.allowBlockedPopups(page).catch((error: unknown) => this.controls.report(error));
            });
            box.append(allow);
        }
        return box;
    }

    private quickActions(page: PageState): HTMLElement {
        const row = element("div", "site-control-actions");
        row.append(
            quietButton("Copy Link", "square.and.arrow.up", () => this.controls.dismissing(() => this.controls.copyLink(page)), false),
            quietButton("Reload", "arrow.clockwise", () => this.controls.dismissing(() => this.controls.reload(page)), false),
            // TODO(linux): Capture and Inspect, once Linux has region capture and docked DevTools.
        );
        return row;
    }

    /** BrowserSiteSettingsContent: the site's origin, connection and permissions. */
    private siteSettings(page: PageState, origin: SiteOrigin): HTMLElement {
        const settings = element("div", "site-control-settings");
        settings.setAttribute("role", "group");
        settings.setAttribute("aria-label", "Site Settings");
        settings.append(this.security(page, origin), element("div", "site-control-divider"), this.permissions(page, origin));
        return settings;
    }

    /** BrowserSiteSecuritySection. */
    private security(page: PageState, origin: SiteOrigin): HTMLElement {
        const section = element("div", "site-control-security");
        section.append(element("div", "site-control-origin", siteName(origin)));
        const security = PageSecurity.facts[page.live.security];
        // An HTTPS page the engine judged secure but whose certificate it
        // could not hand over is not called secure.
        const unconfirmed = security.isSecure && origin.scheme === "https" && !this.hasCertificate;
        const tint = unconfirmed ? "secondary" : security.isSecure ? "success" : security.isHazardous ? "danger" : "warning";
        const label = element("span", `site-control-security-label ${tint}`);
        label.append(
            glyph(unconfirmed ? "lock" : security.symbol, 12),
            element("span", "", unconfirmed ? "Connection Details Unavailable" : security.title.text),
        );
        if (this.hasCertificate) {
            const review = element("button", "site-control-certificate");
            review.type = "button";
            review.title = "Review Certificate";
            review.setAttribute("aria-label", "Review Certificate");
            review.append(label, element("span", "site-control-spacer"), element("span", "site-control-certificate-word", "Certificate"), glyph("chevron.right", 9, "site-control-chevron"));
            review.addEventListener("click", () => this.controls.dismissing(() => showCertificate(page.id)));
            section.append(review);
        } else {
            section.append(label);
        }
        if (security.detail) section.append(element("p", "site-control-detail", security.detail.text));
        return section;
    }

    /** BrowserSitePermissionDisclosure and its rows (BrowserSitePermissionRow). */
    private permissions(page: PageState, origin: SiteOrigin): HTMLElement {
        const section = element("div", "site-control-permissions");
        const disclosure = element("button", "site-control-disclosure");
        disclosure.type = "button";
        disclosure.setAttribute("aria-label", "Permissions");
        disclosure.setAttribute("aria-expanded", String(this.permissionsExpanded));
        disclosure.append(
            element("span", "", "Permissions"),
            element("span", "site-control-spacer"),
            glyph(this.permissionsExpanded ? "chevron.down" : "chevron.right", 9, "site-control-chevron"),
        );
        disclosure.addEventListener("click", () => {
            this.permissionsExpanded = !this.permissionsExpanded;
            this.panel.scrollTop = 0;
            this.render(page);
        });
        section.append(disclosure);
        if (!this.permissionsExpanded) return section;
        for (const permission of SitePermission.all) section.append(this.permissionRow(page, origin, permission));
        return section;
    }

    private permissionRow(page: PageState, origin: SiteOrigin, permission: SitePermission): HTMLElement {
        const facts = SitePermission.facts[permission];
        const decision = this.decisions.get(permission) ?? null;
        const row = element("div", "site-control-permission");
        const label = element("span", "site-control-permission-label");
        label.append(glyph(facts.symbol, 13), element("span", "", facts.title.text));
        const choice = element("button", "site-control-choice");
        choice.type = "button";
        choice.setAttribute("aria-haspopup", "menu");
        const current = decision === null ? "" : SitePermissionDecision.facts[decision].asks ? facts.askTitle.text : SitePermissionDecision.facts[decision].title.text;
        choice.append(element("span", "", current), glyph("chevron.down", 8, "site-control-chevron"));
        choice.setAttribute("aria-label", `${facts.title.text}: ${current}`);
        choice.addEventListener("click", () => {
            const decide = (chosen: SitePermissionDecision) => () =>
                void dispatch({
                    kind: "DecideSitePermission",
                    value: { spaceId: page.spaceId, origin, permission, detail: null, decision: chosen },
                }).catch((error: unknown) => this.controls.report(error));
            const entries: MenuEntry[] = [{ title: facts.askChoiceTitle.text, icon: { kind: "symbol", name: "questionmark.circle" }, action: decide("Ask") }];
            // The system asks each time for some capabilities, so nothing
            // allows a site ahead of that question.
            if (!facts.isAskedBySystem) entries.push({ title: "Allow", icon: { kind: "symbol", name: "checkmark.circle" }, action: decide("GrantPersistently") });
            entries.push({ title: "Block", icon: { kind: "symbol", name: "nosign" }, action: decide("DenyPersistently") });
            Menu.open(entries, { anchor: choice.getBoundingClientRect() });
        });
        row.append(label, element("span", "site-control-spacer"), choice);
        return row;
    }

    /** BrowserSiteDataActions: clearing the site's cookies or cache in the page's Space. */
    private dataActions(page: PageState): HTMLElement {
        const row = element("div", "site-control-actions");
        for (const category of BrowsingDataCategory.all.filter((member) => BrowsingDataCategory.facts[member].clearsBySite)) {
            const facts = BrowsingDataCategory.facts[category];
            row.append(
                quietButton(
                    (facts.clearSiteTitle ?? facts.title).text,
                    facts.symbol ?? "trash",
                    () => this.controls.dismissing(() => this.controls.clearSiteData(page, category)),
                    true,
                ),
            );
        }
        return row;
    }
}
