// Crest's Settings, which the Mac shows as a native tab (NativeView.settings)
// and Linux draws in the page's card while the window shows that tab: a
// sidebar of pages (BrowserSettingsSidebar) with the build at its top, a
// search field, the pages, the Spaces and the last pages, beside the chosen
// page under its header (BrowserSettingsPane).
//
// Settings opens as the Mac's BrowserStore.openSettings does: the shown
// Space's Settings tab when it has one, else a new one in its current tabs.
// Every page draws the core's state and sends intents; this device's
// appearance choices are kept in localStorage (device-appearance.ts).

import { NativeView, Tincture } from "../generated/crest_contracts.js";
import type { Guid, Intent, TabState } from "../generated/crest_contracts.js";
import { dispatch, Refused } from "./bridge.js";
import { identityIcon } from "./crest.js";
import { DeviceAppearance } from "./device-appearance.js";
import { Menu } from "./menu.js";
import type { Model, Space, Workspace } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import type { Preferences } from "./preferences.js";
import { css } from "./sidebar.js";
import { explanation } from "./space-actions.js";
import type { SpaceActions, SpaceEditorIntent } from "./space-actions.js";
import type { SpaceEditor } from "./space-editor.js";
import { SpaceGroups } from "./space-groups.js";
import { destinationMatches, destinationNamed, primaryDestinations, secondaryDestinations, SettingsDestination } from "./settings-catalog.js";
import { element } from "./settings-form.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

/** The Space page's own pages (BrowserSettingsSpacePage.Section); Passwords and Extensions wait for Linux. */
export type SpaceSection = "appearance" | "browsing" | "privacy";

export type SettingsRoute =
    | { readonly kind: "page"; readonly name: string }
    | { readonly kind: "space"; readonly spaceId: Guid; readonly section: SpaceSection };

/** What a page reads and does. */
export interface SettingsContext {
    readonly model: Model;
    readonly preferences: Preferences;
    readonly workspace: () => Workspace | undefined;
    readonly windowId: () => Guid;
    /** Sends `intent`, and says why when the core refuses it. */
    readonly send: (intent: Intent) => Promise<boolean>;
    readonly spaces: SpaceActions;
    readonly go: (route: SettingsRoute) => void;
    /** Draws the page again. */
    readonly redraw: () => void;
}

/** A page's content, drawn again whenever what it shows changes. */
export type SettingsPage = (context: SettingsContext) => (HTMLElement | null)[];

/** A Space page's section other than Appearance, which the Space editor draws. */
export type SpaceSectionPage = (context: SettingsContext, space: Space) => (HTMLElement | null)[];

export interface SettingsHost {
    readonly model: Model;
    readonly preferences: Preferences;
    readonly windowId: () => Guid;
    readonly space: () => Space | undefined;
    readonly tab: () => TabState | undefined;
    readonly spaces: SpaceActions;
    readonly spaceEditor: SpaceEditor;
    readonly pages: Readonly<Record<string, SettingsPage>>;
    readonly spaceSections: Readonly<Record<Exclude<SpaceSection, "appearance">, SpaceSectionPage>>;
}

const routeKey = "crest.settings.route";
const settingsKind = NativeView.facts.Settings.name;

const spaceSections: readonly { readonly section: SpaceSection; readonly title: string }[] = [
    { section: "appearance", title: "Appearance" },
    { section: "browsing", title: "Browsing" },
    { section: "privacy", title: "Privacy" },
];

/** Whether `key` is Settings' own: Ctrl+, as the Mac's Command-comma. */
export function isSettingsKey(key: { readonly key: string; readonly ctrlKey: boolean; readonly altKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): boolean {
    return key.key === "," && key.ctrlKey && !key.altKey && !key.metaKey && !key.shiftKey;
}

/** The host's entry for Settings' key, reserved from pages as the Mac's menu key is. */
export const settingsShortcut: [string, boolean, boolean, boolean, number, boolean] = [",", true, false, false, 0, true];

export class Settings {
    private readonly host: SettingsHost;
    private readonly root = element("div", "settings");
    private readonly navigation = element("nav", "settings-sidebar");
    private readonly list = element("div", "settings-list");
    private readonly search = element("input", "settings-search");
    private readonly header = element("header", "settings-header");
    private readonly content = element("div", "settings-content");
    private readonly scroller = element("div", "settings-scroller");
    private route: SettingsRoute = { kind: "page", name: SettingsDestination.general.name };
    private embedded: { readonly spaceId: Guid; readonly header: HTMLElement; readonly body: HTMLElement } | null = null;
    private pressing = false;
    /** The Space whose name takes the keys once its page draws, as New Space… asks. */
    private namesSpace: Guid | null = null;
    private deferred = false;
    private readonly context: SettingsContext;

    constructor(host: SettingsHost, card: HTMLElement) {
        this.host = host;
        this.context = {
            model: host.model,
            preferences: host.preferences,
            workspace: () => host.model.workspace,
            windowId: host.windowId,
            send: (intent) => this.send(intent),
            spaces: host.spaces,
            go: (route) => this.go(route),
            redraw: () => {
                if (this.isShown) this.draw();
            },
        };
        try {
            const kept = JSON.parse(sessionStorage.getItem(routeKey) ?? "null") as SettingsRoute | null;
            if (kept && (kept.kind === "space" || destinationNamed(kept.name))) this.route = kept;
        } catch {
            // Settings opens on General.
        }
        this.search.type = "search";
        this.search.placeholder = "Search settings";
        this.search.setAttribute("aria-label", "Search settings");
        this.search.addEventListener("input", () => this.drawNavigation());
        this.navigation.setAttribute("aria-label", "Settings");
        this.navigation.append(this.buildHeader(), this.search, this.list);
        this.scroller.append(this.content);
        const main = element("div", "settings-main");
        main.append(this.header, this.scroller);
        this.root.append(this.navigation, main);
        this.root.hidden = true;
        this.root.addEventListener("pointerdown", () => (this.pressing = true), true);
        window.addEventListener(
            "pointerup",
            () => {
                if (!this.pressing) return;
                setTimeout(() => {
                    this.pressing = false;
                    this.flush();
                }, 0);
            },
            true,
        );
        this.root.addEventListener("focusout", () => setTimeout(() => this.flush(), 0));
        card.append(this.root);
        host.preferences.listen(() => this.follow());
        DeviceAppearance.listen(() => this.follow());
    }

    /** Whether the window shows Settings now. */
    get isShown(): boolean {
        return !this.root.hidden;
    }

    /**
     * Opens Settings, on `route` when given, as the Mac's openSettings:
     * the shown Space's Settings tab, or a new one among its current tabs.
     */
    open(route?: SettingsRoute): void {
        if (route) this.go(route);
        const workspace = this.host.model.workspace;
        const space = this.host.space();
        if (!workspace || !space) return;
        const windowId = this.host.windowId();
        const existing = space.tabs.find((tab) => tab.nativeContent?.kind === settingsKind);
        if (existing) {
            void this.send({ kind: "ShowTab", value: { windowId, spaceId: space.state.id, tabId: existing.id } });
            return;
        }
        void this.send({
            kind: "OpenTab",
            value: {
                workspaceId: workspace.id,
                windowId,
                spaceId: space.state.id,
                tabId: crypto.randomUUID(),
                content: { address: null, view: "Settings", title: null },
                placement: "Current",
                afterTabId: null,
                shows: true,
            },
        });
    }

    /** Opens the Space page of `spaceId`, as Edit Space… and New Space… do on the Mac. */
    openSpace(spaceId: Guid, intent: SpaceEditorIntent): void {
        // The Space's name takes the keys once its page draws.
        this.namesSpace = intent === "none" ? null : spaceId;
        this.open({ kind: "space", spaceId, section: "appearance" });
    }

    /** Opens the page the command bar names. */
    openPage(name: string): void {
        if (destinationNamed(name)) this.open({ kind: "page", name });
    }

    /** Shows Settings while the window shows a Settings tab, and draws what the core now holds. */
    follow(): void {
        const shown = this.host.tab()?.nativeContent?.kind === settingsKind;
        if (this.root.hidden === shown) {
            this.root.hidden = !shown;
            document.body.classList.toggle("shows-settings", shown);
        }
        if (!shown) {
            this.leaveSpacePage();
            return;
        }
        this.render();
    }

    private go(route: SettingsRoute): void {
        this.route = route;
        sessionStorage.setItem(routeKey, JSON.stringify(route));
        this.scroller.scrollTop = 0;
        if (this.isShown) this.draw();
    }

    private async send(intent: Intent): Promise<boolean> {
        try {
            await dispatch(intent);
            return true;
        } catch (error) {
            console.error(error);
            postNotice(Notices.failure(error instanceof Refused ? explanation(error) : String(error)));
            return false;
        }
    }

    // MARK: - Drawing

    /** Draws now, unless the person is typing in or pressing on a page, which draws once they stop. */
    private render(): void {
        if (this.root.hidden) return;
        const active = document.activeElement;
        const typing =
            active instanceof HTMLTextAreaElement ||
            (active instanceof HTMLInputElement && ["text", "search", "url"].includes(active.type) && active !== this.search);
        if (this.pressing || (typing && this.root.contains(active))) {
            this.deferred = true;
            return;
        }
        this.draw();
    }

    private flush(): void {
        if (!this.deferred || this.pressing) return;
        this.deferred = false;
        this.render();
    }

    private draw(): void {
        this.deferred = false;
        const workspace = this.host.model.workspace;
        if (!workspace) return;
        if (this.route.kind === "space" && !workspace.spaces.get(this.route.spaceId)) {
            this.route = { kind: "page", name: SettingsDestination.spaces.name };
        }
        this.drawNavigation();
        const focus = this.focusedLabel();
        const scroll = this.scroller.scrollTop;
        if (this.route.kind === "space") this.drawSpacePage(this.route);
        else this.drawPage(this.route.name);
        this.scroller.scrollTop = scroll;
        if (!this.root.contains(document.activeElement) || document.activeElement === document.body) this.restoreFocus(focus);
    }

    private drawPage(name: string): void {
        this.leaveSpacePage();
        const destination = destinationNamed(name) ?? SettingsDestination.general;
        // The Spaces page has no header of its own, as on the Mac.
        this.header.hidden = destination === SettingsDestination.spaces;
        this.header.replaceChildren(element("h2", "settings-title", destination.title));
        this.root.dataset.page = destination.name;
        const page = this.host.pages[destination.name];
        const parts = page ? page(this.context).filter((part): part is HTMLElement => part !== null) : [];
        this.content.replaceChildren(...parts);
    }

    private drawSpacePage(route: { readonly spaceId: Guid; readonly section: SpaceSection }): void {
        const space = this.host.model.workspace?.spaces.get(route.spaceId);
        if (!space) return;
        this.root.dataset.page = `space-${route.section}`;
        if (this.embedded?.spaceId !== route.spaceId || !this.host.spaceEditor.isOpen) {
            const { header, body } = this.host.spaceEditor.embed(route.spaceId, "none");
            this.embedded = { spaceId: route.spaceId, header, body };
        }
        this.header.hidden = false;
        if (this.header.firstChild !== this.embedded.header) this.header.replaceChildren(this.embedded.header);
        const tabs = element("div", "settings-segmented settings-space-sections");
        tabs.setAttribute("role", "tablist");
        for (const { section, title } of spaceSections) {
            const tab = element("button", section === route.section ? "selected" : "", title);
            tab.type = "button";
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(section === route.section));
            tab.addEventListener("click", () => this.go({ kind: "space", spaceId: route.spaceId, section }));
            tabs.append(tab);
        }
        const parts: HTMLElement[] = [tabs];
        if (route.section === "appearance") parts.push(this.embedded.body);
        else parts.push(...this.host.spaceSections[route.section](this.context, space).filter((part): part is HTMLElement => part !== null));
        this.content.replaceChildren(...parts);
        if (this.namesSpace === route.spaceId) {
            this.namesSpace = null;
            this.focusSpaceName();
        }
    }

    private leaveSpacePage(): void {
        if (!this.embedded) return;
        this.embedded = null;
        this.host.spaceEditor.close();
    }

    private focusSpaceName(): void {
        const name = this.root.querySelector<HTMLInputElement>(".space-editor-name");
        name?.focus();
        name?.select();
    }

    /** The label of the control that has the keys, to give them back after a redraw. */
    private focusedLabel(): string | null {
        const active = document.activeElement;
        return active instanceof HTMLElement && this.content.contains(active) ? active.getAttribute("aria-label") : null;
    }

    private restoreFocus(label: string | null): void {
        if (!label) return;
        const match = [...this.content.querySelectorAll<HTMLElement>("[aria-label]")].find((node) => node.getAttribute("aria-label") === label);
        match?.focus({ preventScroll: true });
    }

    // MARK: - Sidebar

    /** The build at the sidebar's top, as the Mac's BrowserSettingsBuildHeader. */
    private buildHeader(): HTMLElement {
        const header = element("div", "settings-build");
        const title = element("div", "settings-build-title", "Crest Browser");
        const version = element("div", "settings-build-version", "");
        const engine = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1];
        const engineLine = element("div", "settings-build-version", engine ? `Chromium ${engine}` : "");
        void aboutInformation().then((about) => {
            if (about) version.textContent = `Version ${about.version} (${about.build})`;
        });
        header.append(title, version, engineLine);
        return header;
    }

    private drawNavigation(): void {
        const query = this.search.value.trim();
        const offered = (destination: SettingsDestination): boolean =>
            destination.requiredCapability === null || this.host.preferences.offers(destination.requiredCapability);
        const shows = (destination: SettingsDestination): boolean => offered(destination) && (query.length === 0 || destinationMatches(destination, query));
        const rows: HTMLElement[] = [];
        const group = (destinations: readonly SettingsDestination[]): void => {
            const shown = destinations.filter(shows);
            if (shown.length === 0) return;
            const node = element("div", "settings-nav-group");
            node.append(...shown.map((destination) => this.destinationRow(destination)));
            rows.push(node);
        };
        group(primaryDestinations);
        const spaces = this.spacesSection(query);
        if (spaces) rows.push(spaces);
        group(secondaryDestinations);
        if (rows.length === 0) rows.push(element("p", "settings-nav-empty", "No Results"));
        this.list.replaceChildren(...rows);
    }

    private destinationRow(destination: SettingsDestination): HTMLElement {
        const selected = this.route.kind === "page" && this.route.name === destination.name;
        const row = element("button", selected ? "settings-nav-row selected" : "settings-nav-row");
        row.type = "button";
        row.dataset.page = destination.name;
        if (selected) row.setAttribute("aria-current", "page");
        const tile = element("span", "settings-nav-tile");
        tile.style.background = css(Tincture.facts[destination.tincture].color);
        tile.innerHTML = sfSymbol(destination.symbol, 12);
        row.append(tile, element("span", "settings-nav-title", destination.navigationTitle));
        row.addEventListener("click", () => this.go({ kind: "page", name: destination.name }));
        return row;
    }

    /** The Spaces, each opening its own page, with Sub-Spaces under their group (BrowserSettingsSpacesSection). */
    private spacesSection(query: string): HTMLElement | null {
        const workspace = this.host.model.workspace;
        if (!workspace) return null;
        const groups = new SpaceGroups(workspace);
        const matches = (space: Space): boolean =>
            query.length === 0 || destinationMatches(SettingsDestination.spaces, query) || space.state.settings.name.toLowerCase().includes(query.toLowerCase());
        const spaces = groups.available.filter(matches);
        if (spaces.length === 0) return null;
        const section = element("div", "settings-nav-group settings-nav-spaces");
        const header = element("div", "settings-nav-spaces-header");
        const title = element("button", "settings-nav-spaces-title", "Spaces");
        title.type = "button";
        title.addEventListener("click", () => this.go({ kind: "page", name: SettingsDestination.spaces.name }));
        if (this.route.kind === "page" && this.route.name === SettingsDestination.spaces.name) title.classList.add("selected");
        const add = element("button", "settings-glyph-button");
        add.type = "button";
        add.innerHTML = sfSymbol("plus", 13);
        add.title = "Add Space";
        add.setAttribute("aria-label", "Add Space");
        add.addEventListener("click", () => void this.host.spaces.create());
        header.append(title, add);
        section.append(header);
        for (const space of spaces) {
            const id = space.state.id;
            const selected = this.route.kind === "space" && this.route.spaceId === id;
            const row = element("div", selected ? "settings-nav-row settings-nav-space selected" : "settings-nav-row settings-nav-space");
            if (groups.isSubSpace(space)) row.classList.add("sub-space");
            const open = element("button", "settings-nav-space-open");
            open.type = "button";
            open.append(identityIcon(space.state.settings.look, space.state.settings.symbol, 18), element("span", "settings-nav-title", space.state.settings.name));
            open.addEventListener("click", () => this.go({ kind: "space", spaceId: id, section: "appearance" }));
            row.append(open);
            if (selected) {
                const menu = element("button", "settings-glyph-button");
                menu.type = "button";
                menu.innerHTML = sfSymbol("ellipsis", 13);
                menu.title = "Space actions";
                menu.setAttribute("aria-label", "Space actions");
                menu.addEventListener("click", () => void this.host.spaces.spaceEntries(space).then((entries) => Menu.open(entries, { anchor: menu.getBoundingClientRect() })));
                row.append(menu);
            }
            section.append(row);
        }
        return section;
    }
}

/** What the build carries, as the About page and the sidebar's header show it. */
export interface AboutInformation {
    readonly version: string;
    readonly build: string;
    readonly notes: readonly { readonly id: string; readonly category: "new" | "improved" | "fixed"; readonly message: string }[];
}

let about: Promise<AboutInformation | null> | null = null;

/** The build's version and release notes, which the build writes beside the page. */
export function aboutInformation(): Promise<AboutInformation | null> {
    // Beside index.html, written by build.mjs; named by a variable so the
    // compiler does not look for it.
    const module = "../about.js";
    about ??= (import(module) as Promise<{ default: AboutInformation }>)
        .then((loaded) => loaded.default)
        .catch(() => null);
    return about;
}
