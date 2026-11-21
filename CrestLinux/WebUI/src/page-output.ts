// What a page puts out, as the Mac's BrowserPage does: printing it through
// Chromium's print preview, exporting it as a PDF or saving it as an archive
// through the save dialog, and capturing it, a part of it to the clipboard, the
// whole page to the clipboard or framed as a portrait to a file. The engine
// does the work (CapturePage, ExportPage) and answers later with PageCaptured
// and PageExported; the host prints, saves and copies (bridge.ts). A failure
// needs nothing from the person, so it is a notice rather than an alert.
//
// Every window hears every presentation, so each request carries an id this
// window made and only the answers to its own ids are taken.

import { copyImage, pageRequest, printPage, saveExport } from "./bridge.js";
import { PageExportFailure } from "../generated/crest_contracts.js";
import type { EnginePresentation, Guid, PageArea, PageExportFormat, PageLiveState, PageState } from "../generated/crest_contracts.js";
import { Notices, postNotice } from "./notices.js";

// MARK: - Types

/** What a capture or an export came to: its bytes, or why there are none. */
type Answer = { readonly bytes: Uint8Array } | { readonly failure: string };

/** An archive of a page's document and resources in the form its engine keeps, as the Mac's BrowserPageArchiveFormat. */
interface ArchiveFormat {
    readonly pathExtension: string;
    readonly exportFormat: PageExportFormat;
}

/** Chromium keeps its archives as MHTML, never as WebKit's web archives. */
const chromiumArchive: ArchiveFormat = { pathExtension: "mhtml", exportFormat: "Mhtml" };

/** How long a capture or an export may take before it is given up on. */
const answerTimeout = 60_000;
/** The width a portrait capture is taken at, in points (BrowserPage.savePortraitCapture). */
const portraitWidth = 720;

/**
 * The name a save dialog proposes for `live`'s document exported with
 * `pathExtension`: its title, else its host, else "Web Page", made safe for
 * a file name, as the Mac's PageLiveState.suggestedFilename.
 */
export function suggestedFilename(live: PageLiveState, pathExtension: string): string {
    const normalized = (value: string | null | undefined): string | null => {
        const trimmed = value?.trim() ?? "";
        return trimmed.length > 0 ? trimmed : null;
    };
    let host: string | null = null;
    try {
        host = live.url ? new URL(live.url).host : null;
    } catch {
        host = null;
    }
    const source = normalized(live.title) ?? normalized(host) ?? "Web Page";
    // eslint-disable-next-line no-control-regex
    let candidate = source.replace(/[\x00-\x1F\x7F/\\:*?"<>|]+/g, "-").split(/\s+/).filter(Boolean).join(" ").trim();
    while (candidate.endsWith(".")) candidate = candidate.slice(0, -1);
    const suffix = `.${pathExtension.toLowerCase()}`;
    if (candidate.toLowerCase().endsWith(suffix)) candidate = candidate.slice(0, -suffix.length);
    candidate = [...candidate].slice(0, 120).join("").trim();
    return `${candidate.length > 0 ? candidate : "Web Page"}.${pathExtension}`;
}

export class PageOutput {
    private readonly captures = new Map<Guid, (answer: Answer) => void>();
    private readonly exports = new Map<Guid, (answer: Answer) => void>();
    private readonly report: (error: unknown) => void;

    constructor(report: (error: unknown) => void) {
        this.report = report;
    }

    /** Takes the engine's answers to this window's captures and exports. */
    present(presentation: EnginePresentation): void {
        if (presentation.kind === "PageCaptured") {
            const { captureId, png } = presentation.value;
            this.captures.get(captureId)?.(png ? { bytes: png } : { failure: "The page showed nothing to capture." });
        } else if (presentation.kind === "PageExported") {
            const { exportId, document, failure } = presentation.value;
            const reason = failure ? PageExportFailure.facts[failure].message.text : PageExportFailure.facts.Failed.message.text;
            this.exports.get(exportId)?.(document ? { bytes: document } : { failure: reason });
        }
    }

    // MARK: - Actions - Engine requests

    /**
     * What the page `pageId` shows, all of it or `area` in its view's points,
     * `width` points wide or at its own size when 0, as a PNG; null when it
     * shows nothing to capture.
     */
    async capture(pageId: Guid, area: PageArea | null, width: number): Promise<Uint8Array | null> {
        const answer = await this.capturing(pageId, area, width);
        return "bytes" in answer ? answer.bytes : null;
    }

    private capturing(pageId: Guid, area: PageArea | null, width: number): Promise<Answer> {
        const captureId = crypto.randomUUID();
        return this.awaitAnswer(this.captures, captureId, () => pageRequest("CapturePage", { pageId, captureId, area, width }));
    }

    /** The page's document as `format`, a full-page image `width` points wide or at its own width when 0. */
    private exporting(pageId: Guid, format: PageExportFormat, width: number): Promise<Answer> {
        const exportId = crypto.randomUUID();
        return this.awaitAnswer(this.exports, exportId, () => pageRequest("ExportPage", { pageId, exportId, format, width }));
    }

    private awaitAnswer(waiting: Map<Guid, (answer: Answer) => void>, id: Guid, request: () => Promise<boolean>): Promise<Answer> {
        return new Promise<Answer>((resolve) => {
            const timer = window.setTimeout(() => finish({ failure: PageExportFailure.facts.TimedOut.message.text }), answerTimeout);
            const finish = (answer: Answer): void => {
                window.clearTimeout(timer);
                waiting.delete(id);
                resolve(answer);
            };
            waiting.set(id, finish);
            request().then(
                (accepted) => {
                    if (!accepted) finish({ failure: PageExportFailure.facts.Unsupported.message.text });
                },
                (error: unknown) => finish({ failure: String(error) }),
            );
        });
    }

    // MARK: - Actions - Printing and export

    /** Whether `page` has a document to print, export or capture. */
    static hasDocument(page: PageState | undefined): page is PageState {
        return page !== undefined && page.phase === "Live" && page.live.url !== null && !page.live.failure;
    }

    /** Prints the page through Chromium's print preview, over the page in the window. */
    print(page: PageState): void {
        printPage(page.id);
    }

    /** Exports the page as a PDF and saves it where the person chooses, as the Mac's exportPDF. */
    exportPDF(page: PageState): void {
        void this.saveDocument(page, "Pdf", "pdf", "Export Page as PDF", "The page couldn’t be exported.");
    }

    /** Saves the page's document and resources in the archive its engine keeps, as the Mac's exportWebArchive. */
    saveWebArchive(page: PageState): void {
        const format = chromiumArchive;
        void this.saveDocument(
            page,
            format.exportFormat,
            format.pathExtension,
            "Save Page as Web Archive",
            "The page couldn’t be saved as a web archive.",
        );
    }

    private async saveDocument(page: PageState, format: PageExportFormat, extension: string, title: string, failure: string): Promise<void> {
        const filename = suggestedFilename(page.live, extension);
        const answer = await this.exporting(page.id, format, 0);
        if ("failure" in answer) {
            postNotice(Notices.failure(`${failure} ${answer.failure}`));
            return;
        }
        try {
            const saved = await saveExport(title, filename, extension, answer.bytes);
            if (saved === "failed" || saved === "unavailable") postNotice(Notices.failure(`${failure} The file couldn’t be written.`));
        } catch (error) {
            this.report(error);
        }
    }

    // MARK: - Actions - Capture

    /** Copies the part of the page's view at `area`, in its points, as the Mac's captureRegion. */
    async copyRegion(pageId: Guid, area: PageArea): Promise<void> {
        const png = await this.capture(pageId, area, 0);
        const copied = png !== null && (await copyImage(png).catch(() => false));
        postNotice(copied ? Notices.captured("Capture Copied") : Notices.failure("Couldn’t Capture Page"));
    }

    /** Copies the whole page as an image, as the Mac's copyFullPageCapture. */
    async copyFullPageCapture(page: PageState): Promise<void> {
        const answer = await this.exporting(page.id, "Png", 0);
        const copied = "bytes" in answer && (await copyImage(answer.bytes).catch(() => false));
        postNotice(copied ? Notices.captured("Full Page Capture Copied") : Notices.failure("Couldn’t Capture Full Page"));
    }

    /**
     * Saves the whole page, 720 points wide, framed on a gradient with a soft
     * shadow, where the person chooses, as the Mac's savePortraitCapture.
     */
    async savePortraitCapture(page: PageState): Promise<void> {
        const filename = suggestedFilename(page.live, "png");
        try {
            const answer = await this.exporting(page.id, "Png", portraitWidth);
            if ("failure" in answer) throw new Error(answer.failure);
            const portrait = await portraitImage(answer.bytes);
            const saved = await saveExport("Save Portrait Capture", filename, "png", portrait);
            if (saved === "saved") postNotice(Notices.captured("Portrait Capture Saved"));
            else if (saved !== "cancelled") throw new Error(saved);
        } catch {
            postNotice(Notices.failure("Couldn’t Save Portrait Capture"));
        }
    }
}

/**
 * `snapshot` framed as the Mac's BrowserPage.portraitImage frames it: inset
 * 64 by 72 points on a diagonal gradient, under a soft shadow, with rounded
 * corners. The snapshot keeps its own pixels; the frame scales with them.
 */
async function portraitImage(snapshot: Uint8Array): Promise<Uint8Array> {
    const bitmap = await createImageBitmap(new Blob([snapshot as BlobPart], { type: "image/png" }));
    // The engine draws in device pixels; the frame is in points of a 720-point page.
    const scale = bitmap.width / portraitWidth;
    const horizontalInset = 64 * scale;
    const verticalInset = 72 * scale;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width + horizontalInset * 2);
    canvas.height = Math.round(bitmap.height + verticalInset * 2);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas to frame the capture on.");
    // NSGradient at -35°, from the top left down to the right.
    const angle = (35 * Math.PI) / 180;
    const half = (Math.abs(canvas.width * Math.cos(angle)) + Math.abs(canvas.height * Math.sin(angle))) / 2;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const gradient = context.createLinearGradient(
        centerX - Math.cos(angle) * half,
        centerY - Math.sin(angle) * half,
        centerX + Math.cos(angle) * half,
        centerY + Math.sin(angle) * half,
    );
    gradient.addColorStop(0, "rgb(41 51 87)");
    gradient.addColorStop(0.5, "rgb(122 64 133)");
    gradient.addColorStop(1, "rgb(36 138 158)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const x = horizontalInset;
    const y = verticalInset;
    context.save();
    context.shadowColor = "rgb(0 0 0 / 0.38)";
    context.shadowBlur = 30 * scale;
    context.shadowOffsetY = 14 * scale;
    context.fillStyle = "rgb(0 0 0 / 0.18)";
    context.beginPath();
    context.roundRect(x - 2 * scale, y - 2 * scale, bitmap.width + 4 * scale, bitmap.height + 4 * scale, 14 * scale);
    context.fill();
    context.restore();
    context.save();
    context.beginPath();
    context.roundRect(x, y, bitmap.width, bitmap.height, 12 * scale);
    context.clip();
    context.drawImage(bitmap, x, y);
    context.restore();
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The capture couldn’t be encoded.");
    return new Uint8Array(await blob.arrayBuffer());
}
