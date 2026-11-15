// A Space's crest and backdrop drawn as SVG, as the Mac draws them in
// SwiftUI: BrowserSpaceCrestIcon (plate, field, band, edge, trim and charge,
// coloured from the crest's own tinctures or the Space's),
// BrowserSpaceIdentityIcon (the crest, or the Space's plain symbol or
// emoji) and BrowserSpaceBannerBackground (the banner pattern or gradient a
// Space's sidebar wears).
//
// Every shape follows the Mac's path for path, in the same proportions of the
// icon's size. The heraldic charges are the Mac's own artwork
// (CrestHeraldry.xcassets), which the build copies to heraldry/ and which a
// mask recolours, as the Mac's template images are. A charge the Mac draws
// as an SF Symbol uses the glyph symbols.ts has for it.

import type { BrandColor, CrestCharge, SpaceBranding, SpaceCrest, SpaceSettings } from "../generated/crest_contracts.js";
import { CrestSymbol, TabIconMode, Tincture } from "../generated/crest_contracts.js";
import { sfSymbolPaths } from "./symbols.js";

// MARK: - Types

interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** BrandColor.indigo, which a look with no colours draws with. */
const indigo: BrandColor = Tincture.facts.Indigo.color;

/** The plate's diameter as a fraction of the icon, before the crest's plate scale. */
const plateFraction = 0.78;

let nextId = 0;

// MARK: - Colours

function rgb(color: BrandColor, alpha = color.alpha): string {
    const channel = (value: number): number => Math.round(Math.min(Math.max(value, 0), 1) * 255);
    return `rgb(${channel(color.red)} ${channel(color.green)} ${channel(color.blue)} / ${alpha})`;
}

/** The colours a crest's layer indices point into (SpaceCrest.layerColors). */
function layerColors(crest: SpaceCrest, branding: SpaceBranding): readonly BrandColor[] {
    if (crest.palette && crest.palette.colors.length > 0) return crest.palette.colors;
    return branding.colors.colors.length > 0 ? branding.colors.colors : [indigo];
}

/** The colour of the look's accent slot, or its background's (SpaceBranding.primaryColor). */
export function primaryColor(branding: SpaceBranding): BrandColor {
    return branding.colors.colors[1] ?? branding.colors.colors[0] ?? indigo;
}

/** What a plain symbol is drawn in (SpaceBranding.resolvedSymbolColor). */
export function symbolColor(branding: SpaceBranding): BrandColor {
    return branding.symbolColor ?? primaryColor(branding);
}

/** The emoji a Space's or tab's symbol carries, if it is one (BrowserIconSymbol.emoji). */
export function emojiOf(symbol: string): string | null {
    const prefix = TabIconMode.constants.emojiPrefix;
    if (!symbol.startsWith(prefix)) return null;
    const emoji = [...new Intl.Segmenter().segment(symbol.slice(prefix.length).trim())][0]?.segment ?? "";
    return /\p{Emoji_Presentation}|️|⃣/u.test(emoji) ? emoji : null;
}

/** The symbol a Space wears for `emoji` (BrowserIconSymbol.symbol(forEmoji:)). */
export function symbolForEmoji(emoji: string): string {
    return TabIconMode.constants.emojiPrefix + emoji;
}

// MARK: - Plates

function plateD(backplate: SpaceCrest["backplate"], rect: Rect, scallops: number): string {
    const { x, y, width: w, height: h } = rect;
    const p = (px: number, py: number): string => `${x + px * w} ${y + py * h}`;
    const ellipse = (inset: number): string => {
        const rx = w / 2 - inset;
        const ry = h / 2;
        const cx = x + w / 2;
        const cy = y + h / 2;
        return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    };
    switch (backplate) {
        case "None":
            return "";
        case "Circle":
            return ellipse(0);
        case "Oval":
            return ellipse(w * 0.11);
        case "Shield":
            return `M${p(0.06, 0.08)}L${p(0.94, 0.08)}L${p(0.94, 0.46)}Q${p(0.94, 0.86)} ${p(0.5, 0.98)}Q${p(0.06, 0.86)} ${p(0.06, 0.46)}Z`;
        case "FrenchShield":
            return `M${p(0.08, 0.04)}L${p(0.92, 0.04)}L${p(0.92, 0.7)}Q${p(0.92, 0.97)} ${p(0.5, 0.97)}Q${p(0.08, 0.97)} ${p(0.08, 0.7)}Z`;
        case "Diamond":
            return `M${p(0.5, 0.02)}L${p(0.96, 0.5)}L${p(0.5, 0.98)}L${p(0.04, 0.5)}Z`;
        case "Hexagon":
            return polygon(6, rect, -Math.PI / 2);
        case "Octagon":
            return polygon(8, rect, Math.PI / 8);
        case "RoundedSquare": {
            const inset = { x: x + w * 0.05, y: y + h * 0.05, width: w * 0.9, height: h * 0.9 };
            const r = w * 0.22;
            return `M${inset.x + r} ${inset.y}H${inset.x + inset.width - r}A${r} ${r} 0 0 1 ${inset.x + inset.width} ${inset.y + r}V${inset.y + inset.height - r}A${r} ${r} 0 0 1 ${inset.x + inset.width - r} ${inset.y + inset.height}H${inset.x + r}A${r} ${r} 0 0 1 ${inset.x} ${inset.y + inset.height - r}V${inset.y + r}A${r} ${r} 0 0 1 ${inset.x + r} ${inset.y}Z`;
        }
        case "Seal":
            return scalloped(rect, Math.max(6, scallops));
        case "Banner":
            return `M${p(0.12, 0.04)}L${p(0.88, 0.04)}L${p(0.88, 0.76)}L${p(0.5, 0.97)}L${p(0.12, 0.76)}Z`;
        case "Badge": {
            const cx = x + 0.5 * w;
            const cy = y + 0.44 * h;
            const r = w * 0.44;
            const at = (degrees: number): string => `${cx + Math.cos((degrees * Math.PI) / 180) * r} ${cy + Math.sin((degrees * Math.PI) / 180) * r}`;
            // From 160° to 20° the long way round, over the top, as the Mac's arc runs.
            return `M${at(160)}A${r} ${r} 0 1 1 ${at(20)}L${p(0.5, 0.98)}Z`;
        }
    }
}

function polygon(sides: number, rect: Rect, rotation: number): string {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2;
    let d = "";
    for (let index = 0; index < sides; index++) {
        const angle = rotation + (index / sides) * 2 * Math.PI;
        d += `${index === 0 ? "M" : "L"}${cx + Math.cos(angle) * radius} ${cy + Math.sin(angle) * radius}`;
    }
    return `${d}Z`;
}

function scalloped(rect: Rect, scallops: number): string {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const outer = Math.min(rect.width, rect.height) / 2;
    const inner = outer * 0.9;
    let d = "";
    for (let index = 0; index < scallops; index++) {
        const start = (index / scallops) * 2 * Math.PI - Math.PI / 2;
        const end = ((index + 1) / scallops) * 2 * Math.PI - Math.PI / 2;
        const mid = (start + end) / 2;
        if (index === 0) d += `M${cx + Math.cos(start) * inner} ${cy + Math.sin(start) * inner}`;
        d += `Q${cx + Math.cos(mid) * outer * 1.08} ${cy + Math.sin(mid) * outer * 1.08} ${cx + Math.cos(end) * inner} ${cy + Math.sin(end) * inner}`;
    }
    return `${d}Z`;
}

/** `rect` grown by `scale` about its centre. */
function scaled(rect: Rect, scale: number): Rect {
    const width = rect.width * scale;
    const height = rect.height * scale;
    return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

function box(x: number, y: number, width: number, height: number): string {
    return `M${x} ${y}h${width}v${height}h${-width}Z`;
}

// MARK: - Field

/** The part of the field that takes the second colour (BrowserSpaceCrestDivisionShape). */
function divisionD(division: SpaceCrest["fieldDivision"], count: number, rect: Rect): string {
    const { x, y, width: w, height: h } = rect;
    const p = (px: number, py: number): string => `${x + px * w} ${y + py * h}`;
    switch (division) {
        case "Plain":
            return "";
        case "PerPale":
            return box(x + w / 2, y, w / 2, h);
        case "PerFess":
            return box(x, y + h / 2, w, h / 2);
        case "PerBend":
            return `M${p(1, 0)}L${p(1, 1)}L${p(0, 1)}Z`;
        case "PerChevron":
            return `M${p(0, 0.48)}L${p(0.5, 0.68)}L${p(1, 0.48)}L${p(1, 1)}L${p(0, 1)}Z`;
        case "Quarterly":
            return box(x + w / 2, y, w / 2, h / 2) + box(x, y + h / 2, w / 2, h / 2);
        case "PerSaltire":
            return `M${p(0, 0)}L${p(1, 0)}L${p(0.5, 0.5)}ZM${p(0, 1)}L${p(1, 1)}L${p(0.5, 0.5)}Z`;
        case "Gyronny": {
            const wedges = Math.max(2, count) * 2;
            const cx = x + w / 2;
            const cy = y + h / 2;
            const radius = Math.max(w, h);
            let d = "";
            for (let index = 0; index < wedges; index += 2) {
                const start = (index / wedges) * 2 * Math.PI - Math.PI / 2;
                const end = ((index + 1) / wedges) * 2 * Math.PI - Math.PI / 2;
                d += `M${cx} ${cy}L${cx + Math.cos(start) * radius} ${cy + Math.sin(start) * radius}L${cx + Math.cos(end) * radius} ${cy + Math.sin(end) * radius}Z`;
            }
            return d;
        }
        case "Barry": {
            const bands = Math.max(2, count);
            const band = h / bands;
            let d = "";
            for (let index = 1; index < bands; index += 2) d += box(x, y + index * band, w, band);
            return d;
        }
        case "Paly": {
            const bands = Math.max(2, count);
            const band = w / bands;
            let d = "";
            for (let index = 1; index < bands; index += 2) d += box(x + index * band, y, band, h);
            return d;
        }
        case "Checky": {
            const cells = Math.max(2, count);
            const cw = w / cells;
            const ch = h / cells;
            let d = "";
            for (let row = 0; row < cells; row++) {
                for (let column = 0; column < cells; column++) {
                    if ((row + column) % 2 === 1) d += box(x + column * cw, y + row * ch, cw, ch);
                }
            }
            return d;
        }
    }
}

/** The light a finish lays over the field (BrowserSpaceCrestField). */
function finishFill(crest: SpaceCrest, rect: Rect, id: string): { defs: string; fill: string } | null {
    switch (crest.finish) {
        case "Flat":
            return null;
        case "Sheen": {
            const radians = (crest.sheenAngle * Math.PI) / 180;
            const point = (direction: number): [number, number] => [
                rect.x + (0.5 + Math.cos(radians) * 0.5 * direction) * rect.width,
                rect.y + (0.5 + Math.sin(radians) * 0.5 * direction) * rect.height,
            ];
            const [x1, y1] = point(-1);
            const [x2, y2] = point(1);
            return {
                defs: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.06"/><stop offset="1" stop-color="#000" stop-opacity="0.1"/></linearGradient>`,
                fill: `url(#${id})`,
            };
        }
        case "Embossed":
            return {
                defs: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${rect.y}" x2="0" y2="${rect.y + rect.height}"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.26"/></linearGradient>`,
                fill: `url(#${id})`,
            };
    }
}

// MARK: - Ordinary

/** A band laid across the field (BrowserSpaceCrestOrdinaryPath): a fill path, or a stroked centre line. */
function ordinary(crest: SpaceCrest, rect: Rect, color: string): string {
    const { x, y, width: w, height: h } = rect;
    const band = Math.min(w, h) * 0.17 * crest.ordinaryWidth;
    const p = (px: number, py: number): string => `${x + px * w} ${y + py * h}`;
    const fill = (d: string): string => `<path d="${d}" fill="${color}"/>`;
    const stroke = (d: string): string =>
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${band}" stroke-linecap="butt" stroke-linejoin="miter"/>`;
    switch (crest.ordinary) {
        case "None":
        case "Bordure":
            return "";
        case "Pale":
            return fill(box(x + w / 2 - band / 2, y, band, h));
        case "Fess":
            return fill(box(x, y + h / 2 - band / 2, w, band));
        case "Bend":
            return stroke(`M${p(-0.1, -0.1)}L${p(1.1, 1.1)}`);
        case "Chevron":
            return stroke(`M${p(0.04, 0.78)}L${p(0.5, 0.34)}L${p(0.96, 0.78)}`);
        case "Cross":
            return fill(box(x + w / 2 - band / 2, y, band, h) + box(x, y + h / 2 - band / 2, w, band));
        case "Saltire":
            return stroke(`M${p(-0.1, -0.1)}L${p(1.1, 1.1)}M${p(1.1, -0.1)}L${p(-0.1, 1.1)}`);
        case "Chief":
            return fill(box(x, y, w, band * 1.4));
        case "Pall":
            return stroke(`M${p(0.02, 0.02)}L${p(0.5, 0.5)}M${p(0.98, 0.02)}L${p(0.5, 0.5)}M${p(0.5, 0.5)}L${p(0.5, 1.02)}`);
        case "Pile": {
            const half = 0.28 * crest.ordinaryWidth;
            return fill(`M${p(0.5 - half, -0.02)}L${p(0.5 + half, -0.02)}L${p(0.5, 0.8)}Z`);
        }
        case "Canton": {
            const side = Math.min(w, h) * 0.36 * crest.ordinaryWidth;
            return fill(box(x, y, side, side));
        }
        case "Roundel": {
            const r = (Math.min(w, h) * 0.34 * crest.ordinaryWidth) / 2;
            return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${r}" fill="${color}"/>`;
        }
    }
}

// MARK: - Trim

/** A laurel branch curving up one side of the plate, standing in for SF Symbols' laurel.leading. */
function laurel(size: number, color: string, mirrored: boolean, weight: number): string {
    const cx = size / 2;
    const radius = size * 0.43;
    const leaf = size * (weight > 1.3 ? 0.075 : 0.065);
    let leaves = "";
    const from = 110;
    const to = 250;
    const count = 7;
    for (let index = 0; index < count; index++) {
        const degrees = from + ((to - from) * index) / (count - 1);
        const radians = (degrees * Math.PI) / 180;
        const lx = cx + Math.cos(radians) * radius;
        const ly = size / 2 + Math.sin(radians) * radius * 0.98;
        const tilt = degrees - 90 + 35;
        leaves += `<ellipse cx="${lx}" cy="${ly}" rx="${leaf * 0.45}" ry="${leaf}" transform="rotate(${tilt} ${lx} ${ly})"/>`;
    }
    const stem = `<path d="M${cx + Math.cos((105 * Math.PI) / 180) * radius} ${size / 2 + Math.sin((105 * Math.PI) / 180) * radius}A${radius} ${radius} 0 0 1 ${cx + Math.cos((250 * Math.PI) / 180) * radius} ${size / 2 + Math.sin((250 * Math.PI) / 180) * radius}" fill="none" stroke="${color}" stroke-width="${Math.max(0.6, size * 0.012)}"/>`;
    const transform = mirrored ? ` transform="translate(${size} 0) scale(-1 1)"` : "";
    return `<g fill="${color}"${transform}>${stem}${leaves}</g>`;
}

function trim(crest: SpaceCrest, plateRect: Rect, size: number, color: string): string {
    const lineWidth = Math.max(0.75, size * 0.032 * crest.trimWeight);
    const outline = (scale: number, width: number): string =>
        `<path d="${plateD(crest.backplate, scaled(plateRect, scale), crest.sealTeeth)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/>`;
    const detail = crest.trimDetail;
    switch (crest.trim) {
        case "None":
            return "";
        case "Shield":
            return outline(1.12, lineWidth * 1.15);
        case "Line":
            return outline(1.1, lineWidth * 0.8);
        case "DoubleLine":
        case "DoubleRing":
            return outline(1.09, lineWidth * 0.8) + outline(1.2, lineWidth * 0.6);
        case "Seal":
            return `<path d="${scalloped(scaled(plateRect, 1.14), Math.max(8, detail))}" fill="none" stroke="${color}" stroke-width="${lineWidth * 0.8}"/>`;
        case "Laurel":
            return laurel(size, color, false, crest.trimWeight) + laurel(size, color, true, crest.trimWeight);
        case "Sunburst": {
            const rays = Math.max(6, detail);
            const c = size / 2;
            const step = (2 * Math.PI) / rays;
            const spread = (step * Math.min(0.45, 0.35 * crest.trimWeight)) / 2;
            let d = "";
            for (let index = 0; index < rays; index++) {
                const angle = index * step - Math.PI / 2;
                const at = (a: number, r: number): string => `${c + Math.cos(a) * size * r} ${c + Math.sin(a) * size * r}`;
                d += `M${at(angle - spread, 0.41)}L${at(angle, 0.5)}L${at(angle + spread, 0.41)}Z`;
            }
            return `<path d="${d}" fill="${color}"/>`;
        }
        case "Beaded": {
            const beads = Math.max(6, detail) * 2;
            const c = size / 2;
            let circles = "";
            for (let index = 0; index < beads; index++) {
                const angle = (index / beads) * 2 * Math.PI - Math.PI / 2;
                circles += `<circle cx="${c + Math.cos(angle) * size * 0.455}" cy="${c + Math.sin(angle) * size * 0.455}" r="${size * 0.018 * crest.trimWeight}"/>`;
            }
            return `<g fill="${color}">${circles}</g>`;
        }
    }
}

// MARK: - Charge

/** The charge the crest shows: its own, or its heraldic symbol (SpaceCrest.resolvedCharge). */
function resolvedCharge(crest: SpaceCrest): CrestCharge {
    return crest.charge ?? { kind: "Heraldic", symbol: crest.symbol, text: null, style: null };
}

function escapeText(text: string): string {
    return text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** One figure centred on (cx, cy), `point` the Mac's point size (BrowserSpaceCrestChargeGlyph). */
function glyph(charge: CrestCharge, cx: number, cy: number, point: number, weight: SpaceCrest["chargeWeight"], color: string): string {
    const fontWeight = { Light: 500, Regular: 600, Bold: 700 }[weight];
    switch (charge.kind) {
        case "Heraldic": {
            const facts = CrestSymbol.facts[charge.symbol ?? "Dragon"];
            if (facts.assetName) {
                const side = point * 1.25;
                const id = `crest-charge-${nextId++}`;
                const x = cx - side / 2;
                const y = cy - side / 2;
                return `<mask id="${id}" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${side}" height="${side}"><image href="heraldry/${facts.assetName}.svg" x="${x}" y="${y}" width="${side}" height="${side}"/></mask><rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${color}" mask="url(#${id})"/>`;
            }
            return symbolGlyph(facts.systemImage, cx, cy, point, color);
        }
        case "System":
            return symbolGlyph(charge.text ?? "", cx, cy, point, color);
        case "Emoji":
            return `<text x="${cx}" y="${cy}" font-size="${point * 1.05}" text-anchor="middle" dominant-baseline="central">${escapeText(charge.text ?? "")}</text>`;
        case "Monogram": {
            const letters = charge.text ?? "";
            const family = (charge.style ?? "Serif") === "Serif" ? "var(--crest-font-display, serif)" : "var(--crest-font-ui, sans-serif)";
            return `<text x="${cx}" y="${cy}" font-size="${point * (letters.length > 1 ? 0.92 : 1.15)}" font-weight="${fontWeight}" font-family="${family}" fill="${color}" text-anchor="middle" dominant-baseline="central">${escapeText(letters)}</text>`;
        }
        case "None":
            return "";
    }
}

/** An SF Symbol charge, as the glyph symbols.ts draws for it, filled where the Mac's is. */
function symbolGlyph(name: string, cx: number, cy: number, point: number, color: string): string {
    const side = point * 1.2;
    const filled = name.endsWith(".fill");
    return `<svg x="${cx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" viewBox="0 0 24 24" fill="${filled ? color : "none"}" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" overflow="visible">${sfSymbolPaths(name)}</svg>`;
}

/** The figures arranged on the field (BrowserSpaceCrestChargeView). */
function charge(crest: SpaceCrest, size: number, color: string): string {
    const figure = resolvedCharge(crest);
    const c = size / 2;
    const cy = c + size * crest.chargeOffset;
    const point = (base: number): number => size * base * crest.chargeScale;
    const at = (x: number, y: number, base: number): string => glyph(figure, x, y, point(base), crest.chargeWeight, color);
    // A figure's frame is its artwork's: 1.25 of its point size.
    const frame = (base: number): number => point(base) * 1.25;
    switch (crest.chargeLayout) {
        case "Single":
            return at(c, cy, 0.31);
        case "Paired": {
            const offset = (frame(0.22) + size * 0.07) / 2;
            return at(c - offset, cy, 0.22) + at(c + offset, cy, 0.22);
        }
        case "Trio": {
            const f = frame(0.18);
            const row = (f - size * 0.03) / 2;
            const offset = (f + size * 0.07) / 2;
            return at(c, cy - row, 0.18) + at(c - offset, cy + row, 0.18) + at(c + offset, cy + row, 0.18);
        }
        case "Quad": {
            const f = frame(0.17);
            const row = (f + size * 0.02) / 2;
            const offset = (f + size * 0.08) / 2;
            return [-1, 1].flatMap((dy) => [-1, 1].map((dx) => at(c + dx * offset, cy + dy * row, 0.17))).join("");
        }
        case "Ring": {
            let figures = "";
            for (let index = 0; index < 5; index++) {
                const angle = (index / 5) * 2 * Math.PI - Math.PI / 2;
                figures += at(c + Math.cos(angle) * size * 0.2, cy + Math.sin(angle) * size * 0.2, 0.13);
            }
            return figures;
        }
    }
}

// MARK: - Crest

/** The SVG of `branding`'s crest at `size` CSS pixels (BrowserSpaceCrestIcon). */
export function crestSVG(branding: SpaceBranding, size: number): string {
    const crest = branding.crest;
    const colors = layerColors(crest, branding);
    const color = (index: number): string => rgb(colors[index] ?? colors[0]!);
    const side = size * plateFraction * crest.plateScale;
    const plateRect = { x: (size - side) / 2, y: (size - side) / 2, width: side, height: side };
    const plate = plateD(crest.backplate, plateRect, crest.sealTeeth);
    const id = `crest-${nextId++}`;
    let defs = "";
    let body = "";
    if (crest.backplate !== "None") {
        defs += `<clipPath id="${id}-plate"><path d="${plate}"/></clipPath>`;
        const finish = finishFill(crest, plateRect, `${id}-finish`);
        if (finish) defs += finish.defs;
        const division = divisionD(crest.fieldDivision, crest.divisionCount, plateRect);
        body += `<g clip-path="url(#${id}-plate)">`;
        body += `<path d="${box(plateRect.x, plateRect.y, side, side)}" fill="${color(crest.backplateColorIndex)}"/>`;
        if (division) body += `<path d="${division}" fill="${color(crest.secondaryFieldColorIndex)}"/>`;
        if (finish) body += `<path d="${box(plateRect.x, plateRect.y, side, side)}" fill="${finish.fill}"/>`;
        const ordinaryColor = color(crest.ordinaryColorIndex);
        body +=
            crest.ordinary === "Bordure"
                ? `<path d="${plate}" fill="none" stroke="${ordinaryColor}" stroke-width="${side * 0.09 * crest.ordinaryWidth * 2}"/>`
                : ordinary(crest, plateRect, ordinaryColor);
        if (crest.edgeWidth > 0) {
            body += `<path d="${plate}" fill="none" stroke="${color(crest.edgeColorIndex)}" stroke-width="${Math.max(0.75, side * 0.06 * crest.edgeWidth)}" stroke-linejoin="round"/>`;
        }
        body += "</g>";
        if (crest.showsOutline) {
            body += `<path d="${plate}" fill="none" stroke="${color(crest.edgeColorIndex)}" stroke-width="${Math.max(0.6, size * 0.012)}"/>`;
        }
    }
    body += trim(crest, plateRect, size, color(crest.trimColorIndex));
    body += charge(crest, size, color(crest.symbolColorIndex));
    const shadow = {
        None: "",
        Soft: `filter: drop-shadow(0 ${size * 0.02}px ${size * 0.04}px rgb(0 0 0 / 0.28));`,
        Lifted: `filter: drop-shadow(0 ${size * 0.06}px ${size * 0.1}px rgb(0 0 0 / 0.36));`,
    }[crest.depth];
    return `<svg class="crest" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" overflow="visible" aria-hidden="true" style="${shadow}"><defs>${defs}</defs>${body}</svg>`;
}

/**
 * A Space's icon at `size` (BrowserSpaceIdentityIcon): its crest when its look
 * wears one, else its emoji, or its symbol in the look's symbol colour.
 */
export function spaceIcon(settings: SpaceSettings, size: number): HTMLElement {
    return identityIcon(settings.look, settings.symbol, size);
}

/** The icon a look and symbol make, as a Space or the editor's draft wears them. */
export function identityIcon(look: SpaceBranding, symbol: string, size: number): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "space-icon";
    icon.style.width = `${size}px`;
    icon.style.height = `${size}px`;
    if (look.iconStyle === "LayeredCrest") {
        icon.innerHTML = crestSVG(look, size);
        return icon;
    }
    const emoji = emojiOf(symbol);
    if (emoji) {
        icon.textContent = emoji;
        icon.style.fontSize = `${size * 0.68}px`;
        return icon;
    }
    const side = size * 0.56 * 1.2;
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="${side}" height="${side}" fill="${symbol.endsWith(".fill") ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${sfSymbolPaths(symbol)}</svg>`;
    icon.style.color = rgb(symbolColor(look));
    return icon;
}

// MARK: - Backdrop

/**
 * Whether text over a look's backdrop reads light or dark
 * (SpaceBranding.foregroundTone, ColorPalette+ForegroundTone): the tone its
 * text colour mode names, the device's when it follows the device, or else
 * the one whose weakest APCA contrast across the palette, drawn at the
 * look's strength over the window and under its readability fade, is the
 * strongest. `systemIsDark` is the device's appearance.
 */
export function foregroundTone(look: SpaceBranding, systemIsDark: boolean): "light" | "dark" {
    switch (look.textColorMode) {
        case "Light":
            return "light";
        case "Dark":
            return "dark";
        case "System":
            return systemIsDark ? "light" : "dark";
        case "Automatic":
            break;
    }
    const window = systemIsDark ? 0.12 : 0.93;
    const overlay = Math.min(look.readabilityFade * 0.55, 0.7);
    const strength = look.bannerStrength;
    const rendered = (channel: number): number => (channel * strength + window * (1 - strength)) * (1 - overlay);
    const luminance = (red: number, green: number, blue: number): number => {
        const value = 0.2126729 * red ** 2.4 + 0.7151522 * green ** 2.4 + 0.072175 * blue ** 2.4;
        return value < 0.022 ? value + (0.022 - value) ** 1.414 : value;
    };
    const contrast = (text: number, background: number): number => {
        if (Math.abs(background - text) < 0.0005) return 0;
        if (background > text) {
            const value = (background ** 0.56 - text ** 0.57) * 1.14;
            return value < 0.1 ? 0 : (value - 0.027) * 100;
        }
        const value = (background ** 0.65 - text ** 0.62) * 1.14;
        return value > -0.1 ? 0 : -(value + 0.027) * 100;
    };
    const colors = look.colors.colors.length > 0 ? look.colors.colors : [indigo];
    const backgrounds = colors.map((color) => luminance(rendered(color.red), rendered(color.green), rendered(color.blue)));
    const light = Math.min(...backgrounds.map((background) => contrast(luminance(1, 1, 1), background)));
    const dark = Math.min(...backgrounds.map((background) => contrast(luminance(0, 0, 0), background)));
    return light >= dark ? "light" : "dark";
}

/**
 * The backdrop a look paints behind the sidebar, `width` by `height`
 * (BrowserSpaceBannerBackground): its banner pattern or gradient at the
 * look's colour intensity, darkened by its readability fade, over the
 * window's background.
 */
export function bannerSVG(look: SpaceBranding, width: number, height: number): string {
    const colors = look.colors.colors.length > 0 ? look.colors.colors.map((color) => rgb(color)) : [rgb(indigo)];
    const first = colors[0]!;
    const second = colors[Math.min(1, colors.length - 1)]!;
    const third = colors[Math.min(2, colors.length - 1)]!;
    const id = `banner-${nextId++}`;
    const w = width;
    const h = height;
    let defs = "";
    let field = "";
    const rect = (x: number, y: number, rw: number, rh: number, fill: string, opacity = 1): string =>
        `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}/>`;
    const poly = (points: [number, number][], fill: string, opacity = 1): string =>
        `<path d="M${points.map(([x, y]) => `${x * w} ${y * h}`).join("L")}Z" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}/>`;
    if (look.themeMode === "Gradient") {
        const radians = (look.gradientAngle * Math.PI) / 180;
        const dx = Math.cos(radians) * 0.5;
        const dy = Math.sin(radians) * 0.5;
        const stops = colors.length === 1 ? [first, first] : colors;
        defs += `<linearGradient id="${id}" x1="${0.5 - dx}" y1="${0.5 - dy}" x2="${0.5 + dx}" y2="${0.5 + dy}">${stops
            .map((color, index) => `<stop offset="${index / (stops.length - 1)}" stop-color="${color}"/>`)
            .join("")}</linearGradient>`;
        field = rect(0, 0, w, h, `url(#${id})`);
    } else {
        switch (look.bannerPattern) {
            case "Solid":
                field = rect(0, 0, w, h, first);
                break;
            case "Split":
                field = rect(0, 0, w / 2, h, first) + rect(w / 2, 0, w / 2, h, second);
                break;
            case "Bands":
                field = rect(0, 0, w, h / 3, first) + rect(0, h / 3, w, h / 3, second) + rect(0, (2 * h) / 3, w, h / 3, third);
                break;
            case "Diagonal":
                field =
                    rect(0, 0, w, h, first) +
                    poly([[0, 0.5], [1, 0.34], [1, 0.5], [0, 0.68]], second) +
                    poly([[0, 0.68], [1, 0.5], [1, 1], [0, 1]], third);
                break;
            case "Chevron":
                field =
                    rect(0, 0, w, h, first) +
                    poly([[0, 0.42], [0.5, 0.58], [1, 0.42], [1, 0.62], [0.5, 0.78], [0, 0.62]], second) +
                    poly([[0, 0.62], [0.5, 0.78], [1, 0.62], [1, 1], [0, 1]], third);
                break;
            case "Quartered":
                field =
                    rect(0, 0, w / 2, h / 2, first) +
                    rect(w / 2, 0, w / 2, h / 2, second) +
                    rect(0, h / 2, w / 2, h / 2, third) +
                    rect(w / 2, h / 2, w / 2, h / 2, first);
                break;
            case "Stripes":
            case "Checkered":
            case "Lozenges": {
                field = rect(0, 0, w, h, first);
                const cell = Math.max(16, w / 5);
                const rows = Math.min(200, Math.ceil(h / cell) + 1);
                const columns = Math.min(200, Math.ceil(w / cell) + 1);
                for (let row = 0; row < rows; row++) {
                    for (let column = 0; column < columns; column++) {
                        const x = column * cell;
                        const y = row * cell;
                        if (look.bannerPattern === "Stripes" && column % 2 === 0) field += rect(x, y, cell, cell, second, 0.35);
                        else if (look.bannerPattern === "Checkered" && (row + column) % 2 === 0) field += rect(x, y, cell, cell, second, 0.35);
                        else if (look.bannerPattern === "Lozenges") {
                            const fill = (row + column) % 2 === 0 ? second : third;
                            field += `<path d="M${x + cell / 2} ${y}L${x + cell} ${y + cell / 2}L${x + cell / 2} ${y + cell}L${x} ${y + cell / 2}Z" fill="${fill}" fill-opacity="0.35"/>`;
                        }
                    }
                }
                break;
            }
        }
    }
    const fade = Math.min(look.readabilityFade * 0.55, 0.7);
    return `<svg class="banner" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><defs>${defs}</defs><rect width="${w}" height="${h}" fill="var(--crest-window-background, #ececec)"/><g opacity="${look.bannerStrength}">${field}</g>${fade > 0 ? `<rect width="${w}" height="${h}" fill="#000" fill-opacity="${fade}"/>` : ""}</svg>`;
}
