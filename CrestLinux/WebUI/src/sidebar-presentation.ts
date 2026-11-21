// Where the window's sidebar is, as the Mac's BrowserSidebarPresentation
// names the places: docked beside the page, put away (collapsed) so the page
// takes the whole window, or floating over the page as a card while the
// pointer brings it back from the window's leading edge. The sidebar's toggle
// (Show or Hide Sidebar) docks a floating or collapsed sidebar and puts a
// docked one away.
//
// A collapsed sidebar comes back as the Mac's
// BrowserCollapsedSidebarHoverTrackingView brings it: the pointer moves onto
// the strip at the leading edge and stays there for the reveal delay. On
// Linux the page's own view covers the window beside that strip, so only the
// gutter left of the page's card answers. The floating card goes away again
// once the pointer leaves it by more than its exit margin.
//
// Where the sidebar is stays with the window while it is open.
// TODO(linux): keep it with the window's frame across launches, as the
// Mac's BrowserWindowLayouts keeps sidebarIsPresented.

import { holdOverlay, overlayHolders } from "./overlay.js";

// MARK: - Types

type Place = "docked" | "floating" | "collapsed";

// MARK: - Constants

/** BrowserSidebarPresentation.floating.exitMargin. */
const exitMargin = 30;

const sidebarGlyph =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>';

export class SidebarPresentation {
    /** The sidebar's toggle, which leads the Space switcher strip. */
    readonly toggleButton: HTMLButtonElement;
    private readonly root: HTMLElement;
    private readonly strip: HTMLElement;
    private place: Place = "docked";
    private revealTimer = 0;
    private releaseOverlay: (() => void) | null = null;

    constructor(root: HTMLElement) {
        this.root = root;
        this.toggleButton = document.createElement("button");
        this.toggleButton.className = "switcher-toggle";
        this.toggleButton.innerHTML = sidebarGlyph;
        this.toggleButton.addEventListener("click", () => this.toggle());
        this.strip = document.createElement("div");
        this.strip.className = "sidebar-reveal";
        this.strip.setAttribute("aria-hidden", "true");
        // Only a pointer that moves onto the strip reaches for the sidebar; one
        // left resting there as the sidebar went away has not.
        this.strip.addEventListener("pointermove", () => this.armReveal());
        this.strip.addEventListener("pointerleave", () => this.cancelReveal());
        document.body.append(this.strip);
        document.addEventListener("pointermove", (event) => this.followPointer(event));
        document.documentElement.addEventListener("pointerleave", () => this.retreat());
        this.label();
    }

    /** Whether the sidebar takes its column beside the page. */
    get isDocked(): boolean {
        return this.place === "docked";
    }

    // MARK: - Actions - Toggling

    /** Show or Hide Sidebar: a docked sidebar goes away, a floating or collapsed one docks. */
    toggle(): void {
        this.show(this.place === "docked" ? "collapsed" : "docked");
    }

    private show(place: Place): void {
        if (place === this.place) return;
        this.cancelReveal();
        this.place = place;
        document.body.classList.toggle("sidebar-collapsed", place !== "docked");
        document.body.classList.toggle("sidebar-floating", place === "floating");
        if (place === "floating") {
            this.releaseOverlay ??= holdOverlay();
        } else if (this.releaseOverlay) {
            // The card slides away over the page before the page takes the pointer back.
            const release = this.releaseOverlay;
            this.releaseOverlay = null;
            const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--crest-dur-sidebar-retreat")) || 300;
            setTimeout(release, place === "collapsed" ? duration : 0);
        }
        this.label();
    }

    private label(): void {
        const title = this.place === "docked" ? "Hide Sidebar" : "Dock Sidebar";
        this.toggleButton.title = title;
        this.toggleButton.setAttribute("aria-label", title);
    }

    // MARK: - Actions - Revealing

    /** Brings the sidebar out once the pointer has stayed on the strip for the reveal delay. */
    private armReveal(): void {
        if (this.place !== "collapsed" || this.revealTimer) return;
        const delay = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-reveal-delay")) || 0;
        this.revealTimer = window.setTimeout(() => {
            this.revealTimer = 0;
            if (this.place === "collapsed" && this.strip.matches(":hover")) this.show("floating");
        }, delay);
    }

    private cancelReveal(): void {
        clearTimeout(this.revealTimer);
        this.revealTimer = 0;
    }

    /** Puts a floating sidebar away once the pointer leaves it by more than its exit margin. */
    private followPointer(event: PointerEvent): void {
        if (this.place !== "floating") return;
        const card = this.root.getBoundingClientRect();
        if (event.clientX > card.right + exitMargin) this.retreat();
    }

    private retreat(): void {
        if (this.place !== "floating") return;
        // A menu the card opened, or a drag out of it, keeps it out.
        if (overlayHolders() > 1 || document.body.classList.contains("sidebar-lifting")) return;
        this.show("collapsed");
    }
}
