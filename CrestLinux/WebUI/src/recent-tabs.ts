// The recent tabs while a Most Recent Tab shortcut is held, as the Mac's
// BrowserMacRecentTabSwitcher and RecentTabSwitcherSession: the hold begins
// on the shortcut's keys, follows the keys and the release of its modifiers,
// shows the panel over the window once it lasts, and switches or cancels as
// the person ends it. A quick tap goes back to the tab used before.
//
// The core orders the window's tabs and splits by use (RecentTabs) and shows
// the one chosen (ShowTab); without a hold, the commands jump at once
// (ShowMostRecentTab, ShowLeastRecentTab).

import { ShortcutCommand } from "../generated/crest_contracts.js";
import type { Guid, Intent, RecentTabItem, TabState } from "../generated/crest_contracts.js";
import { listenToModifierRelease, query } from "./bridge.js";
import type { HeldModifiers } from "./bridge.js";
import type { KeyLike } from "./commands.js";
import type { TabIcons } from "./icons.js";
import type { Space } from "./model.js";
import { holdOverlay } from "./overlay.js";
import type { Preferences } from "./preferences.js";

// MARK: - Types

/** What the switcher reads and asks of its window. */
export interface RecentTabsContext {
    readonly icons: TabIcons;
    readonly preferences: Preferences;
    readonly windowId: () => Guid;
    readonly space: () => Space | undefined;
    readonly send: (intent: Intent) => void;
}

/**
 * Which way a Most Recent Tab command starts through the recent tabs
 * (RecentTabSwitchDirection): forward lands on the tab used just before this
 * one, backward on the tab used longest ago.
 */
class Direction {
    static readonly forward = new Direction(1, false);
    static readonly backward = new Direction(-1, true);

    /** How far one press moves the highlight. */
    readonly step: number;
    /** Whether a quick tap, and the first highlight, is the oldest item instead of the second. */
    readonly startsAtOldest: boolean;

    private constructor(step: number, startsAtOldest: boolean) {
        this.step = step;
        this.startsAtOldest = startsAtOldest;
    }

    /** The direction a held Shift turns this one into. */
    get reversed(): Direction {
        return this === Direction.forward ? Direction.backward : Direction.forward;
    }

    /** Where the highlight starts among `count` items: the second, or the last, and the only one when there is one. */
    startingIndex(count: number): number {
        if (count <= 1) return 0;
        return this.startsAtOldest ? count - 1 : 1;
    }

    /** The index one press from `index` among `count` items, wrapping. */
    index(from: number, count: number): number {
        return count > 0 ? (((from + this.step) % count) + count) % count : 0;
    }
}

/** The modifiers whose release ends the hold: the shortcut's, but Shift. */
interface Held {
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly meta: boolean;
}

interface Hold {
    readonly held: Held;
    items: RecentTabItem[];
    highlighted: number;
    isShowing: boolean;
    /** Takes the overlay back once the panel goes. */
    release: (() => void) | null;
    readonly timers: number[];
}

// MARK: - Static Variables

/** How many items the switcher lists, and the most 1-5 can reach. */
const maximumItems = 5;
/** How long the modifier is held before the panel shows. */
const showDelay = 100;
/** How often the open panel reads the window's list again. */
const refreshInterval = 250;

export class RecentTabSwitcher {
    private readonly context: RecentTabsContext;
    private hold: Hold | null = null;
    private readonly layer: HTMLElement;
    private readonly panel: HTMLElement;

    constructor(context: RecentTabsContext) {
        this.context = context;
        this.layer = element("div", "recent-tabs-layer");
        this.layer.hidden = true;
        this.panel = element("div", "recent-tabs");
        this.panel.setAttribute("role", "listbox");
        this.panel.setAttribute("aria-label", "Recent tabs");
        this.layer.append(this.panel);
        document.body.append(this.layer);
        // A click outside the open panel cancels it and goes no further.
        this.layer.addEventListener("pointerdown", (event) => {
            if (event.target !== this.layer) return;
            event.preventDefault();
            this.end(false);
        });
        // The release of a held modifier ends the hold: the WebUI's own while
        // it has the keyboard, the page's as the window reports it.
        window.addEventListener("keyup", (event) => this.modifiersChanged(event), true);
        listenToModifierRelease((held) => this.modifiersChanged(held));
        window.addEventListener("blur", () => {
            if (this.hold?.isShowing) this.end(false);
        });
    }

    /** Whether a hold is on. */
    get isHolding(): boolean {
        return this.hold !== null;
    }

    /** The intent `command` sends to jump at once, as from the command bar; null for another command. */
    jump(command: ShortcutCommand): Intent | null {
        const windowId = this.context.windowId();
        const kind = ShortcutCommand.facts[command].kind;
        if (kind === "MostRecentTab") return { kind: "ShowMostRecentTab", value: { windowId } };
        if (kind === "MostRecentTabBackward") return { kind: "ShowLeastRecentTab", value: { windowId } };
        return null;
    }

    /**
     * Begins a hold for `command`, pressed as `keys`, and answers whether it
     * did. Nothing begins while the preference is off, for another command,
     * or for keys with no modifier to hold; the command then jumps at once.
     */
    begin(command: ShortcutCommand, keys: KeyLike): boolean {
        const kind = ShortcutCommand.facts[command].kind;
        if (this.hold || (kind !== "MostRecentTab" && kind !== "MostRecentTabBackward")) return false;
        if (!this.context.preferences.app.showsRecentTabs) return false;
        const held = { ctrl: keys.ctrlKey, alt: keys.altKey, meta: keys.metaKey };
        if (!held.ctrl && !held.alt && !held.meta) return false;
        const direction = kind === "MostRecentTab" ? Direction.forward : Direction.backward;
        const hold: Hold = { held, items: [], highlighted: 0, isShowing: false, release: null, timers: [] };
        this.hold = hold;
        void query("RecentTabs", { windowId: this.context.windowId() })
            .then(({ items }) => {
                if (this.hold !== hold) return;
                hold.items = items.slice(0, maximumItems);
                if (hold.items.length === 0) {
                    this.end(false);
                    return;
                }
                hold.highlighted = direction.startingIndex(hold.items.length);
                this.draw();
            })
            .catch((error: unknown) => {
                console.error(error);
                if (this.hold === hold) this.end(false);
            });
        hold.timers.push(
            window.setTimeout(() => this.showDelayElapsed(), showDelay),
            window.setInterval(() => void this.refresh(), refreshInterval),
        );
        return true;
    }

    /**
     * A key pressed while held, from the window's own keys or the page's.
     * Answers whether the switcher took it.
     */
    handleKey(event: KeyLike, command: ShortcutCommand | null): boolean {
        const hold = this.hold;
        if (!hold) return false;
        if (["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"].includes(event.key)) return hold.isShowing;
        // A press without the held modifiers means the release never arrived.
        if (!this.stillHeld(event)) {
            this.end(true);
            return false;
        }
        const kind = command ? ShortcutCommand.facts[command].kind : null;
        let move: Direction | null = null;
        if (kind === "MostRecentTab") move = Direction.forward;
        else if (kind === "MostRecentTabBackward") move = Direction.backward;
        else if (event.key === "Tab") move = event.shiftKey ? Direction.backward : Direction.forward;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move = Direction.backward;
        else if (event.key === "ArrowRight" || event.key === "ArrowDown") move = Direction.forward;
        if (move) {
            hold.isShowing = true;
            hold.highlighted = move.index(hold.highlighted, hold.items.length);
            this.present();
            return true;
        }
        const number = Number.parseInt(event.key, 10);
        if (number >= 1 && number <= maximumItems && event.key.length === 1) {
            hold.isShowing = true;
            if (number - 1 < hold.items.length) hold.highlighted = number - 1;
            this.present();
            return true;
        }
        if (event.key === "Enter") {
            this.end(true);
            return true;
        }
        if (event.key === "Escape") {
            this.end(false);
            return true;
        }
        // Nothing reaches the page while the panel is up.
        return hold.isShowing;
    }

    // MARK: - Actions - Events

    /** Whether `modifiers` still hold every modifier the hold needs. */
    private stillHeld(modifiers: HeldModifiers): boolean {
        const held = this.hold?.held;
        if (!held) return false;
        return (!held.ctrl || modifiers.ctrlKey) && (!held.alt || modifiers.altKey) && (!held.meta || modifiers.metaKey);
    }

    /** The modifiers held now. A release of any held one ends the hold, switching to the highlighted item. */
    private modifiersChanged(modifiers: HeldModifiers): void {
        if (this.hold && !this.stillHeld(modifiers)) this.end(true);
    }

    private showDelayElapsed(): void {
        const hold = this.hold;
        if (!hold) return;
        hold.isShowing = true;
        this.present();
    }

    /** Reads the window's list again, so a closed tab leaves the panel; the highlight stays on its tab. */
    private async refresh(): Promise<void> {
        const hold = this.hold;
        if (!hold || hold.items.length === 0) return;
        try {
            const { items } = await query("RecentTabs", { windowId: this.context.windowId() });
            if (this.hold !== hold) return;
            const next = items.slice(0, maximumItems);
            if (next.length === 0) {
                this.end(false);
                return;
            }
            if (sameItems(next, hold.items)) return;
            const highlighted = hold.items[hold.highlighted];
            const kept = highlighted ? next.findIndex((item) => item.tabIds.some((id) => highlighted.tabIds.includes(id))) : -1;
            hold.items = next;
            hold.highlighted = kept >= 0 ? kept : Math.min(hold.highlighted, next.length - 1);
            this.draw();
        } catch (error) {
            console.error(error);
        }
    }

    // MARK: - Actions - Ending

    /**
     * Ends the hold. A release, Return or a click switches to the highlighted
     * item, unless it is the tab already shown; Escape and a click elsewhere
     * leave the window as it is.
     */
    private end(commits: boolean): void {
        const hold = this.hold;
        if (!hold) return;
        this.hold = null;
        for (const timer of hold.timers) {
            window.clearTimeout(timer);
            window.clearInterval(timer);
        }
        this.layer.hidden = true;
        this.panel.replaceChildren();
        hold.release?.();
        const item = hold.items[hold.highlighted];
        const spaceId = this.context.space()?.state.id;
        if (!commits || hold.highlighted === 0 || !item || !spaceId) return;
        this.context.send({ kind: "ShowTab", value: { windowId: this.context.windowId(), spaceId, tabId: item.focusedTabId } });
    }

    // MARK: - Actions - Panel

    /** Shows the panel once the hold calls for it, over the window, which then takes the keys. */
    private present(): void {
        const hold = this.hold;
        if (!hold?.isShowing || hold.items.length === 0) return;
        if (!hold.release) {
            hold.release = holdOverlay();
            this.layer.hidden = false;
        }
        this.draw();
    }

    private draw(): void {
        const hold = this.hold;
        if (!hold?.release) return;
        const space = this.context.space();
        this.panel.replaceChildren(
            ...hold.items.map((item, index) => this.card(item, index, index === hold.highlighted, space, hold.items.length)),
        );
    }

    /** One item: its tab, or the tabs of its split side by side. */
    private card(item: RecentTabItem, index: number, highlighted: boolean, space: Space | undefined, count: number): HTMLElement {
        const tabs = item.tabIds.flatMap((id) => space?.tabs.find((tab) => tab.id === id) ?? []);
        const card = element("button", highlighted ? "recent-tab-card highlighted" : "recent-tab-card");
        card.setAttribute("role", "option");
        card.setAttribute("aria-selected", String(highlighted));
        const title = tabs.map(tabTitle).join(", ");
        card.setAttribute("aria-label", `${title}, ${index + 1} of ${count}`);
        card.classList.toggle("split", tabs.length > 1);
        for (const tab of tabs) card.append(this.page(tab));
        card.addEventListener("pointermove", () => {
            if (!this.hold || this.hold.highlighted === index) return;
            this.hold.highlighted = index;
            this.draw();
        });
        card.addEventListener("click", () => {
            if (!this.hold) return;
            this.hold.highlighted = index;
            this.end(true);
        });
        return card;
    }

    /**
     * A tab's favicon large on the tab's colour over its favicon and title,
     * as the Mac draws a page that has no picture yet.
     */
    private page(tab: TabState): HTMLElement {
        // TODO(linux): the Mac shows a picture of each page; Linux keeps none yet.
        const page = element("div", "recent-tab-page");
        const thumbnail = element("div", "recent-tab-thumbnail");
        const tint = tab.iconAccent;
        // The tab's own colour, or the chrome's when it has none.
        if (tint) {
            const [red, green, blue] = [tint.red, tint.green, tint.blue].map((channel) => Math.round(channel * 255));
            thumbnail.style.background = `rgb(${red} ${green} ${blue} / var(--crest-opacity-prominent-status-surface))`;
        }
        thumbnail.append(this.favicon(tab, "recent-tab-favicon large"));
        const label = element("div", "recent-tab-label");
        label.append(this.favicon(tab, "recent-tab-favicon"), element("span", "recent-tab-title", tabTitle(tab)));
        page.append(thumbnail, label);
        return page;
    }

    private favicon(tab: TabState, className: string): HTMLElement {
        const icon = element("span", className);
        const image = this.context.icons.imageOf(tab.id);
        if (image) {
            const img = element("img", "");
            img.src = image;
            img.alt = "";
            icon.append(img);
        } else {
            icon.classList.add("letter");
            icon.textContent = tabTitle(tab).slice(0, 1).toUpperCase();
        }
        return icon;
    }
}

function tabTitle(tab: TabState): string {
    return tab.displayTitle || tab.url || "New Tab";
}

function sameItems(a: readonly RecentTabItem[], b: readonly RecentTabItem[]): boolean {
    return (
        a.length === b.length &&
        a.every((item, index) => item.focusedTabId === b[index]!.focusedTabId && item.tabIds.join() === b[index]!.tabIds.join())
    );
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
