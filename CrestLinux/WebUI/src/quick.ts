// A Quick Window on Linux, as the Mac's BrowserQuickWindowView draws it: a
// small window over a browser window (its target) that shows one transient
// page of a Space, for a link another app handed Crest, a page's popup, or a
// lookup the person started with New Quick Window. Its toolbar holds Back
// and Forward, the address field with the Space it browses in (a picker for
// another) and Reload, and Open In, which keeps the page as a tab of the
// Space it names in the target window, as BrowserTransientPagePromotion does.
//
// Closing the window files its page in the Space's archive, unless the page
// moved to a tab or closed itself, and it closes itself once it has been left
// alone longer than the archive policy allows.

import type { Change, Guid, PageState } from "../generated/crest_contracts.js";
import { QuickWindowArchivePolicy } from "../generated/crest_contracts.js";
import {
    closeWindow,
    connect,
    dispatch,
    listenToWindow,
    pageRequest,
    presentWindow,
    query,
    Refused,
    registerShortcuts,
    setPageLayout,
    setWindowTitle,
    stackedWindows,
} from "./bridge.js";
import { foregroundTone, spaceIcon } from "./crest.js";
import { applyDeviceAppearance } from "./device-appearance.js";
import { Menu } from "./menu.js";
import { Model } from "./model.js";
import type { Space, Workspace } from "./model.js";
import { css } from "./sidebar.js";
import { sfSymbol } from "./symbols.js";

/** BrowserChromeLayout.pageCornerRadius. */
const pageCornerRadius = 13;

/** How the window was opened, from the parameters in its address. */
const parameters = new URLSearchParams(location.search);
const lower = (name: string): Guid | null => parameters.get(name)?.toLowerCase() ?? null;

class QuickWindow {
    private readonly model = new Model();
    /** The browser window the Quick Window opens over, which a kept page goes to. */
    private target: Guid | null = lower("target");
    /** The Space the window browses in. */
    private spaceId: Guid | null = lower("space");
    /** The page the window shows, or null while it shows the lookup start. */
    private pageId: Guid | null = lower("page");
    /** The address the window opened for, until its page has one of its own. */
    private initialURL: string | null = parameters.get("url");
    /** Whether the page moved to a tab or closed itself, which leaves nothing to archive. */
    private settled = false;
    private closing = false;
    /** Whether the window has read the core and chosen its page. */
    private started = false;
    private archiveTimer: ReturnType<typeof setTimeout> | null = null;
    private sentLayout = "";
    private shownURL: string | null = null;
    private title = "";

    private readonly card = document.getElementById("page")!;
    private readonly back = this.button("nav-control", "Back", "chevron.left", () => this.step(-1));
    private readonly forward = this.button("nav-control", "Forward", "chevron.right", () => this.step(1));
    private readonly spaceChip = this.button("quick-space-chip", "Choose Space", "", () => this.chooseSpace(this.spaceChip, false));
    private readonly secure = document.createElement("span");
    private readonly address = document.createElement("input");
    private readonly reload = this.button("nav-control quick-reload", "Reload", "arrow.clockwise", () => this.reloadOrStop());
    private readonly openIn = document.createElement("div");

    constructor() {
        applyDeviceAppearance();
        this.buildToolbar();
        new ResizeObserver(() => this.layout()).observe(this.card);
        window.addEventListener("resize", () => this.layout());
        // The person using the window keeps it from archiving itself.
        for (const event of ["pointerdown", "keydown", "wheel"]) {
            window.addEventListener(event, () => this.recordActivity(), { passive: true });
        }
        listenToWindow({
            closeRequested: () => void this.close(true),
            activeChanged: (active) => {
                if (active) this.recordActivity();
            },
            pageLeft: () => this.layout(),
            pageArrived: () => undefined,
            showSpace: () => undefined,
            openExternal: () => undefined,
        });
        registerShortcuts(
            [
                ["w", true, false, false, 0, true],
                ["l", true, false, false, 0, true],
                ["r", true, false, false, -1, true],
                ["o", true, false, false, 0, true],
                ["[", true, false, false, 0, true],
                ["]", true, false, false, 0, true],
                ["ArrowLeft", false, true, false, 0, true],
                ["ArrowRight", false, true, false, 0, true],
            ],
            (key) => this.handleKey(key),
            // The engine's Focus Location, from its own key or menu, is the address field here.
            (command) => {
                if (command === "OpenLocation") this.focusAddress();
            },
        );
        document.addEventListener("keydown", (event) => {
            if (this.handleKey(event)) event.preventDefault();
        });
    }

    async start(): Promise<void> {
        await connect(
            (changes) => this.follow(changes),
            () => undefined,
        );
        const workspace = this.workspace();
        // The window opens over the window used last, when none was named.
        this.target ??= (await stackedWindows())[0] ?? null;
        if (!workspace || !this.target) {
            closeWindow();
            return;
        }
        const popup = this.pageId ? this.model.pages.get(this.pageId) : undefined;
        if (this.pageId && !popup) {
            // The page a popup opened is gone already: the window has nothing to show.
            closeWindow();
            return;
        }
        if (popup) this.spaceId = popup.spaceId;
        this.spaceId ??= this.model.windows.get(this.target)?.shownSpaceId ?? workspace.order[0] ?? null;
        if (!this.pageId && this.initialURL) await this.openPage(this.initialURL);
        this.started = true;
        this.render();
        if (!this.pageId) this.focusAddress();
        this.recordActivity();
    }

    // --- Following the core ---------------------------------------------------

    private follow(changes: readonly Change[]): void {
        this.model.apply(changes);
        for (const change of changes) {
            if (change.kind === "TransientPageClosed" && change.value.pageId === this.pageId) {
                // The page closed itself, which closes the window.
                this.settled = true;
                void this.close(false);
                return;
            }
        }
        // A navigation is activity, which keeps the window from archiving itself while in use.
        const url = this.url();
        if (url !== this.shownURL) {
            this.shownURL = url;
            this.recordActivity();
        }
        const workspace = this.workspace();
        if (this.started && this.spaceId && workspace && !workspace.spaces.has(this.spaceId) && !this.closing) {
            // The Space went: the window lets its page go.
            void this.close(false);
            return;
        }
        this.render();
    }

    private workspace(): Workspace | undefined {
        return this.model.workspace;
    }

    private space(): Space | undefined {
        return this.spaceId ? this.workspace()?.spaces.get(this.spaceId) : undefined;
    }

    private page(): PageState | undefined {
        return this.pageId ? this.model.pages.get(this.pageId) : undefined;
    }

    /** Where the page is, or the address the window opened for. */
    private url(): string | null {
        const page = this.page();
        return page?.live.url ?? page?.live.address ?? this.initialURL;
    }

    // --- Drawing --------------------------------------------------------------

    private button(className: string, label: string, glyph: string, act: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = className;
        button.title = label;
        button.setAttribute("aria-label", label);
        if (glyph) button.innerHTML = sfSymbol(glyph);
        button.addEventListener("click", act);
        return button;
    }

    private buildToolbar(): void {
        const toolbar = document.getElementById("toolbar")!;
        const navigation = document.createElement("div");
        navigation.className = "quick-navigation";
        navigation.append(this.back, this.forward);
        const field = document.createElement("div");
        field.className = "quick-address";
        this.secure.className = "quick-secure";
        this.address.type = "text";
        this.address.spellcheck = false;
        this.address.placeholder = "Search or enter a website";
        this.address.setAttribute("aria-label", "Quick Window address");
        this.address.addEventListener("focus", () => {
            this.address.value = this.url() ?? "";
            this.address.select();
        });
        this.address.addEventListener("blur", () => this.showAddress());
        this.address.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                void this.submit(this.address.value);
            } else if (event.key === "Escape") {
                event.preventDefault();
                this.address.blur();
            }
        });
        field.append(this.spaceChip, this.secure, this.address, this.reload);
        this.openIn.className = "quick-open-in peek-open-in";
        toolbar.append(navigation, field, this.openIn);
    }

    private render(): void {
        const page = this.page();
        const space = this.space();
        this.back.disabled = !page?.live.canGoBack;
        this.forward.disabled = !page?.live.canGoForward;
        this.reload.disabled = !page;
        const loading = page?.live.isLoading ?? false;
        if (this.reload.dataset.loading !== String(loading)) {
            this.reload.dataset.loading = String(loading);
            this.reload.innerHTML = sfSymbol(loading ? "xmark" : "arrow.clockwise");
            this.reload.title = loading ? "Stop" : "Reload";
        }
        this.address.parentElement!.classList.toggle("loading", loading);
        this.showAddress();
        this.drawSpace(space);
        this.drawOpenIn(space);
        const title = page?.live.title || hostOf(this.url()) || "Quick Window";
        if (title !== this.title) {
            this.title = title;
            setWindowTitle(title);
        }
        document.body.classList.toggle("has-page", page?.phase === "Live");
        this.layout();
    }

    /** The field shows the page's host at rest and the whole address while the person edits it. */
    private showAddress(): void {
        const url = this.url();
        this.secure.innerHTML = url?.startsWith("https:") ? sfSymbol("lock", 13) : "";
        if (document.activeElement === this.address) return;
        this.address.value = hostOf(url).replace(/^www\./, "");
    }

    private drawSpace(space: Space | undefined): void {
        const key = JSON.stringify(space?.state.settings ?? null);
        if (this.spaceChip.dataset.key === key) return;
        this.spaceChip.dataset.key = key;
        this.spaceChip.replaceChildren();
        if (space) this.spaceChip.append(spaceIcon(space.state.settings, 18));
        this.spaceChip.title = space ? `Browsing in ${space.state.settings.name}` : "Choose Space";
    }

    /** Open In, in the Space's colour, and the menu of the other Spaces the page may go to. */
    private drawOpenIn(space: Space | undefined): void {
        const key = JSON.stringify(space?.state.settings ?? null);
        if (this.openIn.dataset.key === key) return;
        this.openIn.dataset.key = key;
        const primary = this.button("peek-open-primary", `Open in ${space?.state.settings.name ?? "Space"} (Ctrl+O)`, "", () =>
            void this.keep(this.spaceId),
        );
        primary.setAttribute("aria-label", "Open In…");
        if (space) primary.append(spaceIcon(space.state.settings, 18));
        const title = document.createElement("span");
        title.textContent = space?.state.settings.name ?? "Open In…";
        primary.append(title);
        const separator = document.createElement("span");
        separator.className = "peek-open-separator";
        const choose = this.button("peek-open-menu", "Open in another Space", "chevron.down", () => this.chooseSpace(choose, true));
        choose.setAttribute("aria-label", "Choose Destination Space");
        this.openIn.replaceChildren(primary, separator, choose);
        if (space) {
            const look = space.state.settings.look;
            const tint = look.colors.colors[0];
            this.openIn.style.setProperty("--peek-space-tint", tint ? css(tint) : "var(--space-tint)");
            const dark = matchMedia("(prefers-color-scheme: dark)").matches;
            this.openIn.classList.toggle("reads-light", foregroundTone(look, dark) === "light");
        }
    }

    /** Shows the page in the card, once the engine made it live. */
    private layout(): void {
        const page = this.page();
        const box = this.card.getBoundingClientRect();
        const placements =
            page && page.phase === "Live" && !this.closing
                ? [{ pageId: page.id, x: box.left, y: box.top, width: box.width, height: box.height, above: false, cornerRadius: pageCornerRadius }]
                : [];
        const focused = placements.length > 0 && document.activeElement !== this.address ? placements[0]!.pageId : "";
        const sent = JSON.stringify([placements, focused]);
        if (sent === this.sentLayout) return;
        this.sentLayout = sent;
        setPageLayout(placements, focused);
    }

    // --- Actions --------------------------------------------------------------

    /** The Spaces the page may browse in or go to: every one not being deleted. */
    private destinations(): Space[] {
        const workspace = this.workspace();
        if (!workspace) return [];
        const deleting = new Set(workspace.deletions.map((deletion) => deletion.spaceId));
        return workspace.order
            .map((id) => workspace.spaces.get(id))
            .filter((space): space is Space => space !== undefined && !deleting.has(space.state.id));
    }

    /** The Space picker: browsing in another Space, or with `keeps`, Open In's choice. */
    private chooseSpace(anchor: HTMLElement, keeps: boolean): void {
        Menu.open(
            this.destinations().map((space) => ({
                title: space.state.settings.name,
                icon: { kind: "space" as const, settings: space.state.settings },
                action: () => void (keeps ? this.keep(space.state.id) : this.selectSpace(space.state.id)),
            })),
            { anchor: anchor.getBoundingClientRect() },
        );
    }

    /**
     * Moves the window to the Space `spaceId`, as the Mac's selectSpace: the
     * page goes and the address opens there afresh, and moving a page (not
     * an empty lookup) remembers the Space for its site.
     */
    private async selectSpace(spaceId: Guid): Promise<void> {
        if (spaceId === this.spaceId) return;
        this.recordActivity();
        const url = this.url();
        await this.releasePage();
        this.spaceId = spaceId;
        if (url) {
            await this.send({ kind: "RememberQuickWindowSpace", value: { url, spaceId } });
            await this.openPage(url);
        }
        this.render();
    }

    /** Opens a transient page in the window's Space, over the target window, that loads `url`. */
    private async openPage(url: string): Promise<void> {
        const workspace = this.workspace();
        if (!workspace || !this.spaceId || !this.target) return;
        const pageId = crypto.randomUUID();
        this.pageId = pageId;
        this.initialURL = url;
        const opened = await this.send({
            kind: "OpenPage",
            value: {
                pageId,
                workspaceId: workspace.id,
                spaceId: this.spaceId,
                tabId: null,
                windowId: this.target,
                transient: "QuickWindow",
                openerPageId: null,
            },
        });
        if (!opened) {
            this.pageId = null;
            return;
        }
        await this.send({ kind: "LoadAddress", value: { pageId, url } });
    }

    /** Opens what the person typed: in the page the window shows, or a page it opens for it. */
    private async submit(input: string): Promise<void> {
        const text = input.trim();
        if (!text) return;
        this.recordActivity();
        let url: string | null;
        try {
            const resolved = await query("ResolveAddress", { workspaceId: this.workspace()?.id ?? null, spaceId: this.spaceId, input: text });
            url = resolved.url;
        } catch (error) {
            report(error);
            return;
        }
        if (!url) return;
        this.address.blur();
        const page = this.page();
        if (page) await this.send({ kind: "LoadAddress", value: { pageId: page.id, url } });
        else await this.openPage(url);
        this.render();
    }

    /**
     * Keeps the page as a tab of `spaceId` in the target window, which comes
     * forward showing it, as Open In does: the tab takes the live page when
     * the core says it can, else loads its address afresh; a page that has
     * been nowhere only shows the Space.
     */
    private async keep(spaceId: Guid | null): Promise<void> {
        const workspace = this.workspace();
        const target = this.target;
        if (!workspace || !target || !spaceId || this.closing) return;
        const page = this.page();
        const url = this.url();
        if (!page || !url) {
            await this.send({ kind: "ShowSpace", value: { windowId: target, spaceId } });
            presentWindow(target);
            await this.close(false);
            return;
        }
        let changes: Change[];
        try {
            changes = await dispatch({
                kind: "PromoteTransientPage",
                value: { workspaceId: workspace.id, windowId: target, pageId: page.id, spaceId, placement: "Current" },
            });
        } catch (error) {
            report(error);
            return;
        }
        if (spaceId !== this.spaceId) await this.send({ kind: "RememberQuickWindowSpace", value: { url, spaceId } });
        const promoted = changes.find((change) => change.kind === "TransientPagePromoted" && change.value.pageId === page.id);
        const adopts = promoted?.kind === "TransientPagePromoted" && promoted.value.adoptsPage;
        this.settled = true;
        // The target window shows the kept page, which leaves this window.
        if (adopts) this.pageId = null;
        presentWindow(target);
        await this.close(false);
    }

    /**
     * Closes the window. The person's close files the page in the Space's
     * archive, unless it moved to a tab or closed itself, then lets it go.
     */
    private async close(archives: boolean): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        if (this.archiveTimer) clearTimeout(this.archiveTimer);
        this.layout();
        const workspace = this.workspace();
        const page = this.page();
        if (archives && !this.settled && workspace && page && this.spaceId && page.live.url) {
            await this.send({ kind: "ArchiveTransientPage", value: { workspaceId: workspace.id, pageId: page.id, spaceId: this.spaceId } });
        }
        await this.releasePage();
        closeWindow();
    }

    /** Lets the window's page go, unless a tab took it. */
    private async releasePage(): Promise<void> {
        const pageId = this.pageId;
        this.pageId = null;
        if (!pageId || !this.model.pages.has(pageId)) return;
        await this.send({ kind: "ReleasePage", value: { pageId, keepsState: false } });
    }

    private step(offset: number): void {
        const page = this.page();
        if (page) void this.send({ kind: "StepHistory", value: { pageId: page.id, offset } });
    }

    private reloadOrStop(): void {
        const page = this.page();
        if (!page) return;
        const request = page.live.isLoading
            ? pageRequest("StopLoading", { pageId: page.id })
            : pageRequest("ReloadPage", { pageId: page.id, bypassesCache: false });
        void request.catch(report);
    }

    private focusAddress(): void {
        this.address.focus();
        this.layout();
    }

    /** The window's keys, from its own UI or taken from its page. */
    private handleKey(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
        if (event.metaKey) return false;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (event.altKey && !event.ctrlKey) {
            if (key === "ArrowLeft") this.step(-1);
            else if (key === "ArrowRight") this.step(1);
            else return false;
            return true;
        }
        if (!event.ctrlKey || event.altKey) return false;
        switch (key) {
            case "w":
                void this.close(true);
                return true;
            case "l":
                this.focusAddress();
                return true;
            case "r":
                this.reloadOrStop();
                return true;
            case "o":
                void this.keep(this.spaceId);
                return true;
            case "[":
                this.step(-1);
                return true;
            case "]":
                this.step(1);
                return true;
            default:
                return false;
        }
    }

    /**
     * Restarts the wait after which the window archives its page and closes,
     * as BrowserTransientArchiveTimer, while the archive policy names one.
     */
    private recordActivity(): void {
        if (this.archiveTimer) clearTimeout(this.archiveTimer);
        this.archiveTimer = null;
        const policy = this.model.linkPreferences?.archivePolicy;
        const lifetime = policy ? QuickWindowArchivePolicy.facts[policy].lifetime : null;
        if (lifetime === null || this.closing) return;
        this.archiveTimer = setTimeout(() => void this.close(true), lifetime * 1000);
    }

    private async send(intent: Parameters<typeof dispatch>[0]): Promise<boolean> {
        try {
            await dispatch(intent);
            return true;
        } catch (error) {
            // A page the core already let go needs nothing more.
            if (!(error instanceof Refused && intent.kind === "ReleasePage")) report(error);
            return false;
        }
    }
}

function hostOf(url: string | null): string {
    if (!url) return "";
    try {
        return new URL(url).host || url;
    } catch {
        return url;
    }
}

function report(error: unknown): void {
    console.error(error);
    const status = document.getElementById("status")!;
    status.textContent = error instanceof Refused ? `Crest refused: ${error.rejection.kind}` : String(error);
    status.hidden = false;
}

new QuickWindow().start().catch(report);
