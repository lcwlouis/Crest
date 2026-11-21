// Notices, as the Mac's BrowserNotice: a transient message at the top of the
// window that asks nothing of the person, for a copy, a zoom change or an
// action that could not run. A newer notice replaces one still showing, and
// each leaves once it has been up as long as it lasts. Callers post one with
// `postNotice`, as the Mac's BrowserNoticeCenter takes them, and the window's
// notice layer shows it: over the page on the floating view, or in the
// WebUI itself while that is raised over the page.

import type { FloatEvent } from "./float.js";
import { measure, noticeCapsule, noticeShadowRoom, noticeTop } from "./page-layers.js";
import type { PageLayerState } from "./page-layers.js";
import { onOverlayChange, overlayHeld } from "./overlay.js";
import { FloatRank } from "./surfaces.js";
import type { FloatSurface, FloatSurfaces } from "./surfaces.js";

// MARK: - Types

export interface Notice {
    readonly message: string;
    /** An SF Symbol name. */
    readonly symbol: string;
    /** What a screen reader says, when the words alone leave out what they report. */
    readonly label: string | null;
}

type NoticeState = Extract<PageLayerState, { kind: "notice" }>;

/** BrowserRootMetrics: how long a notice lasts, and how long it takes to leave. */
const shortest = 1400;
const longest = 6000;
const leaving = 180;

export const Notices = {
    urlCopied: { message: "URL Copied", symbol: "checkmark.circle.fill", label: null } satisfies Notice,
    copied: { message: "Copied", symbol: "checkmark.circle.fill", label: null } satisfies Notice,
    /** The page's zoom, as `label` names it, such as "125%". */
    pageZoom: (label: string): Notice => ({ message: label, symbol: "textformat.size", label: `Page zoom ${label}` }),
    /** A capture of a page that was copied or saved, as `message` says. */
    captured: (message: string): Notice => ({ message, symbol: "checkmark.circle.fill", label: null }),
    /** An action that could not run, with `reason` saying why. */
    failure: (reason: string): Notice => ({ message: reason, symbol: "exclamationmark.triangle.fill", label: null }),
} as const;

/** Long enough to read: short confirmations leave quickly, sentences stay. */
function duration(notice: Notice): number {
    return Math.min(Math.max(shortest, notice.message.length * 60), longest);
}

let receiver: NoticeLayer | null = null;

/** Shows `notice` at the top of the window. */
export function postNotice(notice: Notice): void {
    receiver?.show(notice);
}

/** The window's notices. */
export class NoticeLayer implements FloatSurface {
    readonly rank = FloatRank.notice;
    readonly exclusive = false;
    private readonly surfaces: FloatSurfaces;
    /** Where the WebUI draws the notice while it is raised over the page. */
    private readonly inPage: HTMLElement;
    private shown: NoticeState | null = null;
    private revision = 0;

    constructor(surfaces: FloatSurfaces) {
        this.surfaces = surfaces;
        surfaces.add(this);
        this.inPage = document.createElement("div");
        this.inPage.id = "notice";
        this.inPage.className = "notice-layer";
        this.inPage.hidden = true;
        document.body.append(this.inPage);
        receiver = this;
        onOverlayChange(() => this.place());
        window.addEventListener("resize", () => this.place());
    }

    /** Shows `notice`, replacing any notice already showing, for as long as it lasts. */
    show(notice: Notice): void {
        const revision = ++this.revision;
        this.shown = { kind: "notice", id: revision, ...notice, leaving: false };
        this.place();
        setTimeout(() => {
            if (this.revision !== revision || !this.shown) return;
            this.shown = { ...this.shown, leaving: true };
            this.place();
            setTimeout(() => {
                if (this.revision !== revision) return;
                this.shown = null;
                this.place();
            }, leaving);
        }, duration(notice));
    }

    restore(): void {
        this.place();
    }

    handle(_event: FloatEvent): void {}

    private place(): void {
        const state = this.shown;
        if (!state || overlayHeld()) {
            this.surfaces.post(this, null);
            this.drawInPage(state);
            return;
        }
        this.drawInPage(null);
        const size = measure(noticeCapsule(state));
        this.surfaces.post(this, {
            bounds: {
                x: (window.innerWidth - size.width) / 2 - noticeShadowRoom,
                y: 0,
                width: size.width + 2 * noticeShadowRoom,
                height: noticeTop + size.height + noticeShadowRoom,
            },
            focus: false,
            state,
            band: "top",
        });
    }

    private drawInPage(state: NoticeState | null): void {
        this.inPage.hidden = !state;
        if (!state) {
            this.inPage.replaceChildren();
            return;
        }
        const capsule = this.inPage.firstElementChild;
        if (capsule && this.inPage.dataset.id === String(state.id)) {
            capsule.classList.toggle("leaving", state.leaving);
            return;
        }
        this.inPage.dataset.id = String(state.id);
        this.inPage.replaceChildren(noticeCapsule(state));
    }
}
