// A Space's editor, the Mac's Space page in Settings (BrowserSettingsSpacePage)
// as one sheet over the window until Linux has Settings: the Space's icon and
// its name, which edits in place (BrowserInlineSpaceName), its actions menu
// (BrowserSettingsSpaceMenu, with Reset Appearance and Artwork Credits), and
// the Appearance page's Crest Studio as the Mac shows it where Settings has no
// live sidebar beside it (BrowserSpaceBrandingEditor): a preview, the starting
// points (the houses and schemes), the Space's identity (crest or icon,
// symbol or emoji, icon colour) and its background (colours, pattern or
// gradient, strengths and text colour).
//
// Every change is the core's: names and symbols go as SetSpaceIdentity, looks
// as SetSpaceBranding, which applies the core's branding rules before it
// keeps them, and the sheet draws what the core then publishes. A slider or
// colour well previews while it moves and sends once it settles.
//
// Left out until Linux draws them: the crest's own layers (shape, field,
// band, emblem, border and finish, the Forge's steps), Shuffle, the full SF
// Symbols catalogue (the eight BrowserSpaceSimpleSymbol glyphs stand in), the
// gradient dial (a slider sets the angle), each row's reset control, and the
// other pages (Browsing, Privacy, Passwords, Extensions).

import type { BrandColor, Guid, SpaceBranding, SpaceSettings, SpaceTextColorMode } from "../generated/crest_contracts.js";
import { SpaceBannerPattern, SpaceHouse, SpaceScheme, SpaceTextColorMode as TextColorModes, Tincture } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { dispatch } from "./bridge.js";
import { bannerSVG, crestSVG, emojiOf, foregroundTone, identityIcon, primaryColor, symbolColor, symbolForEmoji } from "./crest.js";
import { Menu } from "./menu.js";
import type { Model, Space } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import { holdOverlay } from "./overlay.js";
import { explanation } from "./space-actions.js";
import type { SpaceActions, SpaceEditorIntent } from "./space-actions.js";
import { SpaceGroups } from "./space-groups.js";
import { sfSymbol, sfSymbolPaths as sfSymbolPathsOf } from "./symbols.js";

// MARK: - Types

export interface SpaceEditorHost {
    readonly model: Model;
    readonly actions: SpaceActions;
}

/** A plain glyph a Space's icon can wear (BrowserSpaceSimpleSymbol). */
const simpleSymbols: readonly { readonly symbol: string; readonly title: string }[] = [
    { symbol: "briefcase.fill", title: "Work" },
    { symbol: "person.fill", title: "Personal" },
    { symbol: "house.fill", title: "Home" },
    { symbol: "graduationcap.fill", title: "Study" },
    { symbol: "paintbrush.fill", title: "Creative" },
    { symbol: "gamecontroller.fill", title: "Games" },
    { symbol: "airplane", title: "Travel" },
    { symbol: "square.grid.2x2", title: "Grid" },
];

/** The colours a Space's look holds, by the part each plays (BrowserSpaceBrandColorRole). */
const colorRoles: readonly { readonly title: string; readonly add: string; readonly remove: string }[] = [
    { title: "Background", add: "Add Background Color", remove: "Remove Background Color" },
    { title: "Accent", add: "Add Accent Color", remove: "Remove Accent Color" },
    { title: "Pattern", add: "Add Pattern Color", remove: "Remove Pattern Color" },
];

/** The colours a new palette slot starts from (BrandColor.presets). */
const presets: readonly BrandColor[] = (["Ink", "Indigo", "Ocean", "Sky", "Teal", "Sage", "Gold", "Ember", "Rose", "Sand"] as const).map(
    (name) => Tincture.facts[name].color,
);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function hex(color: BrandColor): string {
    const channel = (value: number): string =>
        Math.round(Math.min(Math.max(value, 0), 1) * 255)
            .toString(16)
            .padStart(2, "0");
    return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

function brandColor(value: string): BrandColor {
    const channel = (at: number): number => Math.round((parseInt(value.slice(at, at + 2), 16) / 255) * 1000) / 1000;
    return { red: channel(1), green: channel(3), blue: channel(5), alpha: 1 };
}

// MARK: - Starting points

/** The house a look started from, by the name its crest recorded (SpaceHouse.startingPoint). */
function houseStartingPoint(look: SpaceBranding): SpaceHouse | undefined {
    const recorded = look.crest.startingPresetId?.toLowerCase();
    return recorded ? SpaceHouse.all.find((house) => SpaceHouse.facts[house].name === recorded) : undefined;
}

function schemeStartingPoint(look: SpaceBranding): SpaceScheme | undefined {
    return SpaceScheme.all.find((scheme) => SpaceScheme.facts[scheme].name === look.crest.startingPresetId);
}

/** `look` starting over from `house`, keeping its own strengths unless they were a scheme's (SpaceHouse.applying). */
function wearingHouse(house: SpaceHouse, look: SpaceBranding): SpaceBranding {
    const { name, look: houseLook } = SpaceHouse.facts[house];
    const fromScheme = schemeStartingPoint(look) !== undefined;
    return {
        ...look,
        ...(fromScheme
            ? {
                  bannerStrength: houseLook.bannerStrength,
                  readabilityFade: houseLook.readabilityFade,
                  textureStrength: houseLook.textureStrength,
                  textColorMode: houseLook.textColorMode,
                  symbolColor: houseLook.symbolColor,
              }
            : {}),
        colors: houseLook.colors,
        themeMode: houseLook.themeMode,
        bannerPattern: houseLook.bannerPattern,
        gradientAngle: houseLook.gradientAngle,
        iconStyle: "LayeredCrest",
        crest: { ...houseLook.crest, startingPresetId: name },
        hasCustomAppearance: false,
    };
}

/** Whether `look` still wears `house` unchanged (SpaceHouse.isWorn). */
function wearsHouse(house: SpaceHouse, look: SpaceBranding): boolean {
    const houseLook = SpaceHouse.facts[house].look;
    return (
        look.hasCustomAppearance !== true &&
        look.iconStyle === "LayeredCrest" &&
        same(look.colors, houseLook.colors) &&
        look.themeMode === houseLook.themeMode &&
        (houseLook.themeMode === "Gradient" || look.bannerPattern === houseLook.bannerPattern) &&
        same({ ...look.crest, startingPresetId: null }, { ...houseLook.crest, startingPresetId: null })
    );
}

/** `look` wearing the scheme's sidebar (SpaceScheme.applying). */
function wearingScheme(scheme: SpaceScheme, look: SpaceBranding): SpaceBranding {
    const { name, look: schemeLook } = SpaceScheme.facts[scheme];
    return {
        ...look,
        colors: schemeLook.colors,
        themeMode: schemeLook.themeMode,
        bannerPattern: schemeLook.bannerPattern,
        gradientAngle: schemeLook.gradientAngle,
        bannerStrength: schemeLook.bannerStrength,
        readabilityFade: schemeLook.readabilityFade,
        textureStrength: schemeLook.textureStrength,
        textColorMode: schemeLook.textColorMode,
        iconStyle: schemeLook.iconStyle,
        symbolColor: schemeLook.symbolColor,
        crest: { ...look.crest, startingPresetId: name },
        hasCustomAppearance: false,
    };
}

function wearsScheme(scheme: SpaceScheme, look: SpaceBranding): boolean {
    const schemeLook = SpaceScheme.facts[scheme].look;
    return (
        look.hasCustomAppearance !== true &&
        same(look.colors, schemeLook.colors) &&
        look.themeMode === schemeLook.themeMode &&
        look.gradientAngle === schemeLook.gradientAngle &&
        look.textureStrength === schemeLook.textureStrength &&
        look.iconStyle === schemeLook.iconStyle &&
        same(look.symbolColor, schemeLook.symbolColor)
    );
}

/** The look this one started from, as its house or scheme draws it (SpaceBranding.startingLook). */
function startingLook(look: SpaceBranding): SpaceBranding | null {
    const house = houseStartingPoint(look);
    if (house) return SpaceHouse.facts[house].look;
    const scheme = schemeStartingPoint(look);
    return scheme ? wearingScheme(scheme, look) : null;
}

// MARK: - Editor

export class SpaceEditor {
    private readonly host: SpaceEditorHost;
    private spaceId: Guid | null = null;
    private layer: HTMLElement | null = null;
    private body: HTMLElement | null = null;
    private headerIcon: HTMLElement | null = null;
    private readonly name = element("input", "space-editor-name");
    private release: (() => void) | null = null;
    /** The look a control shows while it moves, before the core has it. */
    private draft: SpaceBranding | null = null;
    private restoreFocus: Element | null = null;
    private readonly onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || Menu.isOpen) return;
        event.preventDefault();
        if (document.activeElement === this.name) this.name.blur();
        else this.close();
    };

    constructor(host: SpaceEditorHost) {
        this.host = host;
        this.name.spellcheck = false;
        this.name.placeholder = "Name your Space";
        this.name.setAttribute("aria-label", "Space name");
        this.name.addEventListener("change", () => this.rename());
        this.name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") this.name.blur();
            else if (event.key === "Escape") {
                event.stopPropagation();
                this.name.value = this.space()?.state.settings.name ?? "";
                this.name.blur();
            }
        });
    }

    get isOpen(): boolean {
        return this.layer !== null;
    }

    /** Opens the editor of `spaceId`, doing what `intent` asks on arrival. */
    open(spaceId: Guid, intent: SpaceEditorIntent): void {
        if (this.spaceId !== spaceId) this.close();
        this.spaceId = spaceId;
        if (!this.layer) this.build();
        this.draft = null;
        this.render();
        if (intent !== "none") {
            this.name.focus();
            this.name.select();
        }
    }

    close(): void {
        if (!this.layer) return;
        if (document.activeElement === this.name) this.rename();
        window.removeEventListener("keydown", this.onKey);
        this.layer.remove();
        this.layer = null;
        this.body = null;
        this.spaceId = null;
        this.release?.();
        this.release = null;
        if (this.restoreFocus instanceof HTMLElement && this.restoreFocus.isConnected) this.restoreFocus.focus({ preventScroll: true });
    }

    /** Draws what the core now holds for the Space, or closes once it is gone. */
    follow(): void {
        if (!this.layer) return;
        const space = this.space();
        const workspace = this.host.model.workspace;
        if (!space || !workspace || new SpaceGroups(workspace).isDeleting(space.state.id)) {
            this.close();
            return;
        }
        // A control that is moving keeps its place; the core's answer draws once it settles.
        if (this.draft) return;
        this.render();
    }

    private space(): Space | undefined {
        return this.spaceId ? this.host.model.workspace?.spaces.get(this.spaceId) : undefined;
    }

    // MARK: - Sending

    private rename(): void {
        const space = this.space();
        const workspaceId = this.host.model.workspace?.id;
        if (!space || !workspaceId) return;
        const name = this.name.value.trim();
        if (!name || name === space.state.settings.name) {
            this.name.value = space.state.settings.name;
            return;
        }
        this.setIdentity(space, { name });
    }

    private setIdentity(space: Space, change: { name?: string; symbol?: string }): void {
        const workspaceId = this.host.model.workspace?.id;
        if (!workspaceId) return;
        const settings = space.state.settings;
        void dispatch({
            kind: "SetSpaceIdentity",
            value: {
                workspaceId,
                spaceId: space.state.id,
                name: change.name ?? settings.name,
                symbol: change.symbol ?? settings.symbol,
                accent: settings.accent,
            },
        }).catch((error: unknown) => postNotice(Notices.failure(explanation(error))));
    }

    /** Keeps `look` as the Space's, which the core normalizes first. */
    private setLook(look: SpaceBranding): void {
        const space = this.space();
        const workspaceId = this.host.model.workspace?.id;
        this.draft = null;
        if (!space || !workspaceId) return;
        void dispatch({ kind: "SetSpaceBranding", value: { workspaceId, spaceId: space.state.id, branding: look } })
            .catch((error: unknown) => postNotice(Notices.failure(explanation(error))))
            .finally(() => this.follow());
    }

    /** The Space's look with `change` made by the person, which marks it their own. */
    private edited(change: Partial<SpaceBranding>): SpaceBranding {
        return { ...(this.draft ?? this.look()), ...change, hasCustomAppearance: true };
    }

    private look(): SpaceBranding {
        return this.space()!.state.settings.look;
    }

    /** Shows `look` while a control moves, without sending it. */
    private preview(look: SpaceBranding): void {
        this.draft = look;
        this.drawPreview();
    }

    // MARK: - Drawing

    private build(): void {
        this.restoreFocus = document.activeElement;
        this.release = holdOverlay();
        const layer = element("div", "space-editor-layer");
        const sheet = element("div", "space-editor");
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-modal", "true");
        sheet.setAttribute("aria-label", "Space");
        const header = element("div", "space-editor-header");
        this.headerIcon = element("span", "space-editor-header-icon");
        const actions = element("button", "space-editor-actions");
        actions.innerHTML = sfSymbol("ellipsis", 16);
        actions.title = "Space actions";
        actions.setAttribute("aria-label", "Space actions");
        actions.setAttribute("aria-haspopup", "menu");
        actions.addEventListener("click", () => void this.openActions(actions));
        const done = element("button", "space-editor-done", "Done");
        done.addEventListener("click", () => this.close());
        header.append(this.headerIcon, this.name, actions, done);
        this.body = element("div", "space-editor-body");
        sheet.append(header, this.body);
        layer.append(sheet);
        layer.addEventListener("mousedown", (event) => {
            if (event.target === layer) this.close();
        });
        document.body.append(layer);
        this.layer = layer;
        window.addEventListener("keydown", this.onKey);
    }

    private async openActions(anchor: HTMLElement): Promise<void> {
        const space = this.space();
        if (!space) return;
        const look = space.state.settings.look;
        const starting = startingLook(look);
        const entries = await this.host.actions.spaceEntries(space);
        Menu.open(
            [
                ...entries,
                "separator",
                {
                    title: "Reset Appearance",
                    icon: { kind: "symbol", name: "arrow.counterclockwise" },
                    disabled: starting === null || same(starting, look),
                    action: () => starting && this.setLook(starting),
                },
                { title: "Artwork Credits", icon: { kind: "symbol", name: "info.circle" }, action: () => void this.showCredits() },
            ],
            { anchor: anchor.getBoundingClientRect() },
        );
    }

    private async showCredits(): Promise<void> {
        let credits = "Game-icons.net · CC BY 3.0";
        try {
            credits = await (await fetch("heraldry/credits.txt")).text();
        } catch {
            // The short credit stands.
        }
        showAlert({ title: "Artwork Credits", message: credits, buttons: [{ title: "Done", role: "default" }] });
    }

    private render(): void {
        const space = this.space();
        if (!space || !this.body || !this.headerIcon) return;
        const settings = space.state.settings;
        this.headerIcon.replaceChildren(identityIcon(settings.look, settings.symbol, 26));
        if (document.activeElement !== this.name) this.name.value = settings.name;
        const scroll = this.body.scrollTop;
        this.body.replaceChildren(
            this.studioTitle(),
            this.previewCard(settings),
            this.startingPoints(settings.look),
            this.identity(space, settings),
            this.background(settings.look),
            this.reset(settings.look),
        );
        this.body.scrollTop = scroll;
    }

    private drawPreview(): void {
        const space = this.space();
        const card = this.body?.querySelector(".space-editor-preview");
        if (!space || !card) return;
        card.replaceWith(this.previewCard(space.state.settings));
    }

    private studioTitle(): HTMLElement {
        return element("h2", "space-editor-title", "Crest Studio");
    }

    /** The Space as its sidebar wears it (BrowserCrestStudioPreview). */
    private previewCard(settings: SpaceSettings): HTMLElement {
        const look = this.draft ?? settings.look;
        const card = element("div", "space-editor-preview");
        card.innerHTML = bannerSVG(look, 480, 132);
        const identity = element("div", "space-editor-preview-identity");
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        identity.classList.add(foregroundTone(look, dark) === "light" ? "reads-light" : "reads-dark");
        identity.append(identityIcon(look, settings.symbol, 72), element("span", "space-editor-preview-name", settings.name));
        card.append(identity);
        return card;
    }

    private group(title: string, ...content: HTMLElement[]): HTMLElement {
        const group = element("section", "studio-group");
        group.append(element("h3", "studio-group-title", title), ...content);
        return group;
    }

    /** A selectable tile with its artwork and caption (BrowserCrestStudioChoice). */
    private choice(title: string, selected: boolean, artwork: string | HTMLElement, select: () => void): HTMLElement {
        const tile = element("button", selected ? "studio-choice selected" : "studio-choice");
        tile.setAttribute("aria-pressed", String(selected));
        tile.setAttribute("aria-label", title);
        const art = element("span", "studio-choice-art");
        if (typeof artwork === "string") art.innerHTML = artwork;
        else art.append(artwork);
        tile.append(art, element("span", "studio-choice-title", title));
        tile.addEventListener("click", select);
        return tile;
    }

    private startingPoints(look: SpaceBranding): HTMLElement {
        const grid = element("div", "studio-grid");
        for (const house of SpaceHouse.all) {
            const worn = wearingHouse(house, look);
            grid.append(
                this.choice(SpaceHouse.facts[house].title.text, wearsHouse(house, look), crestSVG(worn, 52), () => this.setLook(worn)),
            );
        }
        for (const scheme of SpaceScheme.all) {
            const worn = wearingScheme(scheme, look);
            const art = `<span class="studio-scheme">${bannerSVG(worn, 56, 48)}</span>`;
            grid.append(this.choice(SpaceScheme.facts[scheme].title.text, wearsScheme(scheme, look), art, () => this.setLook(worn)));
        }
        return this.group(
            "Start from",
            grid,
            element("p", "studio-caption", "Choose a starting point, then make it yours. Reset controls return to this preset."),
        );
    }

    private identity(space: Space, settings: SpaceSettings): HTMLElement {
        const look = settings.look;
        const segmented = element("div", "studio-segmented");
        segmented.setAttribute("role", "radiogroup");
        segmented.setAttribute("aria-label", "Identity style");
        for (const [style, title] of [
            ["LayeredCrest", "Crest"],
            ["SimpleSymbol", "Icon"],
        ] as const) {
            const option = element("button", look.iconStyle === style ? "studio-segment selected" : "studio-segment", title);
            option.setAttribute("role", "radio");
            option.setAttribute("aria-checked", String(look.iconStyle === style));
            option.addEventListener("click", () => look.iconStyle !== style && this.setLook(this.edited({ iconStyle: style })));
            segmented.append(option);
        }
        const content: HTMLElement[] = [segmented];
        if (look.iconStyle === "SimpleSymbol") {
            const emoji = emojiOf(settings.symbol);
            const symbols = element("div", "studio-symbols");
            for (const { symbol, title } of simpleSymbols) {
                const button = element("button", !emoji && settings.symbol === symbol ? "studio-symbol selected" : "studio-symbol");
                button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="${symbol.endsWith(".fill") ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${sfSymbolPathsOf(symbol)}</svg>`;
                button.title = title;
                button.setAttribute("aria-label", title);
                button.addEventListener("click", () => this.setIdentity(space, { symbol }));
                symbols.append(button);
            }
            const emojiRow = element("label", "studio-row");
            const emojiField = element("input", "studio-emoji");
            emojiField.value = emoji ?? "";
            emojiField.placeholder = "Choose an emoji";
            emojiField.setAttribute("aria-label", "Choose Emoji");
            emojiField.addEventListener("change", () => {
                const chosen = emojiOf(symbolForEmoji(emojiField.value));
                if (chosen) this.setIdentity(space, { symbol: symbolForEmoji(chosen) });
                else emojiField.value = emoji ?? "";
            });
            emojiRow.append(element("span", "studio-row-title", "Emoji"), emojiField);
            const follows = look.symbolColor === null;
            const toggle = this.toggle("Follow Space color", follows, (on) =>
                this.setLook(this.edited({ symbolColor: on ? null : primaryColor(look) })),
            );
            content.push(symbols, emojiRow, toggle);
            if (!follows) {
                content.push(
                    this.colorRow("Icon color", symbolColor(look), (color, settled) => {
                        const next = this.edited({ symbolColor: color });
                        if (settled) this.setLook(next);
                        else this.preview(next);
                    }),
                );
            }
        }
        return this.group("Identity", ...content);
    }

    private background(look: SpaceBranding): HTMLElement {
        const slots = element("div", "studio-slots");
        const colors = look.colors.colors;
        colorRoles.forEach((role, slot) => {
            const cell = element("div", "studio-slot");
            const color = colors[slot];
            if (color) {
                const well = element("input", "studio-well");
                well.type = "color";
                well.value = hex(color);
                well.setAttribute("aria-label", role.title);
                const changed = (settled: boolean) => (): void => {
                    const next = this.edited({ colors: { colors: colors.map((held, at) => (at === slot ? brandColor(well.value) : held)) } });
                    if (settled) this.setLook(next);
                    else this.preview(next);
                };
                well.addEventListener("input", changed(false));
                well.addEventListener("change", changed(true));
                cell.append(well);
                if (slot === colors.length - 1 && colors.length > 1) {
                    const remove = element("button", "studio-slot-remove");
                    remove.innerHTML = sfSymbol("minus", 11);
                    remove.title = role.remove;
                    remove.setAttribute("aria-label", role.remove);
                    remove.addEventListener("click", () => this.setLook(this.edited({ colors: { colors: colors.slice(0, -1) } })));
                    cell.append(remove);
                }
            } else {
                const add = element("button", "studio-slot-add");
                add.innerHTML = sfSymbol("plus", 20);
                add.title = role.add;
                add.setAttribute("aria-label", role.add);
                add.disabled = slot !== colors.length;
                add.addEventListener("click", () => {
                    const next = presets.find((preset) => !colors.some((held) => same(held, preset))) ?? colors.at(-1) ?? presets[0]!;
                    this.setLook(this.edited({ colors: { colors: [...colors, next] } }));
                });
                cell.append(add);
            }
            cell.append(element("span", "studio-slot-title", role.title));
            slots.append(cell);
        });

        const patterns = element("div", "studio-grid");
        for (const pattern of SpaceBannerPattern.all) {
            const art = `<span class="studio-scheme">${bannerSVG({ ...look, themeMode: "Banner", bannerPattern: pattern }, 56, 48)}</span>`;
            patterns.append(
                this.choice(SpaceBannerPattern.facts[pattern].title.text, look.themeMode === "Banner" && look.bannerPattern === pattern, art, () =>
                    this.setLook(this.edited({ themeMode: "Banner", bannerPattern: pattern })),
                ),
            );
        }
        const gradientArt = `<span class="studio-scheme">${bannerSVG({ ...look, themeMode: "Gradient" }, 56, 48)}</span>`;
        patterns.append(
            this.choice("Gradient", look.themeMode === "Gradient", gradientArt, () => this.setLook(this.edited({ themeMode: "Gradient" }))),
        );

        const content: HTMLElement[] = [slots, patterns];
        if (look.themeMode === "Gradient") {
            content.push(this.slider("Gradient angle", look.gradientAngle, 0, 360, (value) => `${Math.round(value)}°`, (value) => ({ gradientAngle: value })));
        }
        const percent = (value: number): string => `${Math.round(value * 100)}%`;
        content.push(
            this.slider("Color intensity", look.bannerStrength, 0, 1, percent, (value) => ({ bannerStrength: value })),
            this.slider("Readability fade", look.readabilityFade, 0, 1, percent, (value) => ({ readabilityFade: value })),
            this.slider("Folder color intensity", look.folderColorIntensity, 0, 1, percent, (value) => ({ folderColorIntensity: value })),
            this.slider(
                "Texture",
                look.textureStrength,
                0,
                1,
                (value) => (value <= 0 ? "None" : value >= 1 ? "Full" : percent(value)),
                (value) => ({ textureStrength: value }),
            ),
            this.textColor(look.textColorMode),
        );
        return this.group("Space background", ...content);
    }

    private reset(look: SpaceBranding): HTMLElement {
        const starting = startingLook(look);
        const row = element("div", "studio-footer");
        const button = element("button", "studio-link", "Reset appearance to starting point");
        button.disabled = starting === null || same(starting, look);
        button.addEventListener("click", () => starting && this.setLook(starting));
        row.append(button);
        return row;
    }

    // MARK: - Controls

    private toggle(title: string, on: boolean, change: (on: boolean) => void): HTMLElement {
        const row = element("label", "studio-row");
        const control = element("input", "studio-switch");
        control.type = "checkbox";
        control.setAttribute("role", "switch");
        control.checked = on;
        control.addEventListener("change", () => change(control.checked));
        row.append(element("span", "studio-row-title", title), control);
        return row;
    }

    private colorRow(title: string, color: BrandColor, change: (color: BrandColor, settled: boolean) => void): HTMLElement {
        const row = element("label", "studio-row");
        const well = element("input", "studio-well small");
        well.type = "color";
        well.value = hex(color);
        well.addEventListener("input", () => change(brandColor(well.value), false));
        well.addEventListener("change", () => change(brandColor(well.value), true));
        row.append(element("span", "studio-row-title", title), well);
        return row;
    }

    /** A setting's slider and readout (CrestSettingSlider), previewing while it moves. */
    private slider(
        title: string,
        value: number,
        minimum: number,
        maximum: number,
        readout: (value: number) => string,
        change: (value: number) => Partial<SpaceBranding>,
    ): HTMLElement {
        const row = element("label", "studio-row");
        const range = element("input", "studio-slider");
        range.type = "range";
        range.min = String(minimum);
        range.max = String(maximum);
        range.step = String((maximum - minimum) / 100);
        range.value = String(value);
        range.setAttribute("aria-label", title);
        const shown = element("span", "studio-readout", readout(value));
        range.addEventListener("input", () => {
            shown.textContent = readout(Number(range.value));
            this.preview(this.edited(change(Number(range.value))));
        });
        range.addEventListener("change", () => this.setLook(this.edited(change(Number(range.value)))));
        row.append(element("span", "studio-row-title", title), range, shown);
        return row;
    }

    private textColor(mode: SpaceTextColorMode): HTMLElement {
        const row = element("label", "studio-row");
        const select = element("select", "studio-select");
        select.setAttribute("aria-label", "Text color");
        for (const option of TextColorModes.all) {
            const node = element("option", "", TextColorModes.facts[option].title.text);
            node.value = option;
            node.selected = option === mode;
            select.append(node);
        }
        select.addEventListener("change", () => this.setLook(this.edited({ textColorMode: select.value as SpaceTextColorMode })));
        row.append(element("span", "studio-row-title", "Text color"), select);
        return row;
    }
}
