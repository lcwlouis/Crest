// Where each download's file goes, as the Mac's BrowserDownloadPrompts and
// BrowserPlatformDownloadDirectory answer the core's DownloadDestinationAsked:
// the person's Downloads folder, under a name no file there has yet, or the
// place they choose in a save dialog when the engine asks for one (Save Link
// As, a name the engine could not use). The window finds the place, since
// only it can look at the disk and show the dialog; the answer goes back to
// the core, which hands it to the engine. A cancelled dialog cancels the
// download; a folder that is unavailable fails it, as on the Mac.
//
// TODO(linux): a Space's own download folder and its "ask where to save"
// choice, once Linux draws the Space settings that set them.

import type { Change, DownloadDestinationAsked, Guid, Intent } from "../generated/crest_contracts.js";
import { chooseDownloadPath } from "./bridge.js";

export class DownloadDestinations {
    private readonly send: (intent: Intent) => Promise<unknown>;
    /** Questions heard but not yet taken up, so ones a later batch settles are never asked. */
    private readonly waiting = new Map<Guid, DownloadDestinationAsked>();

    constructor(send: (intent: Intent) => Promise<unknown>) {
        this.send = send;
    }

    /**
     * Takes up the core's questions. Each waits for the batches the window
     * replays as it starts, so one the core already settled is not asked again.
     */
    apply(changes: readonly Change[]): void {
        let asked = false;
        for (const change of changes) {
            if (change.kind === "DownloadDestinationAsked") {
                this.waiting.set(change.value.promptId, change.value);
                asked = true;
            } else if (change.kind === "PromptSettled") {
                this.waiting.delete(change.value.promptId);
            }
        }
        if (!asked) return;
        setTimeout(() => {
            const questions = [...this.waiting.values()];
            this.waiting.clear();
            for (const question of questions) void this.choose(question);
        });
    }

    private async choose(asked: DownloadDestinationAsked): Promise<void> {
        let answer: { readonly path: string | null; readonly unavailable: boolean };
        try {
            answer = await chooseDownloadPath(safeFilename(asked.suggestedFilename), asked.forcesPrompt);
        } catch (error) {
            console.error(error);
            answer = { path: null, unavailable: true };
        }
        if (answer.unavailable) {
            await this.send({ kind: "FailDownload", value: { downloadId: asked.downloadId, reason: "FolderUnavailable", message: null } });
        }
        // An answer to a question the core no longer waits on changes nothing.
        await this.send({ kind: "AnswerDownloadDestination", value: { promptId: asked.promptId, path: answer.path } });
    }
}

/** The longest name a download gets, in UTF-8 bytes, as BrowserDownloadDestination's. */
const maximumFilenameBytes = 240;
const utf8 = new TextEncoder();

/** Controls and the marks that turn text's direction, which make a name read other than it is. */
function isDeceptiveOrControl(code: number): boolean {
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x061c || (code >= 0x200b && code <= 0x200f)
        || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

/**
 * A name the site suggested, made safe to save under, as the Mac's
 * BrowserDownloadDestination.safeFilename: its last part only, without
 * controls or direction marks, trimmed of spaces and dots, and short enough
 * for the disk, keeping its extension.
 */
export function safeFilename(suggested: string): string {
    const last = suggested.replaceAll("\\", "/").split("/").filter((part) => part !== "").pop() ?? "";
    let cleaned = "";
    for (const character of last.normalize("NFC")) {
        if (isDeceptiveOrControl(character.codePointAt(0) ?? 0)) continue;
        cleaned += character === ":" ? "_" : character;
    }
    cleaned = cleaned.replace(/^[\s.]+|[\s.]+$/gu, "");
    if (cleaned === "") return "download";
    if (utf8.encode(cleaned).length <= maximumFilenameBytes) return cleaned;
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 ? cleaned.slice(dot) : "";
    const kept = utf8.encode(extension).length <= 32 ? extension : "";
    const stem = kept ? cleaned.slice(0, dot) : cleaned;
    const room = maximumFilenameBytes - utf8.encode(kept).length;
    let result = "";
    for (const character of stem) {
        if (utf8.encode(result + character).length > room) break;
        result += character;
    }
    return (result.trim() || "download") + kept;
}
