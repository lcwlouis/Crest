// The rows of the sidebar's utility lists, as the Mac's BrowserUtilityListRow
// draws them: an archived tab to restore, a history entry to open, and a
// download with its status, progress and actions. Each item says when it
// happened, whether a search finds it, and draws its own row; what a row
// does goes back to the lists through `UtilityRowHost`.

import {
    ArchiveReason,
    dateFromWire,
    DownloadFailure,
    DownloadPhase,
    DownloadRowAction,
} from "../generated/crest_contracts.js";
import type { ArchivedTabState, DownloadState, Guid, HistoryEntryState } from "../generated/crest_contracts.js";
import type { MenuEntry, MenuPlacement } from "./menu.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

/** What a row asks of the lists it sits in. */
export interface UtilityRowHost {
    /** The image a tab wears, as a data URL, or null. */
    readonly imageOf: (tabId: Guid) => string | null;
    readonly restoreArchivedTab: (tabId: Guid) => void;
    readonly openHistoryEntry: (entry: HistoryEntryState) => void;
    readonly performDownloadAction: (action: DownloadAction, download: DownloadState) => void;
    readonly openMenu: (entries: readonly MenuEntry[], placement: MenuPlacement) => void;
}

/** One item a utility list shows. */
export interface UtilityItem {
    readonly id: string;
    /** When it happened: archived, last visited or started. */
    readonly date: Date;
    /** Whether a search for `query` finds it; an empty search finds every item. */
    matches(query: string): boolean;
    row(host: UtilityRowHost): HTMLElement;
}

/**
 * Where a finished download goes from its row, as the Mac's
 * BrowserUtilityDownloadDestination: the file itself, or its folder. Picking
 * the row of a finished download shows it in its folder.
 */
export interface DownloadDestination {
    readonly name: "open" | "showInFolder";
    readonly title: string;
    readonly symbol: string;
    readonly isPrimaryWhenFinished: boolean;
}

export const downloadDestinations: readonly DownloadDestination[] = [
    { name: "open", title: "Open", symbol: "arrow.up.forward.square", isPrimaryWhenFinished: false },
    { name: "showInFolder", title: "Show in Folder", symbol: "magnifyingglass", isPrimaryWhenFinished: true },
];

/** What a person asked of one download row. */
export type DownloadAction =
    | { readonly kind: "open"; readonly destination: DownloadDestination }
    | { readonly kind: "retry" | "pause" | "resume" | "cancel" | "clear" };

/** What each of the core's row actions asks for; Open offers the destinations instead. */
const rowRequests: Readonly<Record<DownloadRowAction, DownloadAction | null>> = {
    Retry: { kind: "retry" },
    Cancel: { kind: "cancel" },
    Open: null,
    Remove: { kind: "clear" },
    Pause: { kind: "pause" },
    Resume: { kind: "resume" },
};

/** The platform colour each of the core's tints names, as SystemTint+Color. */
const tintColors: Readonly<Record<string, string>> = {
    Red: "var(--tint-red)",
    Orange: "var(--tint-orange)",
    Purple: "var(--tint-purple)",
    Blue: "var(--tint-blue)",
    Indigo: "var(--tint-indigo)",
    Teal: "var(--tint-teal)",
    Pink: "var(--tint-pink)",
    Green: "var(--tint-green)",
};

/** What a downloaded file is, by its extension, as the Mac's BrowserDownloadFileKind. */
const fileKinds: readonly { readonly symbol: string; readonly extensions: readonly string[] }[] = [
    { symbol: "photo.fill", extensions: ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "tiff", "svg"] },
    { symbol: "doc.richtext.fill", extensions: ["pdf"] },
    { symbol: "archivebox.fill", extensions: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"] },
    { symbol: "waveform", extensions: ["mp3", "m4a", "aac", "wav", "aiff", "flac", "ogg"] },
    { symbol: "film.fill", extensions: ["mov", "mp4", "m4v", "avi", "mkv", "webm"] },
    { symbol: "doc.text.fill", extensions: ["txt", "md", "rtf", "doc", "docx", "pages", "csv"] },
    { symbol: "externaldrive.fill", extensions: ["dmg", "iso", "pkg"] },
];

export function fileKindSymbol(filename: string): string {
    const dot = filename.lastIndexOf(".");
    const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
    return fileKinds.find((kind) => kind.extensions.includes(extension))?.symbol ?? "doc.fill";
}

// MARK: - Formatting

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function glyph(name: string, size = 16): HTMLElement {
    const slot = element("span", "utility-glyph");
    slot.innerHTML = sfSymbol(name, size);
    return slot;
}

/** A byte count as macOS's file style writes it: decimal units, KB whole, MB to one place, larger to two. */
export function byteCount(bytes: bigint | number): string {
    const value = Number(bytes);
    if (value === 0) return "Zero KB";
    if (value < 1000) return `${value} ${value === 1 ? "byte" : "bytes"}`;
    const units = [
        { unit: "KB", scale: 1e3, places: 0 },
        { unit: "MB", scale: 1e6, places: 1 },
        { unit: "GB", scale: 1e9, places: 2 },
        { unit: "TB", scale: 1e12, places: 2 },
    ];
    let chosen = units[0]!;
    for (const unit of units) if (value >= unit.scale) chosen = unit;
    const scaled = value / chosen.scale;
    const text = scaled.toFixed(chosen.places).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    return `${text} ${chosen.unit}`;
}

/** A time left as Duration's abbreviated units write it, at most two of hours, minutes and seconds. */
export function timeLeft(seconds: number): string {
    let rest = Math.max(0, Math.round(seconds));
    const parts: string[] = [];
    const hours = Math.floor(rest / 3600);
    rest -= hours * 3600;
    const minutes = Math.floor(rest / 60);
    rest -= minutes * 60;
    if (hours > 0) parts.push(`${hours} hr`);
    if (minutes > 0) parts.push(`${minutes} min`);
    if (rest > 0 || parts.length === 0) parts.push(`${rest} sec`);
    return parts.slice(0, 2).join(", ");
}

function percent(fraction: number): string {
    return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

function hostOf(address: string | null): string | null {
    if (!address) return null;
    try {
        return new URL(address).host || null;
    } catch {
        return null;
    }
}

/** A tab's image, its emoji, or its title's first letter, as the sidebar's rows draw it. */
function tabIcon(image: string | null, symbol: string, title: string): HTMLElement {
    const icon = element("span", "favicon");
    if (image) {
        const img = element("img", "");
        img.src = image;
        img.alt = "";
        icon.append(img);
    } else if (/\p{Extended_Pictographic}/u.test(symbol)) {
        icon.textContent = symbol;
    } else {
        icon.classList.add("letter");
        icon.textContent = (title || "?").slice(0, 1).toUpperCase();
    }
    return icon;
}

/** The row's label: an icon, a title and a caption under it, and what trails it. */
function label(icon: HTMLElement, title: string, subtitle: HTMLElement, trailing?: HTMLElement): HTMLElement[] {
    const slot = element("span", "utility-icon");
    slot.append(icon);
    const text = element("span", "utility-text");
    text.append(element("span", "utility-title", title), subtitle);
    return trailing ? [slot, text, trailing] : [slot, text];
}

// MARK: - Archive

export class ArchiveItem implements UtilityItem {
    readonly id: string;
    readonly date: Date;
    readonly entry: ArchivedTabState;

    constructor(entry: ArchivedTabState) {
        this.entry = entry;
        this.id = `archive:${entry.tab.id}`;
        this.date = dateFromWire(entry.archivedAt);
    }

    private get title(): string {
        return this.entry.tab.displayTitle || this.entry.tab.url || "New Tab";
    }

    matches(query: string): boolean {
        return contains(this.title, query) || contains(this.entry.tab.url ?? "", query);
    }

    row(host: UtilityRowHost): HTMLElement {
        const { tab, reason } = this.entry;
        const facts = ArchiveReason.facts[reason];
        const subtitle = element("span", "utility-subtitle");
        subtitle.style.color = tintColors[facts.tint] ?? "";
        subtitle.append(glyph(facts.symbol, 11), document.createTextNode(` ${facts.title.text}`));
        const host_ = hostOf(tab.url);
        if (host_) subtitle.append(document.createTextNode(` · ${host_}`));
        const row = element("button", "utility-row");
        row.append(...label(tabIcon(host.imageOf(tab.id), tab.symbol, this.title), this.title, subtitle, glyph("arrow.uturn.backward")));
        row.lastElementChild!.classList.add("utility-trailing");
        row.setAttribute("aria-label", `Restore ${this.title}`);
        row.addEventListener("click", () => host.restoreArchivedTab(tab.id));
        return row;
    }
}

// MARK: - History

export class HistoryItem implements UtilityItem {
    readonly id: string;
    readonly date: Date;
    readonly entry: HistoryEntryState;

    constructor(entry: HistoryEntryState) {
        this.entry = entry;
        this.id = `history:${entry.id}`;
        this.date = dateFromWire(entry.lastVisitedAt);
    }

    matches(query: string): boolean {
        return contains(this.entry.title, query) || contains(this.entry.url, query);
    }

    row(host: UtilityRowHost): HTMLElement {
        const entry = this.entry;
        const site = hostOf(entry.url) ?? entry.url;
        const visits = entry.visitCount > 1 ? ` · ${entry.visitCount} visits` : "";
        const row = element("button", "utility-row");
        const trailing = glyph("arrow.up.forward");
        trailing.classList.add("utility-trailing", "tertiary");
        row.append(...label(glyph("globe", 18), entry.title, element("span", "utility-subtitle", site + visits), trailing));
        row.setAttribute("aria-label", `Open ${entry.title}`);
        row.title = entry.url;
        row.addEventListener("click", () => host.openHistoryEntry(entry));
        return row;
    }
}

// MARK: - Downloads

/** What a download row shows of its transfer, as the Mac's BrowserDownloadRowPresentation. */
interface DownloadPresentation {
    readonly bytesReceived: bigint;
    readonly totalBytes: bigint | null;
    readonly progress: number;
    readonly bytesPerSecond: number | null;
    readonly estimatedTimeRemaining: number | null;
    readonly status: string;
    readonly needsAttention: boolean;
    readonly showsTransferMetrics: boolean;
    readonly showsStatusAlongsideMetrics: boolean;
}

/** The phase's title, else why the download stopped, else its own message. */
export function downloadStatus(download: DownloadState): string {
    const title = DownloadPhase.facts[download.phase].title;
    if (title) return title.text;
    if (download.failure) return DownloadFailure.facts[download.failure].message.text;
    return download.message ?? "";
}

function present(download: DownloadState): DownloadPresentation {
    const phase = DownloadPhase.facts[download.phase];
    const telemetry = download.telemetry;
    const active = phase.isTransferring && !telemetry.isPaused;
    const showsTransferMetrics = telemetry.bytesReceived > 0n || telemetry.totalBytes !== null || phase.isComplete;
    return {
        bytesReceived: telemetry.bytesReceived,
        totalBytes: telemetry.totalBytes,
        progress: download.progress,
        bytesPerSecond: active ? telemetry.bytesPerSecond : null,
        estimatedTimeRemaining: active ? telemetry.estimatedTimeRemaining : null,
        status: phase.isTransferring && telemetry.isPaused ? "Paused" : downloadStatus(download),
        needsAttention: phase.needsAttention,
        showsTransferMetrics,
        showsStatusAlongsideMetrics: showsTransferMetrics && !active,
    };
}

export class DownloadItem implements UtilityItem {
    readonly id: string;
    readonly date: Date;
    readonly download: DownloadState;

    constructor(download: DownloadState) {
        this.download = download;
        this.id = `download:${download.id}`;
        this.date = dateFromWire(download.createdAt);
    }

    matches(query: string): boolean {
        return contains(this.download.filename, query) || contains(downloadStatus(this.download), query);
    }

    row(host: UtilityRowHost): HTMLElement {
        const download = this.download;
        const phase = DownloadPhase.facts[download.phase];
        const row = element("div", "utility-row download");
        const primary = phase.isComplete ? downloadDestinations.find((destination) => destination.isPrimaryWhenFinished) : undefined;
        const body = element(primary ? "button" : "div", "download-body");
        body.append(...label(this.statusIcon(), download.filename, this.details()));
        if (primary) {
            body.setAttribute("aria-label", primary.title);
            body.addEventListener("click", () => host.performDownloadAction({ kind: "open", destination: primary }, download));
        }
        row.append(body);
        const action = (rowAction: DownloadRowAction): void => {
            const request = rowRequests[rowAction];
            if (request) row.append(this.actionButton(rowAction, () => host.performDownloadAction(request, download)));
        };
        // The engine's capabilities offer pause or recovery beside the phase's own action.
        if (download.canPause) action("Pause");
        else if (download.canResume) action("Resume");
        if (rowRequests[phase.primaryAction]) {
            action(phase.primaryAction);
        } else {
            const facts = DownloadRowAction.facts[phase.primaryAction];
            const button = this.actionButton(phase.primaryAction, () => {
                const box = button.getBoundingClientRect();
                host.openMenu(
                    downloadDestinations.map((destination) => ({
                        title: destination.title,
                        icon: { kind: "symbol", name: destination.symbol },
                        action: () => host.performDownloadAction({ kind: "open", destination }, download),
                    })),
                    { anchor: box },
                );
            });
            button.setAttribute("aria-haspopup", "menu");
            button.title = facts.title.text;
            row.append(button);
        }
        return row;
    }

    private actionButton(action: DownloadRowAction, perform: () => void): HTMLButtonElement {
        const facts = DownloadRowAction.facts[action];
        const button = element("button", facts.isDestructive ? "utility-action destructive" : "utility-action");
        button.innerHTML = sfSymbol(facts.symbol, 15);
        button.title = facts.title.text;
        button.setAttribute("aria-label", facts.title.text);
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            perform();
        });
        return button;
    }

    /** The phase's symbol in its tone, a ring of progress round the file's kind, a spinner, or the file's kind. */
    private statusIcon(): HTMLElement {
        const download = this.download;
        const phase = DownloadPhase.facts[download.phase];
        const icon = element("span", "download-status");
        if (phase.symbol) {
            icon.innerHTML = sfSymbol(phase.symbol, 19);
            if (phase.awaitsDecision) icon.classList.add("warning");
            else if (phase.needsAttention) icon.classList.add("danger");
        } else if (phase.isTransferring) {
            const fraction = Math.max(download.progress, 0.02);
            const circumference = 2 * Math.PI * 11;
            icon.classList.add("progress");
            icon.innerHTML =
                `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">` +
                `<circle cx="12" cy="12" r="11" class="track"/>` +
                `<circle cx="12" cy="12" r="11" class="value" stroke-dasharray="${fraction * circumference} ${circumference}"/></svg>` +
                sfSymbol(fileKindSymbol(download.filename), 11);
            icon.setAttribute("role", "progressbar");
            icon.setAttribute("aria-label", "Download Progress");
            icon.setAttribute("aria-valuenow", String(Math.round(download.progress * 100)));
        } else if (phase.isLive) {
            icon.classList.add("spinner");
        } else {
            icon.innerHTML = sfSymbol(fileKindSymbol(download.filename), 19);
        }
        return icon;
    }

    /**
     * The transfer and the status under the filename: on one line when the
     * row is wide enough and nothing needs attention, else stacked.
     */
    private details(): HTMLElement {
        const shown = present(this.download);
        const details = element("span", "download-details");
        const status = (): HTMLElement => {
            const line = element("span", "download-line", shown.status);
            if (shown.needsAttention) line.classList.add("danger");
            return line;
        };
        const primary = (): HTMLElement => {
            if (!shown.showsTransferMetrics) return status();
            if (shown.totalBytes === null) return element("span", "download-line", `${byteCount(shown.bytesReceived)} downloaded`);
            return element(
                "span",
                "download-line",
                `${byteCount(shown.bytesReceived)} of ${byteCount(shown.totalBytes)} · ${percent(shown.progress)}`,
            );
        };
        const secondary = (): HTMLElement => {
            const rate = shown.bytesPerSecond !== null ? `${byteCount(Math.round(shown.bytesPerSecond))}/s` : null;
            const left = shown.estimatedTimeRemaining !== null ? `${timeLeft(shown.estimatedTimeRemaining)} remaining` : null;
            const text = [rate, left].filter((part) => part !== null).join(" · ");
            return text ? element("span", "download-line", text) : status();
        };
        const hasSecondary = shown.bytesPerSecond !== null || shown.estimatedTimeRemaining !== null || shown.showsStatusAlongsideMetrics;
        if (!hasSecondary) {
            details.append(primary());
        } else {
            // utilities.css lays an adaptive one out on one line from the
            // Mac's BrowserDownloadRowPresentation.inlineMinimumWidth (360).
            details.classList.add(shown.needsAttention ? "stacked" : "adaptive");
            details.append(primary(), element("span", "download-separator", "·"), secondary());
        }
        return details;
    }
}

/** Whether `text` holds `query`, ignoring case and accents, as localizedStandardContains. */
function contains(text: string, query: string): boolean {
    if (!query) return true;
    const fold = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    return fold(text).includes(fold(query));
}
