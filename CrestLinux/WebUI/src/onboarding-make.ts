// Setup's "Make it yours" page, as the Mac's BrowserOnboardingMakePage draws
// it: the Space in a Crest window on the left, its name edited in place, and
// the sheet the chosen look offers on the right (BrowserOnboardingHeraldicSheet,
// BrowserOnboardingModernSheet, BrowserOnboardingSimpleSheet). Manual setup
// makes each new Space here (BrowserOnboardingManualSetupPage), and the review
// customizes an imported one (BrowserImportSpaceCustomizationView). Every
// change is the core's CustomizeSetupSpace or CustomizeImportSpace, and the
// core normalizes the look it keeps.
//
// TODO(linux): Shuffle, the crest's own layer colours (field, band, emblem,
// border and edge) and the full emblem catalogue (More emblems), which
// Linux's Space editor leaves out too, and the full SF Symbols catalogue (the
// eight plain glyphs stand in).

import type { BrandColor, CrestSymbol, Guid, SetupLook, SpaceBranding, SpaceCustomization } from "../generated/crest_contracts.js";
import {
    CrestSymbol as CrestSymbols,
    SpaceAccent,
    SpaceBannerPattern,
    SpaceHouse,
    SpaceScheme,
    Tincture,
} from "../generated/crest_contracts.js";
import { bannerSVG, crestSVG, emojiOf, identityIcon, symbolForEmoji } from "./crest.js";
import type { Onboarding, ReviewSpace } from "./onboarding.js";
import { failureMessage } from "./onboarding.js";
import { button, continueButton, el, failureLabel, footer, headline, unavailable, wearingLook, windowPreview } from "./onboarding-stage.js";
import type { BackAction } from "./onboarding-stage.js";
import { brandColor, hex, simpleSymbols, wearingHouse, wearsHouse } from "./space-editor.js";
import { sfSymbol, sfSymbolPaths } from "./symbols.js";

// MARK: - Types

interface MakeOptions {
    readonly look: SetupLook;
    /** Which Space the page makes, which keeps its fields' focus across drawings. */
    readonly key: Guid;
    readonly customization: SpaceCustomization;
    readonly name: string;
    readonly apply: (customization: SpaceCustomization) => void;
    readonly chips?: HTMLElement;
    readonly failure: string | null;
    readonly back: BackAction | null;
    readonly advanceTitle: string;
    readonly advance: () => void;
}

/** The colours a look holds, by the part each plays (BrowserSpaceBrandColorRole). */
const colorRoles = ["Background", "Accent", "Pattern"] as const;

/** The colours the Simple look offers (BrowserSimpleSpaceColor). */
const simpleColors: readonly Tincture[] = [
    "Rose",
    "DragonScarlet",
    "Ember",
    "SunOr",
    "Sage",
    "Teal",
    "Sky",
    "RiverAzure",
    "Indigo",
    "NeutralGray",
];

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

// MARK: - Pages

export function manualSetupPage(setup: Onboarding): HTMLElement {
    const draft = setup.selectedDraft();
    if (!draft) {
        const page = el("div", "onboarding-column-page");
        page.append(
            unavailable("square.grid.2x2", "Create your first Space", "", [button("Add Space", "primary", () => setup.addSetupSpace())]),
        );
        return page;
    }
    const chips = el("div", "onboarding-chips");
    chips.setAttribute("role", "tablist");
    for (const space of setup.draftSpaces) {
        const chip = el("div", space.spaceId === draft.spaceId ? "onboarding-chip selected" : "onboarding-chip");
        const choose = el("button", "onboarding-chip-choose");
        choose.type = "button";
        choose.setAttribute("role", "tab");
        choose.setAttribute("aria-selected", String(space.spaceId === draft.spaceId));
        choose.append(identityIcon(space.customization.branding, space.customization.symbol, 18), el("span", "", space.shownName));
        choose.addEventListener("click", () => setup.selectSetupSpace(space.spaceId));
        chip.append(choose);
        if (space.isNew) {
            const remove = el("button", "onboarding-chip-remove");
            remove.type = "button";
            remove.innerHTML = sfSymbol("xmark", 10);
            remove.setAttribute("aria-label", `Remove ${space.shownName}`);
            remove.addEventListener("click", () => setup.removeSetupSpace(space.spaceId));
            chip.append(remove);
        }
        chips.append(chip);
    }
    const add = el("button", "onboarding-chip add");
    add.type = "button";
    add.innerHTML = sfSymbol("plus", 12);
    add.append(el("span", "", "New Space"));
    add.addEventListener("click", () => setup.addSetupSpace());
    chips.append(add);
    return makePage({
        look: setup.look,
        key: draft.spaceId,
        customization: draft.customization,
        name: draft.shownName,
        apply: (customization) => setup.customizeSetupSpace(draft.spaceId, customization),
        chips,
        failure: failureMessage(setup.flow) ?? setup.manualError,
        back: setup.back(),
        advanceTitle: "Continue",
        advance: () => setup.show("Complete"),
    });
}

export function customizationPage(setup: Onboarding, review: ReviewSpace): HTMLElement {
    const done = (): void => setup.closeCustomization();
    return makePage({
        look: setup.look,
        key: review.id,
        customization: review.record.customization,
        name: review.record.shownName,
        apply: (customization) => setup.customizeImport(review.id, customization),
        failure: null,
        back: { closes: false, action: done },
        advanceTitle: "Done",
        advance: done,
    });
}

function makePage(options: MakeOptions): HTMLElement {
    const { customization, apply } = options;
    const page = el("div", "onboarding-column-page onboarding-make");
    const top = el("div", "onboarding-make-header");
    top.append(headline("Make it yours"), el("span", "onboarding-spacer"));
    if (options.chips) top.append(options.chips);

    const nameField = el("input", "onboarding-window-name");
    nameField.value = customization.name;
    nameField.placeholder = options.name || "Your Space";
    nameField.setAttribute("aria-label", "Space name");
    nameField.dataset["focus"] = `name-${options.key}`;
    nameField.addEventListener("input", () => apply({ ...customization, name: nameField.value }));
    const body = el("div", "onboarding-make-body");
    const preview = windowPreview({
        branding: customization.branding,
        symbol: customization.symbol,
        name: options.name,
        nameField,
        showsNameHint: true,
        page: (() => {
            const holder = el("div", "onboarding-page-icon");
            holder.append(identityIcon(customization.branding, customization.symbol, 140));
            return holder;
        })(),
    });
    preview.classList.add("onboarding-make-preview");
    const sheet = el("div", "onboarding-make-sheet");
    sheet.dataset["scroll"] = `sheet-${options.key}`;
    const setBranding = (branding: SpaceBranding): void => apply({ ...customization, branding });
    const setSymbol = (symbol: string): void => apply({ ...customization, symbol });
    switch (options.look) {
        case "Heraldic":
            sheet.append(...heraldicSheet(customization, setBranding, setSymbol));
            break;
        case "Modern":
            sheet.append(...modernSheet(customization, setBranding, setSymbol));
            break;
        case "Simple":
            sheet.append(...simpleSheet(customization, setBranding, setSymbol));
            break;
    }
    body.append(preview, sheet);

    const trailing: HTMLElement[] = [];
    if (options.failure) trailing.push(failureLabel(options.failure));
    trailing.push(continueButton(options.advanceTitle, options.advance));
    page.append(top, body, footer(options.back, trailing));
    return page;
}

// MARK: - Sheet parts

/** A titled part of the sheet (BrowserOnboardingMakeSection). */
function section(title: string, content: readonly HTMLElement[], accessory?: HTMLElement): HTMLElement {
    const part = el("section", "onboarding-make-section");
    const header = el("div", "onboarding-make-section-header");
    header.append(el("h2", "", title));
    if (accessory) header.append(accessory);
    part.append(header, ...content);
    return part;
}

/** A row of choices that scrolls sideways (BrowserOnboardingMakeStrip). */
function strip(items: readonly HTMLElement[]): HTMLElement {
    const row = el("div", "onboarding-make-strip");
    row.append(...items);
    return row;
}

/** A choice with its artwork (BrowserOnboardingMakeTile). */
function tile(title: string, selected: boolean, artwork: string | HTMLElement, select: () => void): HTMLElement {
    const choice = el("button", selected ? "onboarding-make-tile selected" : "onboarding-make-tile");
    choice.type = "button";
    choice.title = title;
    choice.setAttribute("aria-label", title);
    choice.setAttribute("aria-pressed", String(selected));
    if (typeof artwork === "string") choice.innerHTML = artwork;
    else choice.append(artwork);
    choice.addEventListener("click", select);
    return choice;
}

/** A segmented choice between two or three (the Mac's segmented Picker). */
function segmented<T extends string>(
    label: string,
    options: readonly (readonly [T, string])[],
    selected: T,
    choose: (value: T) => void,
): HTMLElement {
    const group = el("div", "onboarding-segmented");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [value, title] of options) {
        const option = el("button", value === selected ? "onboarding-segment selected" : "onboarding-segment", title);
        option.type = "button";
        option.setAttribute("role", "radio");
        option.setAttribute("aria-checked", String(value === selected));
        option.addEventListener("click", () => value !== selected && choose(value));
        group.append(option);
    }
    return group;
}

/** A colour well with its caption, which the system's colour chooser sets (BrowserOnboardingMakeSwatch). */
function swatch(title: string, color: BrandColor, select: (color: BrandColor) => void): HTMLElement {
    const holder = el("label", "onboarding-swatch");
    const well = el("input", "onboarding-swatch-well");
    well.type = "color";
    well.value = hex(color);
    well.setAttribute("aria-label", title);
    well.addEventListener("change", () => select(brandColor(well.value)));
    holder.append(well, el("span", "", title));
    return holder;
}

/** The look's sidebar colours, by the part each plays (BrowserOnboardingSidebarSwatches). */
function sidebarSwatches(branding: SpaceBranding, setBranding: (branding: SpaceBranding) => void): HTMLElement[] {
    const colors = branding.colors.colors;
    return colorRoles.flatMap((role, index) => {
        const color = colors[index];
        if (!color) return [];
        return [
            swatch(role, color, (chosen) => {
                const next = [...colors];
                next[index] = chosen;
                setBranding({ ...branding, colors: { colors: next }, hasCustomAppearance: true });
            }),
        ];
    });
}

/** The Space's plain glyph or emoji (BrowserOnboardingIconSection). */
function iconSection(customization: SpaceCustomization, setSymbol: (symbol: string) => void): HTMLElement {
    return section("Icon", iconChoices(customization, setSymbol));
}

function iconChoices(customization: SpaceCustomization, setSymbol: (symbol: string) => void): HTMLElement[] {
    const emoji = emojiOf(customization.symbol);
    const glyphs = strip(
        simpleSymbols.map(({ symbol, title }) =>
            tile(
                title,
                !emoji && customization.symbol === symbol,
                `<svg viewBox="0 0 24 24" width="22" height="22" fill="${symbol.endsWith(".fill") ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${sfSymbolPaths(symbol)}</svg>`,
                () => setSymbol(symbol),
            ),
        ),
    );
    const emojiRow = el("label", "onboarding-emoji");
    emojiRow.innerHTML = sfSymbol("face.smiling", 16);
    const field = el("input", "onboarding-emoji-field");
    field.value = emoji ?? "";
    field.placeholder = emoji ? "Change emoji" : "Choose an emoji";
    field.setAttribute("aria-label", "Emoji");
    field.addEventListener("change", () => {
        const chosen = emojiOf(symbolForEmoji(field.value));
        if (chosen) setSymbol(symbolForEmoji(chosen));
        else field.value = emoji ?? "";
    });
    emojiRow.append(field);
    return [glyphs, emojiRow];
}

// MARK: - Heraldic

function heraldicSheet(
    customization: SpaceCustomization,
    setBranding: (branding: SpaceBranding) => void,
    setSymbol: (symbol: string) => void,
): HTMLElement[] {
    const branding = customization.branding;
    const crestArt = (look: SpaceBranding): string => crestSVG(look, 40);

    const startFrom = section("Start from", [
        strip(
            SpaceHouse.all.map((house) =>
                tile(SpaceHouse.facts[house].title.text, wearsHouse(house, branding), crestArt(wearingHouse(house, branding)), () =>
                    setBranding(wearingHouse(house, branding)),
                ),
            ),
        ),
    ]);

    const isIcon = branding.iconStyle === "SimpleSymbol";
    const style = segmented(
        "Identity",
        [
            ["LayeredCrest", "Crest"],
            ["SimpleSymbol", "Icon"],
        ],
        branding.iconStyle === "SimpleSymbol" ? "SimpleSymbol" : "LayeredCrest",
        (iconStyle) => setBranding({ ...branding, iconStyle }),
    );
    const figures: CrestSymbol[] = CrestSymbols.all.filter((figure) => CrestSymbols.facts[figure].isOffered).slice(0, 8);
    if (!figures.includes(branding.crest.symbol) && figures.length === 8) figures[7] = branding.crest.symbol;
    const wearing = (figure: CrestSymbol): SpaceBranding => ({ ...branding, crest: { ...branding.crest, symbol: figure, charge: null } });
    const emblem = section(
        "Emblem",
        isIcon
            ? iconChoices(customization, setSymbol)
            : [
                  strip(
                      figures.map((figure) =>
                          tile(
                              CrestSymbols.facts[figure].title.text,
                              branding.crest.charge === null && branding.crest.symbol === figure,
                              crestArt(wearing(figure)),
                              () => setBranding({ ...wearing(figure), hasCustomAppearance: true }),
                          ),
                      ),
                  ),
              ],
        style,
    );

    const colors = section("Colors", [strip(sidebarSwatches(branding, setBranding))]);

    const field = (look: SpaceBranding): string => bannerSVG(look, 40, 40);
    const patterns = SpaceBannerPattern.all.map((pattern) =>
        tile(
            SpaceBannerPattern.facts[pattern].title.text,
            branding.themeMode === "Banner" && branding.bannerPattern === pattern,
            field({ ...branding, themeMode: "Banner", bannerPattern: pattern }),
            () => setBranding({ ...branding, themeMode: "Banner", bannerPattern: pattern, hasCustomAppearance: true }),
        ),
    );
    patterns.push(
        tile("Gradient", branding.themeMode === "Gradient", field({ ...branding, themeMode: "Gradient" }), () =>
            setBranding({ ...branding, themeMode: "Gradient", hasCustomAppearance: true }),
        ),
    );
    const sidebar = section("Sidebar", [strip(patterns)]);
    return [
        startFrom,
        emblem,
        colors,
        sidebar,
        el("p", "onboarding-detail onboarding-make-note", "Shape, field, band, border and finish: Settings › Spaces."),
    ];
}

// MARK: - Modern

function modernSheet(
    customization: SpaceCustomization,
    setBranding: (branding: SpaceBranding) => void,
    setSymbol: (symbol: string) => void,
): HTMLElement[] {
    const branding = customization.branding;
    const presets: (readonly BrandColor[])[] = [
        ...SpaceAccent.all.map((accent) => SpaceAccent.facts[accent].legacyColors),
        ...SpaceScheme.all.map((scheme) => SpaceScheme.facts[scheme].look.colors.colors),
        ...SpaceHouse.all.map((house) => SpaceHouse.facts[house].look.colors.colors),
    ];
    const rgb = (color: BrandColor): string =>
        `rgb(${Math.round(color.red * 255)} ${Math.round(color.green * 255)} ${Math.round(color.blue * 255)})`;
    const titles = [
        ...SpaceAccent.all.map((accent) => accent),
        ...SpaceScheme.all.map((scheme) => SpaceScheme.facts[scheme].title.text),
        ...SpaceHouse.all.map((house) => SpaceHouse.facts[house].title.text),
    ];
    const swatches = presets.map((preset, index) => {
        const circle = el("span", "onboarding-preset");
        circle.style.background = `linear-gradient(135deg, ${preset.map(rgb).join(", ")})`;
        return tile(titles[index] ?? "", same(branding.colors.colors, preset), circle, () =>
            setBranding({ ...branding, colors: { colors: [...preset] }, hasCustomAppearance: true }),
        );
    });
    const color = section("Color", [strip(swatches), strip(sidebarSwatches(branding, setBranding))]);
    const fill = section("Fill", [
        segmented(
            "Fill",
            [
                ["gradient", "Gradient"],
                ["solid", "Solid"],
            ],
            branding.themeMode === "Gradient" ? "gradient" : "solid",
            (chosen) =>
                setBranding(
                    chosen === "gradient"
                        ? { ...branding, themeMode: "Gradient", hasCustomAppearance: true }
                        : { ...branding, themeMode: "Banner", bannerPattern: "Solid", hasCustomAppearance: true },
                ),
        ),
    ]);
    return [
        color,
        fill,
        iconSection(customization, setSymbol),
        el("p", "onboarding-detail onboarding-make-note", "Patterns and crests: Settings › Spaces."),
    ];
}

// MARK: - Simple

/** `branding` in one colour, as the Simple look wears it (BrowserSimpleSpaceColor.look). */
function simpleLook(color: BrandColor, branding: SpaceBranding): SpaceBranding {
    const wearsSimple = branding.colors.colors.length === 1 && branding.themeMode === "Gradient";
    const look = wearingLook("Simple", { ...branding, colors: { colors: [color] } });
    return { ...look, bannerStrength: wearsSimple ? branding.bannerStrength : look.bannerStrength, hasCustomAppearance: true };
}

function simpleSheet(
    customization: SpaceCustomization,
    setBranding: (branding: SpaceBranding) => void,
    setSymbol: (symbol: string) => void,
): HTMLElement[] {
    const branding = customization.branding;
    const single = branding.colors.colors.length === 1 && branding.themeMode === "Gradient" ? branding.colors.colors[0] : undefined;
    const worn = simpleColors.find((tincture) => single !== undefined && same(Tincture.facts[tincture].color, single));
    const swatches = simpleColors.map((tincture) => {
        const { color, title } = Tincture.facts[tincture];
        const circle = el("span", "onboarding-preset large");
        circle.style.background = hex(color);
        return tile(title.text, worn === tincture, circle, () => setBranding(simpleLook(color, branding)));
    });
    const custom = swatch("Custom color", branding.colors.colors[0] ?? Tincture.facts.Rose.color, (color) =>
        setBranding(simpleLook(color, branding)),
    );
    custom.classList.toggle("selected", single !== undefined && worn === undefined);
    return [section("Color", [strip([...swatches, custom])]), iconSection(customization, setSymbol)];
}
