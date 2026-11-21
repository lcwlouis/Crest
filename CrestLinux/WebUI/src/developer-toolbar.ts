// The developer toolbar, as the Mac's BrowserDeveloperToolbar: a striped bar
// across the top of a page's card with the viewport preview, the page's
// address to edit and load, Copy Link, the capture tools and the inspector's
// panels. It shows on a page the person turned it on for (Toggle Developer
// Toolbar), on one previewing a viewport, and by itself on a local
// development address while the person keeps "Developer toolbar on local
// pages" on. What it shows is the window's own, kept per page for as long as
// the window shows it, as the Mac keeps it on the live page.
//
// A viewport preview lays the page out at a preset's CSS size: the page's view
// takes the preset's proportions, scaled down to fit the card, and the page
// is zoomed by the same scale, so its layout keeps the preset's width
// (BrowserDeveloperViewportLayout). Zoom commands wait while it shows.
//
// TODO(linux): the Mac's Site Settings button opens the site's settings in a
// popover (BrowserDeveloperSiteSettingsControl); it joins the bar once Linux
// draws the site control popover.

import { pageRequest, query } from "./bridge.js";
import type { AppPreferences, Guid, InspectorPanel, Intent, PageState } from "../generated/crest_contracts.js";
import { Menu } from "./menu.js";
import type { MenuEntry } from "./menu.js";
import type { Model, Space, Workspace } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import { holdOverlay } from "./overlay.js";
import type { PageDecorations, PageFrame } from "./page-cards.js";
import type { PageOutput } from "./page-output.js";
import { RegionCapture } from "./region-capture.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

/** A CSS viewport the preview lays a page out at, as the Mac's BrowserDeveloperViewport. */
export interface DeveloperViewport {
    readonly name: string;
    readonly title: string;
    readonly symbol: string;
    readonly width: number;
    readonly height: number;
    /** Whether the person typed the size in rather than choosing a preset. */
    readonly isCustom: boolean;
}

/** What one page's toolbar holds in this window. */
interface PageDeveloperState {
    /** Shown or hidden by the person, over what the page's address would say. */
    visibilityOverride: boolean | null;
    viewport: DeveloperViewport | null;
    /** The inspector panel the toolbar opened, which its button shows as on. */
    panel: InspectorPanel | null;
}

/** One page card's bar. */
interface Bar {
    readonly root: HTMLElement;
    readonly address: HTMLInputElement;
    readonly viewport: HTMLButtonElement;
    readonly actions: HTMLElement;
    readonly overflow: HTMLButtonElement;
    readonly panels: Map<InspectorPanel, HTMLButtonElement>;
    readonly capture: HTMLButtonElement;
    readonly captureWindow: HTMLButtonElement;
    pageId: Guid;
    /** The address last shown, so typing is never replaced by the same address. */
    shownAddress: string;
}

/** What the toolbar reads of the window. */
export interface DeveloperToolbarContext {
    readonly model: Model;
    readonly workspace: () => Workspace | undefined;
    readonly space: () => Space | undefined;
    readonly app: () => AppPreferences;
    /** Whether the device's engines offer `capability`. */
    readonly offers: (capability: "ViewportCapture" | "FullPageCapture" | "Inspector") => boolean;
    readonly output: PageOutput;
    /** Lays the window's cards out again. */
    readonly relayout: () => void;
    /** Where the page `pageId` sits in the window now. */
    readonly frameOf: (pageId: Guid) => PageFrame | undefined;
    /** The zoom the person set on the page, which the page returns to after a preview. */
    readonly zoomOf: (pageId: Guid) => number;
    readonly send: (intent: Intent) => void;
    readonly report: (error: unknown) => void;
}

// MARK: - Viewports

const viewport = (name: string, title: string, symbol: string, width: number, height: number): DeveloperViewport => ({
    name,
    title,
    symbol,
    width,
    height,
    isCustom: false,
});

/** BrowserDeveloperViewport.presets: CSS viewport sizes, not hardware or user-agent emulation, smallest first. */
export const viewportPresets: readonly DeveloperViewport[] = [
    viewport("compactPhone", "Compact Phone", "iphone", 375, 667),
    viewport("phone", "Phone", "iphone", 390, 844),
    viewport("largePhone", "Large Phone", "iphone", 430, 932),
    viewport("desktop", "Desktop", "laptopcomputer", 1280, 800),
    viewport("wideDesktop", "Wide Desktop", "display", 1920, 1080),
    viewport("ultrawide", "Ultrawide", "display", 2560, 1080),
];

/** A size the person typed, in CSS pixels from 1 to 8192, or null when it is not one. */
export function customViewport(width: string, height: string): DeveloperViewport | null {
    const parse = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
    const w = parse(width);
    const h = parse(height);
    if (w === null || h === null || w < 1 || w > 8192 || h < 1 || h > 8192) return null;
    return { name: "custom", title: "Custom", symbol: "ruler", width: w, height: h, isCustom: true };
}

function sameViewport(a: DeveloperViewport | null, b: DeveloperViewport | null): boolean {
    return a?.name === b?.name && a?.width === b?.width && a?.height === b?.height;
}

// MARK: - Local development

const localHostnameSuffixes = ["localhost", "local", "test", "internal", "lan", "home.arpa"];

function isLocalIPv4(parts: readonly number[]): boolean {
    const [a = -1, b = -1, c = -1, d = -1] = parts;
    if (a === 0 && b === 0 && c === 0 && d === 0) return true;
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Whether `address` is the person's own development work, as the Mac's
 * URL.isLocalDevelopmentAddress: a local file, a single-label host, a private
 * or loopback address, or a host under a local-only suffix.
 */
export function isLocalDevelopmentAddress(address: string | null): boolean {
    if (!address) return false;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return false;
    }
    if (url.protocol === "file:") return true;
    const host = url.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!host) return false;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) return isLocalIPv4(v4.slice(1).map(Number));
    if (host.startsWith("[")) {
        const v6 = host.slice(1, -1).split("%")[0]!;
        if (v6 === "::" || v6 === "::1") return true;
        if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
        const mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v6);
        return mapped ? isLocalIPv4(mapped.slice(1).map(Number)) : false;
    }
    if (!host.includes(".")) return true;
    return localHostnameSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// MARK: - Toolbar

/** BrowserPageToolbarSurface: 28-point controls inside 7 points above and below, and its divider. */
const barHeight = 43;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, symbol: string, act: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const node = element("button", "developer-button");
    node.innerHTML = sfSymbol(symbol, 15);
    node.title = label;
    node.setAttribute("aria-label", label);
    node.addEventListener("click", () => act(node));
    return node;
}

function divider(): HTMLElement {
    const node = element("span", "developer-divider");
    node.setAttribute("aria-hidden", "true");
    return node;
}

export class DeveloperToolbar implements PageDecorations {
    private readonly context: DeveloperToolbarContext;
    private readonly pages = new Map<Guid, PageDeveloperState>();
    /** The bars drawn now, by tab. */
    private readonly bars = new Map<Guid, Bar>();
    /** The tabs handed over in the layout under way. */
    private readonly framed = new Set<Guid>();
    /** The zoom each previewing page had before its preview, by page. */
    private readonly previewZoom = new Map<Guid, number>();
    readonly regionCapture: RegionCapture;
    private popover: { readonly node: HTMLElement; close(): void } | null = null;

    constructor(context: DeveloperToolbarContext) {
        this.context = context;
        this.regionCapture = new RegionCapture((pageId, area) => void context.output.copyRegion(pageId, area));
    }

    // MARK: - Actions - State

    private state(pageId: Guid): PageDeveloperState {
        let state = this.pages.get(pageId);
        if (!state) {
            state = { visibilityOverride: null, viewport: null, panel: null };
            this.pages.set(pageId, state);
        }
        return state;
    }

    /** Whether `page`'s address turns the toolbar on by itself. */
    private isAutomatic(page: PageState): boolean {
        return this.context.app().automaticallyShowsDeveloperToolbar && isLocalDevelopmentAddress(page.live.address ?? page.live.url);
    }

    /** Whether the toolbar shows on `page`, as the Mac's isDeveloperModeEnabled. */
    isEnabled(page: PageState): boolean {
        const state = this.pages.get(page.id);
        return state?.visibilityOverride ?? (state?.viewport != null || this.isAutomatic(page));
    }

    /** Whether `pageId` previews a viewport, which zoom leaves alone. */
    previews(pageId: Guid): boolean {
        return this.pages.get(pageId)?.viewport != null;
    }

    /** Toggle Developer Toolbar: shows the toolbar on `page`, or puts it away and ends its preview. */
    toggle(page: PageState): void {
        const visible = !this.isEnabled(page);
        this.state(page.id).visibilityOverride = visible;
        if (!visible) this.setViewport(page.id, null);
        this.context.relayout();
    }

    /** Capture Page: begins a selection over `page`, or ends the one showing. */
    toggleRegionCapture(page: PageState): void {
        if (this.regionCapture.pageId === page.id) {
            this.regionCapture.cancel();
        } else {
            const frame = this.context.frameOf(page.id);
            if (frame) this.regionCapture.begin(page.id, frame, () => this.context.relayout());
        }
        this.context.relayout();
    }

    private setViewport(pageId: Guid, viewport: DeveloperViewport | null): void {
        const state = this.state(pageId);
        if (sameViewport(state.viewport, viewport)) return;
        state.viewport = viewport;
        if (!viewport) {
            this.previewZoom.delete(pageId);
            void pageRequest("ZoomPage", { pageId, factor: this.context.zoomOf(pageId) }).catch(this.context.report);
        }
        this.context.relayout();
    }

    // MARK: - Actions - Layout (PageDecorations)

    frame(tabId: Guid, page: PageState, card: HTMLElement, frame: PageFrame): PageFrame {
        if (!this.isEnabled(page)) return frame;
        this.framed.add(tabId);
        const bar = this.bar(tabId, page, card);
        this.update(bar, page);
        const below: PageFrame = { x: frame.x, y: frame.y + barHeight, width: frame.width, height: Math.max(0, frame.height - barHeight) };
        const viewport = this.pages.get(page.id)?.viewport ?? null;
        card.classList.toggle("developer-previewing", viewport !== null);
        if (!viewport) return below;
        // BrowserDeveloperViewportLayout: the preset's size, scaled down to fit.
        const scale = Math.max(0.25, Math.min(1, below.width / viewport.width, below.height / viewport.height));
        const width = viewport.width * scale;
        const height = viewport.height * scale;
        if (this.previewZoom.get(page.id) !== scale) {
            this.previewZoom.set(page.id, scale);
            void pageRequest("ZoomPage", { pageId: page.id, factor: scale }).catch(this.context.report);
        }
        return { x: below.x + (below.width - width) / 2, y: below.y + (below.height - height) / 2, width, height };
    }

    placed(): void {
        for (const [tabId, bar] of this.bars) {
            if (this.framed.has(tabId)) continue;
            bar.root.parentElement?.classList.remove("developer-previewing");
            bar.root.remove();
            this.bars.delete(tabId);
        }
        this.framed.clear();
        // A page that left the window forgets its toolbar, as the Mac's live page does.
        for (const pageId of this.pages.keys()) {
            if (!this.context.model.pages.has(pageId)) {
                this.pages.delete(pageId);
                this.previewZoom.delete(pageId);
            }
        }
    }

    // MARK: - Actions - Drawing

    private bar(tabId: Guid, page: PageState, card: HTMLElement): Bar {
        const existing = this.bars.get(tabId);
        if (existing && existing.root.parentElement === card) {
            existing.pageId = page.id;
            return existing;
        }
        existing?.root.remove();
        const root = element("div", "developer-toolbar");
        root.setAttribute("role", "toolbar");
        root.setAttribute("aria-label", "Developer Toolbar");
        const viewportButton = button("Viewport Preview", "macbook.and.iphone", (node) => this.openViewportMenu(bar, node));
        viewportButton.setAttribute("aria-haspopup", "menu");
        const address = element("input", "developer-address");
        address.type = "text";
        address.placeholder = "Full URL";
        address.spellcheck = false;
        address.setAttribute("aria-label", "Developer URL");
        address.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.navigate(bar);
            } else if (event.key === "Escape") {
                address.value = bar.shownAddress;
                address.blur();
            }
        });
        const copyLink = button("Copy Link", "link", () => this.copyLink(bar.pageId));
        const captureWindow = button("Capture Window", "rectangle.inset.filled", (node) => this.openCaptureOptions(bar, node));
        const capture = button("Capture", "camera", () => this.withPage(bar, (shown) => this.toggleRegionCapture(shown)));
        const panels = new Map<InspectorPanel, HTMLButtonElement>([
            ["Console", button("Toggle Console", "apple.terminal", () => this.togglePanel(bar.pageId, "Console"))],
            ["Network", button("Toggle Network Panel", "network", () => this.togglePanel(bar.pageId, "Network"))],
            ["Elements", button("Inspect Element", "scope", () => this.togglePanel(bar.pageId, "Elements"))],
        ]);
        const actions = element("div", "developer-actions");
        actions.append(copyLink, divider(), captureWindow, capture, divider(), ...panels.values());
        const overflow = button("Developer Tools", "ellipsis", (node) => this.openOverflow(bar, node));
        overflow.setAttribute("aria-haspopup", "menu");
        overflow.hidden = true;
        root.append(viewportButton, divider(), address, actions, overflow);
        card.append(root);
        const bar: Bar = { root, address, viewport: viewportButton, actions, overflow, panels, capture, captureWindow, pageId: page.id, shownAddress: "" };
        // The actions fold into "…" once the bar is too narrow for them, as the Mac's ViewThatFits.
        new ResizeObserver(() => this.fit(bar)).observe(root);
        this.bars.set(tabId, bar);
        return bar;
    }

    private update(bar: Bar, page: PageState): void {
        const state = this.state(page.id);
        const address = page.live.address ?? page.live.url ?? "";
        if (address !== bar.shownAddress) {
            if (document.activeElement !== bar.address || bar.address.value === bar.shownAddress) bar.address.value = address;
            bar.shownAddress = address;
        }
        bar.viewport.classList.toggle("tinted", state.viewport !== null);
        bar.viewport.setAttribute("aria-description", state.viewport ? state.viewport.title : "Off");
        for (const [panel, node] of bar.panels) {
            node.classList.toggle("active", state.panel === panel);
            node.disabled = !this.context.offers("Inspector");
        }
        bar.capture.classList.toggle("active", this.regionCapture.pageId === page.id);
        bar.capture.disabled = !this.context.offers("ViewportCapture");
        bar.captureWindow.disabled = !this.context.offers("FullPageCapture");
    }

    private fit(bar: Bar): void {
        bar.actions.hidden = false;
        bar.overflow.hidden = true;
        if (bar.root.scrollWidth > bar.root.clientWidth + 1) {
            bar.actions.hidden = true;
            bar.overflow.hidden = false;
        }
    }

    private withPage(bar: Bar, act: (page: PageState) => void): void {
        const page = this.context.model.pages.get(bar.pageId);
        if (page) act(page);
    }

    // MARK: - Actions - Controls

    /** Loads what the person typed, which the core resolves by the Space's address rules. */
    private navigate(bar: Bar): void {
        const page = this.context.model.pages.get(bar.pageId);
        const workspace = this.context.workspace();
        const input = bar.address.value.trim();
        if (!page?.tabId || !workspace || !input) return;
        this.context.send({ kind: "NavigateTab", value: { workspaceId: workspace.id, spaceId: page.spaceId, tabId: page.tabId, input } });
        bar.address.blur();
    }

    /** Copies the page's address through Super Copy, as the Mac's copyDeveloperPageLink. */
    private copyLink(pageId: Guid): void {
        const url = this.context.model.pages.get(pageId)?.live.url;
        if (!url) return;
        void query("LinkToCopy", { url })
            .then((clean) => navigator.clipboard.writeText(clean))
            .then(() => postNotice(Notices.urlCopied))
            .catch(this.context.report);
    }

    /** Closes the inspector showing `panel`, or opens one on it, as the Mac's toggleDeveloperPanel. */
    private togglePanel(pageId: Guid, panel: InspectorPanel): void {
        const state = this.state(pageId);
        void (async () => {
            if (state.panel === panel && (await pageRequest("PageInspected", { pageId }))) {
                if (await pageRequest("CloseInspector", { pageId })) state.panel = null;
            } else if (await pageRequest("OpenInspector", { pageId, panel })) {
                state.panel = panel;
            }
            this.context.relayout();
        })().catch(this.context.report);
    }

    /** The inspector closed by itself, so no panel button stays on. */
    inspectorClosed(pageId: Guid): void {
        const state = this.pages.get(pageId);
        if (state?.panel) {
            state.panel = null;
            this.context.relayout();
        }
    }

    private openViewportMenu(bar: Bar, anchor: HTMLElement): void {
        const state = this.state(bar.pageId);
        const choose = (viewport: DeveloperViewport | null) => (): void => this.setViewport(bar.pageId, viewport);
        const entries: MenuEntry[] = [
            { title: "Normal — Preview Off", icon: { kind: "symbol", name: "rectangle" }, checked: state.viewport === null, action: choose(null) },
            ...viewportPresets.map((preset) => ({
                title: `${preset.title} — ${preset.width} × ${preset.height}`,
                icon: { kind: "symbol", name: preset.symbol } as const,
                checked: !state.viewport?.isCustom && state.viewport?.name === preset.name,
                action: choose(preset),
            })),
            {
                title: "Custom",
                icon: { kind: "symbol", name: "ruler" },
                checked: state.viewport?.isCustom === true,
                action: () => this.openCustomViewport(bar, anchor),
            },
        ];
        Menu.open(entries, { anchor: anchor.getBoundingClientRect() });
    }

    /** The width and height fields of a custom viewport, as the Mac's BrowserDeveloperCustomViewportFields. */
    private openCustomViewport(bar: Bar, anchor: HTMLElement): void {
        const page = this.context.model.pages.get(bar.pageId);
        const current = this.pages.get(bar.pageId)?.viewport;
        const frame = this.context.frameOf(bar.pageId);
        const fields = element("form", "developer-viewport-fields");
        fields.title = "Width and height in CSS pixels, from 1 to 8192. Apply to resize the preview.";
        const width = element("input", "developer-field");
        const height = element("input", "developer-field");
        width.placeholder = "Width";
        height.placeholder = "Height";
        width.setAttribute("aria-label", "Viewport Width");
        height.setAttribute("aria-label", "Viewport Height");
        width.inputMode = height.inputMode = "numeric";
        width.value = String(Math.round(current?.width ?? frame?.width ?? 0));
        height.value = String(Math.round(current?.height ?? frame?.height ?? 0));
        const times = element("span", "developer-times", "×");
        times.setAttribute("aria-hidden", "true");
        const apply = button("Apply Custom Viewport", "checkmark", () => fields.requestSubmit());
        apply.type = "submit";
        const validate = (): void => {
            apply.disabled = customViewport(width.value, height.value) === null;
        };
        width.addEventListener("input", validate);
        height.addEventListener("input", validate);
        validate();
        fields.append(width, times, height, apply);
        fields.addEventListener("submit", (event) => {
            event.preventDefault();
            const viewport = customViewport(width.value, height.value);
            if (viewport && page) this.setViewport(page.id, viewport);
            this.closePopover();
        });
        this.openPopover(fields, anchor);
        width.focus();
        width.select();
    }

    /** The Capture Window popover, as the Mac's BrowserDeveloperCaptureOptions. */
    private openCaptureOptions(bar: Bar, anchor: HTMLElement): void {
        const options = element("div", "developer-capture-options");
        options.setAttribute("aria-label", "Capture Window");
        const preview = element("div", "developer-capture-preview");
        preview.setAttribute("aria-hidden", "true");
        preview.append(element("div", "developer-capture-preview-page"));
        const portrait = element("button", "developer-capture-option prominent");
        portrait.innerHTML = `${sfSymbol("rectangle.portrait.on.rectangle.portrait", 15)}<span>Capture in Portrait Mode</span>`;
        portrait.addEventListener("click", () => {
            this.closePopover();
            this.withPage(bar, (page) => void this.context.output.savePortraitCapture(page));
        });
        const full = element("button", "developer-capture-option");
        full.innerHTML = `${sfSymbol("doc.on.clipboard", 15)}<span>Copy Full Page Capture</span>`;
        full.addEventListener("click", () => {
            this.closePopover();
            this.withPage(bar, (page) => void this.context.output.copyFullPageCapture(page));
        });
        options.append(preview, portrait, full);
        this.openPopover(options, anchor);
    }

    /** The menu the bar's actions fold into once it is too narrow for them. */
    private openOverflow(bar: Bar, anchor: HTMLElement): void {
        const page = this.context.model.pages.get(bar.pageId);
        if (!page) return;
        const fullPage = !this.context.offers("FullPageCapture");
        const inspector = !this.context.offers("Inspector");
        Menu.open(
            [
                { title: "Copy Link", icon: { kind: "symbol", name: "link" }, action: () => this.copyLink(page.id) },
                {
                    title: "Capture Window",
                    icon: { kind: "symbol", name: "rectangle.inset.filled" },
                    disabled: fullPage,
                    submenu: [
                        {
                            title: "Capture in Portrait Mode",
                            icon: { kind: "symbol", name: "rectangle.portrait.on.rectangle.portrait" },
                            action: () => void this.context.output.savePortraitCapture(page),
                        },
                        {
                            title: "Copy Full Page Capture",
                            icon: { kind: "symbol", name: "doc.on.clipboard" },
                            action: () => void this.context.output.copyFullPageCapture(page),
                        },
                    ],
                },
                {
                    title: "Capture",
                    icon: { kind: "symbol", name: "camera" },
                    disabled: !this.context.offers("ViewportCapture"),
                    action: () => this.toggleRegionCapture(page),
                },
                "separator",
                { title: "Toggle Console", icon: { kind: "symbol", name: "apple.terminal" }, disabled: inspector, action: () => this.togglePanel(page.id, "Console") },
                { title: "Toggle Network Panel", icon: { kind: "symbol", name: "network" }, disabled: inspector, action: () => this.togglePanel(page.id, "Network") },
                { title: "Inspect Element", icon: { kind: "symbol", name: "scope" }, disabled: inspector, action: () => this.togglePanel(page.id, "Elements") },
            ],
            { anchor: anchor.getBoundingClientRect() },
        );
    }

    // MARK: - Actions - Popover

    /**
     * Shows `content` on Crest's flyout surface under `anchor`, as the Mac's
     * crestPopover, over the page, until a click outside it or Escape.
     */
    private openPopover(content: HTMLElement, anchor: HTMLElement): void {
        this.closePopover();
        const node = element("div", "developer-popover");
        node.append(content);
        document.body.append(node);
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - node.offsetWidth / 2), window.innerWidth - node.offsetWidth - margin);
        node.style.left = `${left}px`;
        node.style.top = `${rect.bottom + 6}px`;
        const release = holdOverlay();
        const outside = (event: MouseEvent): void => {
            if (!node.contains(event.target as Node)) this.closePopover();
        };
        const escape = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            this.closePopover();
        };
        document.addEventListener("mousedown", outside, true);
        document.addEventListener("keydown", escape, true);
        window.addEventListener("blur", () => this.closePopover(), { once: true });
        this.popover = {
            node,
            close: () => {
                document.removeEventListener("mousedown", outside, true);
                document.removeEventListener("keydown", escape, true);
                node.remove();
                release();
            },
        };
    }

    private closePopover(): void {
        const popover = this.popover;
        this.popover = null;
        popover?.close();
    }
}
