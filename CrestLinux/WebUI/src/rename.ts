// Naming a tab or folder in place, as the Mac's sidebar rows do: the row's
// title becomes a field holding the shown title, Enter or leaving the field
// keeps the name (RenameTab, RenameFolder), Escape keeps the old one.
//
// The sidebar draws its rows again on every change, so the one field lives
// here and the row that is being named takes it in place of its title.

import type { Guid } from "../generated/crest_contracts.js";
import { holdOverlay } from "./overlay.js";

export type RenameSubject = { readonly kind: "tab" | "folder"; readonly id: Guid };

export class InlineRename {
    readonly field = document.createElement("input");
    private subject: RenameSubject | null = null;
    private commit: ((title: string) => void) | null = null;
    /** Set while the sidebar moves the field to a row it drew again. */
    private moving = false;
    /** Whether a row took the field yet: a new folder's row draws once the core adds it. */
    private placed = false;

    private readonly redraw: () => void;
    private releaseOverlay: (() => void) | null = null;

    constructor(redraw: () => void) {
        this.redraw = redraw;
        this.field.className = "rename-field";
        this.field.spellcheck = false;
        this.field.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") this.finish(true);
            else if (event.key === "Escape") this.finish(false);
        });
        this.field.addEventListener("blur", () => {
            if (!this.moving) this.finish(true);
        });
        // A click in the field stays in the field rather than opening the row.
        for (const type of ["click", "mousedown", "dblclick", "auxclick"]) {
            this.field.addEventListener(type, (event) => event.stopPropagation());
        }
    }

    /** Starts naming `subject`, whose shown title is `title`; `commit` keeps the name. */
    begin(subject: RenameSubject, title: string, commit: (title: string) => void): void {
        if (this.subject) this.finish(true);
        this.subject = subject;
        this.commit = commit;
        // The field holds the overlay so the window keeps the keyboard on the
        // WebUI while it is named, rather than handing it back to the page.
        this.releaseOverlay = holdOverlay();
        this.field.value = title;
        this.field.setAttribute("aria-label", subject.kind === "tab" ? "Tab Name" : "Folder Name");
        this.placed = false;
        this.redraw();
    }

    isNaming(kind: RenameSubject["kind"], id: Guid): boolean {
        return this.subject?.kind === kind && this.subject.id === id;
    }

    /**
     * Runs the sidebar's redraw without counting the field's moment out of the
     * page as leaving it, and gives it its focus and selection back.
     */
    whileRedrawing(draw: () => void): void {
        const focused = document.activeElement === this.field;
        const start = this.field.selectionStart;
        const end = this.field.selectionEnd;
        this.moving = true;
        try {
            draw();
        } finally {
            this.moving = false;
        }
        if (!this.subject) return;
        if (!this.field.isConnected) {
            // The row went away, as when its tab closed: nothing is named.
            if (this.placed) {
                this.subject = null;
                this.commit = null;
                this.release();
            }
            return;
        }
        if (!this.placed) {
            this.placed = true;
            this.field.focus();
            this.field.select();
        } else if (focused) {
            this.field.focus({ preventScroll: true });
            this.field.setSelectionRange(start, end);
        }
    }

    private finish(keeps: boolean): void {
        const commit = this.commit;
        if (!this.subject) return;
        this.subject = null;
        this.commit = null;
        this.release();
        if (keeps) commit?.(this.field.value);
        this.field.remove();
        this.redraw();
    }

    private release(): void {
        this.releaseOverlay?.();
        this.releaseOverlay = null;
    }
}
