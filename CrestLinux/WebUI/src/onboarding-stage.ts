// What every page of setup shares, as the Mac's BrowserOnboardingStage and
// its parts draw it: the stage, always dark, over the look's own sidebar
// field darkened (BrowserOnboardingBackdrop), the Crest mark and the
// progress rail over it, a page's serif headline, its footer with Back on
// the left, and a Space shown as the Crest window shows it
// (BrowserOnboardingWindowPreview). A look shows itself on the template the
// previews start from, as SetupLook+Preview gives it.

import type { BrandColor, SetupLook, SetupStep, SpaceBranding } from "../generated/crest_contracts.js";
import { SetupLook as SetupLooks, SetupStep as SetupSteps, SpaceHouse } from "../generated/crest_contracts.js";
import { bannerSVG, foregroundTone, identityIcon } from "./crest.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Elements

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** A button of setup's: `primary` carries a page forward, `secondary` and `tertiary` sit beside it. */
export function button(title: string, kind: "primary" | "secondary" | "tertiary", action: () => void, symbol?: string): HTMLButtonElement {
    const node = el("button", `onboarding-button ${kind}`);
    node.type = "button";
    if (symbol) node.insertAdjacentHTML("beforeend", sfSymbol(symbol, 14));
    node.append(el("span", "", title));
    node.addEventListener("click", action);
    return node;
}

// MARK: - Looks

/** The template every look's preview starts from. */
const previewHouse = SpaceHouse.facts.Winter.look;

/** How light `color` is, from 0 for black to 1 for white. */
function lightness(color: BrandColor): number {
    return (Math.max(color.red, color.green, color.blue) + Math.min(color.red, color.green, color.blue)) / 2;
}

function chroma(color: BrandColor): number {
    return Math.max(color.red, color.green, color.blue) - Math.min(color.red, color.green, color.blue);
}

/** The shade an icon wears over `color`: deeper where dark text reads better on it, paler where light text does. */
function contrasting(color: BrandColor, look: SpaceBranding): BrandColor {
    const alone: SpaceBranding = {
        ...look,
        colors: { colors: [color] },
        bannerStrength: 1,
        readabilityFade: 0,
        textColorMode: "Automatic",
    };
    const toward = foregroundTone(alone, false) === "dark" ? 0 : 1;
    const mix = (channel: number): number => channel + (toward - channel) * 0.55;
    return { red: mix(color.red), green: mix(color.green), blue: mix(color.blue), alpha: color.alpha };
}

/**
 * `branding` in `look`: the sidebar mode, gradient angle and icon style the
 * core gives the look, keeping its colors, crest and texture. A tinted look
 * keeps only the accent color, at the look's strength, which the icon wears
 * too (SetupLook.applying).
 */
export function wearingLook(look: SetupLook, branding: SpaceBranding): SpaceBranding {
    const facts = SetupLooks.facts[look];
    let worn: SpaceBranding = {
        ...branding,
        themeMode: facts.themeMode,
        gradientAngle: facts.gradientAngle ?? branding.gradientAngle,
        iconStyle: facts.iconStyle,
    };
    if (facts.tint !== null) {
        const colors = branding.colors.colors;
        const accent =
            colors
                .filter((color) => lightness(color) >= 0.3 && lightness(color) <= 0.75)
                .reduce<
                    BrandColor | undefined
                >((best, color) => (best === undefined || chroma(color) > chroma(best) ? color : best), undefined) ??
            colors[0] ??
            previewHouse.colors.colors[0]!;
        worn = {
            ...worn,
            colors: { colors: [accent] },
            bannerStrength: facts.tint,
            readabilityFade: 0,
            keepsControlsReadable: false,
            symbolColor: contrasting(accent, worn),
            textColorMode: "Automatic",
        };
    }
    return worn;
}

/** The look on the template every preview starts from. */
export function previewBranding(look: SetupLook): SpaceBranding {
    return wearingLook(look, previewHouse);
}

/** The symbol a previewed Space wears. */
export const previewSymbol = "house.fill";

// MARK: - Stage

/** How the welcome's backdrop paces its drift, and how a chosen look follows (CrestMotion). */
export const backdropFade = { drift: 1600, change: 350 };

/**
 * The stage's backdrop: a sidebar field in a look, darkened so the page reads
 * over it. A change of look cross-fades from the field shown before.
 */
export class StageBackdrop {
    readonly node = el("div", "onboarding-backdrop");
    private shown = "";

    show(branding: SpaceBranding, fade: number): void {
        const key = JSON.stringify(branding);
        if (key === this.shown) return;
        const first = this.shown === "";
        this.shown = key;
        const layer = el("div", "onboarding-backdrop-layer");
        layer.innerHTML = bannerSVG(branding, 1440, 900);
        layer.style.transitionDuration = `${fade}ms`;
        if (!first && !matchMedia("(prefers-reduced-motion: reduce)").matches) layer.style.opacity = "0";
        this.node.append(layer);
        // The new field fades in over the last, which goes once it is covered.
        requestAnimationFrame(() => (layer.style.opacity = "1"));
        const covered = this.node.querySelectorAll(".onboarding-backdrop-layer");
        setTimeout(() => {
            for (const old of covered) if (old !== layer && layer.isConnected) old.remove();
        }, fade + 50);
    }
}

/** The Crest mark the stage and the welcome wear. */
export function crestMark(size: number): HTMLElement {
    const mark = el("span", "onboarding-mark");
    mark.innerHTML = `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><path d="M32 4l24 9v17c0 15-10 26-24 30C18 56 8 45 8 30V13z" fill="var(--crest-coral)"/><path d="M32 16l4 9 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" fill="white" opacity="0.9"/></svg>`;
    return mark;
}

/** Where setup stands: one segment per position, the current one long and lit (BrowserOnboardingProgressRail). */
export function progressRail(step: SetupStep): HTMLElement {
    const position = SetupSteps.facts[step].progressPosition;
    const count = SetupSteps.constants.progressCount;
    const rail = el("div", "onboarding-rail");
    rail.setAttribute("role", "progressbar");
    rail.setAttribute("aria-label", "Setup progress");
    rail.setAttribute("aria-valuetext", `Step ${position + 1} of ${count}`);
    for (let item = 0; item < count; item++) {
        rail.append(el("span", item === position ? "current" : item < position ? "behind" : "ahead"));
    }
    return rail;
}

/** The Crest mark and the progress rail over the stage. */
export function stageHeader(step: SetupStep): HTMLElement {
    const header = el("header", "onboarding-header");
    const identity = el("div", "onboarding-identity");
    identity.append(crestMark(22), el("span", "onboarding-name", "Crest"));
    header.append(identity, progressRail(step));
    return header;
}

// MARK: - Page parts

/** What a page's Back button does: go back a step, or close setup where the entry did not pass through one. */
export interface BackAction {
    readonly closes: boolean;
    readonly action: () => void;
}

/** A page's one serif line. */
export function headline(text: string): HTMLElement {
    const line = el("h1", "onboarding-headline", text);
    return line;
}

/** The primary button that carries a page forward, with its arrow, and takes Enter. */
export function continueButton(title: string, action: () => void, disabled = false): HTMLButtonElement {
    const node = el("button", "onboarding-button primary continue");
    node.type = "button";
    node.append(el("span", "", title));
    node.insertAdjacentHTML("beforeend", sfSymbol("arrow.right", 14));
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
}

/** The bottom of a page: Back, or Close where Back leaves setup, on the left, and what the page offers on the right. */
export function footer(back: BackAction | null, trailing: readonly HTMLElement[], backDisabled = false): HTMLElement {
    const bar = el("footer", "onboarding-footer");
    if (back) {
        const node = button(back.closes ? "Close" : "Back", "secondary", back.action);
        node.disabled = backDisabled;
        bar.append(node);
    }
    bar.append(el("span", "onboarding-spacer"));
    const right = el("div", "onboarding-footer-trailing");
    right.append(...trailing);
    bar.append(right);
    return bar;
}

/** Why setup could not go on, beside its warning glyph. */
export function failureLabel(text: string): HTMLElement {
    const label = el("span", "onboarding-failure");
    label.innerHTML = sfSymbol("exclamationmark.triangle.fill", 12);
    label.append(el("span", "", text));
    label.setAttribute("role", "alert");
    return label;
}

/** What `kind` of empty state a page shows: a glyph, a title and a line under it. */
export function unavailable(symbol: string, title: string, description: string, actions: readonly HTMLElement[] = []): HTMLElement {
    const view = el("div", "onboarding-unavailable");
    const glyph = el("span", "onboarding-unavailable-glyph");
    glyph.innerHTML = sfSymbol(symbol, 32);
    view.append(glyph, el("h2", "", title));
    if (description) view.append(el("p", "", description));
    if (actions.length > 0) {
        const row = el("div", "onboarding-unavailable-actions");
        row.append(...actions);
        view.append(row);
    }
    return view;
}

/**
 * Floats `content` under `anchor` on the flyout surface, as crestPopover
 * does, until the person clicks outside it or presses Escape.
 */
export function popover(anchor: HTMLElement, content: HTMLElement): () => void {
    const layer = el("div", "onboarding-popover-layer");
    const surface = el("div", "onboarding-popover");
    surface.append(content);
    layer.append(surface);
    document.body.append(layer);
    const box = anchor.getBoundingClientRect();
    const width = surface.offsetWidth;
    const height = surface.offsetHeight;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = box.bottom + 8;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 8) : below;
    surface.style.left = `${left}px`;
    surface.style.top = `${top}px`;
    const close = (): void => {
        layer.remove();
        window.removeEventListener("keydown", onKey, true);
    };
    const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };
    layer.addEventListener("mousedown", (event) => {
        if (event.target === layer) close();
    });
    window.addEventListener("keydown", onKey, true);
    return close;
}

// MARK: - Window preview

/** How the preview's switcher shows Spaces (BrowserSpaceIconDisplay). */
export type SpaceIconDisplay = "icons" | "dots";

export interface WindowPreviewOptions {
    readonly branding: SpaceBranding;
    readonly symbol: string;
    readonly name: string;
    /** What the page card beside the sidebar shows. */
    readonly page?: HTMLElement | null;
    /** The field the name is edited in, where the preview is given one. */
    readonly nameField?: HTMLInputElement;
    readonly showsNameHint?: boolean;
    /** How the switcher shows the Spaces, or undefined to show this Space alone. */
    readonly spaceIcons?: SpaceIconDisplay;
    /** The look the other Spaces in the switcher wear, or undefined for their own. */
    readonly companionLook?: SetupLook;
}

/**
 * A Space as the Crest window shows it: its field across the whole window,
 * its sidebar on the left with the Space's name, and the page card inset
 * beside it. Given how the switcher shows Spaces, its bottom bar shows the
 * Space among three others in that look.
 */
export function windowPreview(options: WindowPreviewOptions): HTMLElement {
    const { branding, symbol } = options;
    const name = options.name || "Your Space";
    const window = el("div", "onboarding-window");
    window.classList.add(foregroundTone(branding, true) === "light" ? "reads-light" : "reads-dark");
    window.setAttribute("aria-label", `Preview of ${name} in a Crest window`);
    const field = el("div", "onboarding-window-field");
    field.innerHTML = bannerSVG(branding, 620, 420);
    const sidebar = el("div", "onboarding-window-sidebar");

    const titlebar = el("div", "onboarding-window-titlebar");
    titlebar.innerHTML =
        '<span class="light"></span><span class="light"></span><span class="light"></span><span class="onboarding-spacer"></span>' +
        sfSymbol("chevron.left", 12) +
        `<span class="dim">${sfSymbol("chevron.right", 12)}</span>` +
        sfSymbol("arrow.clockwise", 12);
    const address = el("div", "onboarding-window-address");
    address.innerHTML = sfSymbol("magnifyingglass", 12);
    address.append(el("span", "", "Search or enter website"));
    const pins = el("div", "onboarding-window-pins");
    for (let index = 0; index < 4; index++) pins.append(el("span", "onboarding-window-pin"));

    const spaceRow = el("div", "onboarding-window-space");
    spaceRow.append(identityIcon(branding, symbol, 22));
    if (options.nameField) spaceRow.append(options.nameField);
    else spaceRow.append(el("span", "onboarding-window-space-name", name));
    spaceRow.insertAdjacentHTML("beforeend", `<span class="dim">${sfSymbol("ellipsis", 14)}</span>`);
    sidebar.append(titlebar, address, pins, spaceRow);
    if (options.showsNameHint) sidebar.append(el("span", "onboarding-window-hint", "Click the name to rename"));
    const section = el("div", "onboarding-window-section");
    section.append(el("span", "onboarding-window-section-title", "OPEN TABS"));
    for (let index = 0; index < 3; index++) {
        const row = el("span", index === 0 ? "onboarding-window-tab selected" : "onboarding-window-tab");
        row.append(el("span", "onboarding-window-tab-icon"), el("span", "onboarding-window-tab-title"));
        section.append(row);
    }
    sidebar.append(section, el("span", "onboarding-spacer"));

    const bottom = el("div", "onboarding-window-bottom");
    bottom.innerHTML = sfSymbol("arrow.down.circle", 14);
    bottom.append(el("span", "onboarding-spacer"));
    if (options.spaceIcons) bottom.append(switcher(branding, symbol, options.spaceIcons, options.companionLook));
    else {
        const shown = el("span", "onboarding-window-shown");
        shown.append(identityIcon(branding, symbol, 22));
        bottom.append(shown);
    }
    bottom.append(el("span", "onboarding-spacer"));
    bottom.insertAdjacentHTML("beforeend", sfSymbol("archivebox", 14));
    sidebar.append(bottom);

    const card = el("div", "onboarding-window-card");
    if (options.page) card.append(options.page);
    window.append(field, sidebar, card);
    return window;
}

/** The switcher with the Space shown, two Spaces in its group beside it and one on its own. */
function switcher(branding: SpaceBranding, symbol: string, icons: SpaceIconDisplay, companionLook: SetupLook | undefined): HTMLElement {
    const track = el("span", icons === "dots" ? "onboarding-window-switcher dots" : "onboarding-window-switcher");
    const companions: [SpaceBranding, string][] = SpaceHouse.all.slice(1, 4).map((house, index) => {
        const look = SpaceHouse.facts[house].look;
        return [companionLook ? wearingLook(companionLook, look) : look, ["briefcase.fill", "book.fill", "leaf.fill"][index]!];
    });
    const shades = ["shown", "grouped", "grouped", "other"];
    [[branding, symbol] as [SpaceBranding, string], ...companions].forEach(([look, glyph], index) => {
        const slot = el("span", `onboarding-window-switcher-slot ${index === 0 ? "current" : ""}`);
        if (icons === "dots") slot.append(el("span", `onboarding-dot ${shades[index]}`));
        else slot.append(identityIcon(look, glyph, 20));
        track.append(slot);
    });
    return track;
}
