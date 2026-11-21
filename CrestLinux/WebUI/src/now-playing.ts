// The sidebar's widget deck with its Now Playing cards, as the Mac's
// BrowserSidebarWidgetHost, BrowserSidebarWidgetDeck and
// BrowserNowPlayingSidebarWidget draw them: one card in front with the next
// ones peeking under it, a stepper beside the deck when there is more than
// one, and on each card the tab, the media, and its transport. One deck
// serves every Space; a session the person hides stays hidden until its tab
// plays again.
//
// TODO(linux): the Mac's deck also carries the software update card, and
// Settings can turn the Now Playing card off; Linux has neither yet.

import type { Guid, Intent, MediaSessionAction } from "../generated/crest_contracts.js";
import type { TabIcons } from "./icons.js";
import { exposesMute, mediaDisplayTitle, ownerDisplayTitle, secondaryMetadata } from "./media-sessions.js";
import type { MediaSession, MediaSessions } from "./media-sessions.js";
import { element } from "./sidebar.js";
import { sfSymbol } from "./symbols.js";

export interface NowPlayingHost {
    readonly sessions: MediaSessions;
    readonly icons: TabIcons;
    readonly windowId: () => Guid;
    readonly send: (intent: Intent) => void;
}

/** How many cards the deck draws at once, the front one included (BrowserSidebarWidgetDeckStyle.visibleDepth). */
const visibleDepth = 3;

export class NowPlayingDeck {
    readonly root = element("section", "widget-deck");
    private readonly host: NowPlayingHost;
    private selected: string | null = null;

    constructor(host: NowPlayingHost) {
        this.host = host;
        this.root.setAttribute("aria-label", "Sidebar Widgets");
        this.root.hidden = true;
        // A scroll over the deck turns its cards, as the Mac's drag does.
        this.root.addEventListener(
            "wheel",
            (event) => {
                const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
                if (Math.abs(delta) < 8 || this.host.sessions.shown.length < 2) return;
                event.preventDefault();
                this.cycle(delta > 0 ? 1 : -1);
            },
            { passive: false },
        );
    }

    render(): void {
        const shown = this.host.sessions.shown;
        this.root.hidden = shown.length === 0;
        if (shown.length === 0) {
            this.selected = null;
            this.root.replaceChildren();
            return;
        }
        // The card in front stays in front while it shows, else the first.
        if (!shown.some((session) => session.id === this.selected)) this.selected = shown[0]!.id;
        const start = shown.findIndex((session) => session.id === this.selected);
        const order: MediaSession[] = [];
        for (let offset = 0; offset < Math.min(visibleDepth, shown.length); offset++) {
            order.push(shown[(start + offset) % shown.length]!);
        }
        const stack = element("div", "widget-stack");
        stack.setAttribute("aria-label", "Widget deck");
        stack.setAttribute("aria-valuetext", `Widget ${start + 1} of ${shown.length}`);
        stack.style.setProperty("--widget-depth", String(order.length - 1));
        // The deepest card first, so the front one draws over it.
        order.forEach((session, depth) => {
            const card = this.card(session, depth);
            stack.prepend(card);
        });
        this.root.replaceChildren(stack);
        if (shown.length > 1) this.root.append(this.stepper(shown));
    }

    private cycle(step: number): void {
        const shown = this.host.sessions.shown;
        const index = shown.findIndex((session) => session.id === this.selected);
        const next = shown[(index + step + shown.length) % shown.length];
        if (!next || next.id === this.selected) return;
        this.selected = next.id;
        this.render();
    }

    private stepper(shown: readonly MediaSession[]): HTMLElement {
        const rail = element("div", "widget-stepper");
        for (const session of shown) {
            const dot = element("button", "widget-stepper-dot");
            dot.classList.toggle("selected", session.id === this.selected);
            dot.title = ownerDisplayTitle(session);
            dot.setAttribute("aria-label", ownerDisplayTitle(session));
            dot.addEventListener("click", () => {
                this.selected = session.id;
                this.render();
            });
            rail.append(dot);
        }
        return rail;
    }

    private card(session: MediaSession, depth: number): HTMLElement {
        const card = element("div", "widget-card");
        card.dataset.depth = String(depth);
        card.setAttribute("aria-label", "Now Playing");
        if (depth > 0) {
            card.inert = true;
            return card;
        }

        const header = element("button", "widget-owner", ownerDisplayTitle(session));
        header.title = "Show Tab";
        header.setAttribute("aria-label", `Show tab ${ownerDisplayTitle(session)}`);
        header.addEventListener("click", () => this.showOwner(session));
        const dismiss = this.quiet("xmark", "Hide Now Playing", "Hide until this tab plays again", () =>
            this.host.sessions.dismiss(session),
        );
        dismiss.classList.add("widget-dismiss");

        const identity = element("button", "widget-media");
        identity.title = "Show Tab";
        identity.setAttribute("aria-label", `Show tab playing ${session.title ?? ownerDisplayTitle(session)}`);
        identity.addEventListener("click", () => this.showOwner(session));
        const artwork = element("span", "widget-artwork");
        if (session.artwork) {
            const image = element("img", "");
            image.src = session.artwork;
            image.alt = "";
            artwork.append(image);
        } else {
            artwork.classList.add("placeholder");
            artwork.innerHTML = sfSymbol("music.note", 18);
        }
        const text = element("span", "widget-media-text");
        text.append(
            element("span", "widget-media-title", mediaDisplayTitle(session)),
            element("span", "widget-media-detail", secondaryMetadata(session) ?? "Media from this tab"),
        );
        identity.append(artwork, text);

        const transport = element("div", "widget-transport");
        const favicon = element("button", "widget-quiet widget-favicon");
        favicon.title = "Show Tab";
        favicon.setAttribute("aria-label", `Show tab playing ${session.title ?? ownerDisplayTitle(session)}`);
        const image = this.host.icons.imageOf(session.tabId);
        if (image) {
            const icon = element("img", "");
            icon.src = image;
            icon.alt = "";
            favicon.append(icon);
        } else {
            favicon.innerHTML = sfSymbol("globe", 16);
        }
        favicon.addEventListener("click", () => this.showOwner(session));
        const middle = element("div", "widget-transport-center");
        if (session.actions.includes("PreviousTrack")) {
            middle.append(this.quiet("backward.fill", "Previous Track", "Previous Track", () => this.perform("PreviousTrack", session)));
        }
        const playing = session.playback === "Playing" && session.actions.includes("Pause");
        const action: MediaSessionAction = playing ? "Pause" : "Play";
        if (session.actions.includes(action)) {
            const play = element("button", "widget-play");
            play.innerHTML = sfSymbol(playing ? "pause.fill" : "play.fill", 16);
            play.title = playing ? "Pause" : "Play";
            play.setAttribute("aria-label", play.title);
            play.addEventListener("click", () => this.perform(action, session));
            middle.append(play);
        }
        if (session.actions.includes("NextTrack")) {
            middle.append(this.quiet("forward.fill", "Next Track", "Next Track", () => this.perform("NextTrack", session)));
        }
        const volume = exposesMute(session)
            ? this.quiet(session.muted ? "speaker.slash.fill" : "speaker.wave.2.fill", session.muted ? "Unmute" : "Mute", session.muted ? "Unmute" : "Mute", () =>
                  this.host.sessions.toggleMute(session),
              )
            : element("span", "widget-quiet-slot");
        transport.append(favicon, middle, volume);

        card.append(header, dismiss, identity, transport);
        return card;
    }

    private quiet(symbolName: string, label: string, help: string, act: () => void): HTMLButtonElement {
        const button = element("button", "widget-quiet");
        button.innerHTML = sfSymbol(symbolName, 12);
        button.title = help;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", act);
        return button;
    }

    private perform(action: MediaSessionAction, session: MediaSession): void {
        this.host.sessions.perform(action, session);
    }

    /** Shows the session's tab in this window, in its own Space. */
    private showOwner(session: MediaSession): void {
        this.host.send({ kind: "ShowTab", value: { windowId: this.host.windowId(), spaceId: session.spaceId, tabId: session.tabId } });
    }
}
