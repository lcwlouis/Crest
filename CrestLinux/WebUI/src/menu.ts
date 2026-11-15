// Crest's menus on Linux, drawn as the Mac's context menus draw: the system
// menu with an icon on every item (crestMenuActionLabelStyle), submenus,
// separators, dimmed items, checkmarks and destructive items. It opens at the
// pointer or under the control that opened it and stays inside the window.
//
// A menu floats over the page, so the window raises the WebUI over the page's
// view while one is open. The menu takes the keyboard (arrows, Enter, Escape
// and typing an item's first letters, as the Mac's menus do) and closes on a
// click outside it, when the window loses focus or changes size.

import type { SpaceSettings } from "../generated/crest_contracts.js";
import { spaceIcon } from "./crest.js";
import { holdOverlay } from "./overlay.js";
import { sfSymbol } from "./symbols.js";

/** What a menu item shows in its icon slot. */
export type MenuIcon =
    | { readonly kind: "symbol"; readonly name: string; readonly color?: string }
    /** A folder's own icon: its emoji, or the folder glyph filled in its colour. */
    | { readonly kind: "folder"; readonly color: string; readonly emoji?: string }
    /** A Space's own icon, its crest or symbol, as BrowserSpaceIdentityLabel shows it. */
    | { readonly kind: "space"; readonly settings: SpaceSettings };

export interface MenuItem {
    readonly title: string;
    readonly icon: MenuIcon;
    readonly disabled?: boolean;
    readonly checked?: boolean;
    readonly destructive?: boolean;
    readonly submenu?: readonly MenuEntry[];
    readonly action?: () => void;
}

export type MenuEntry = MenuItem | "separator";

/** Where a menu opens: at a point (a context menu) or under a control. */
export type MenuPlacement = { readonly x: number; readonly y: number } | { readonly anchor: DOMRect };

const margin = 6;
const submenuDelay = 150;
const typeAheadReset = 900;
/** A release this soon after opening is the click that opened the menu. */
const openingRelease = 250;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    return node;
}

/** Drops separators at either end and runs of them, as the Mac's menus do. */
function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
    const kept: MenuEntry[] = [];
    for (const entry of entries) {
        if (entry === "separator" && (kept.length === 0 || kept.at(-1) === "separator")) continue;
        kept.push(entry);
    }
    while (kept.at(-1) === "separator") kept.pop();
    return kept;
}

function iconElement(icon: MenuIcon): HTMLElement {
    const slot = element("span", "menu-icon");
    switch (icon.kind) {
        case "symbol":
            slot.innerHTML = sfSymbol(icon.name);
            if (icon.color) {
                slot.style.color = icon.color;
                slot.classList.add("tinted");
            }
            break;
        case "folder":
            if (icon.emoji) {
                slot.textContent = icon.emoji;
                slot.classList.add("emoji");
            } else {
                slot.innerHTML = sfSymbol("folder.fill");
                slot.style.color = icon.color;
                slot.classList.add("tinted", "filled");
            }
            break;
        case "space":
            slot.append(spaceIcon(icon.settings, 16));
            slot.classList.add("tinted");
            break;
    }
    return slot;
}

interface Panel {
    readonly node: HTMLElement;
    readonly items: { readonly item: MenuItem; readonly node: HTMLElement }[];
    highlighted: number;
    /** The item of this panel whose submenu is open, and that submenu. */
    child: { readonly index: number; readonly panel: Panel } | null;
}

/** One open menu, with the submenus open from it. */
export class Menu {
    private static current: Menu | null = null;

    private readonly layer = element("div", "menu-layer");
    private readonly panels: Panel[] = [];
    private readonly releaseOverlay = holdOverlay();
    /** Set while an item's action runs, which releases the overlay after it. */
    private activating = false;
    private readonly openedAt = performance.now();
    private readonly restoreFocus: Element | null = document.activeElement;
    private readonly onClose: (() => void) | undefined;
    private pointerMoved = false;
    private submenuTimer = 0;
    private typed = "";
    private typedAt = 0;
    private closed = false;
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];

    /** Opens `entries` where `placement` says, closing any menu already open. */
    static open(entries: readonly MenuEntry[], placement: MenuPlacement, onClose?: () => void): Menu {
        Menu.current?.close();
        const menu = new Menu(entries, placement, onClose);
        Menu.current = menu;
        return menu;
    }

    /** Whether a menu is open. */
    static get isOpen(): boolean {
        return Menu.current !== null;
    }

    /** Closes the menu that is open, if any. */
    static closeAll(): void {
        Menu.current?.close();
    }

    private constructor(entries: readonly MenuEntry[], placement: MenuPlacement, onClose?: () => void) {
        this.onClose = onClose;
        document.body.append(this.layer);
        const panel = this.panel(entries);
        this.layer.append(panel.node);
        this.place(panel.node, placement);
        this.layer.tabIndex = -1;
        this.layer.focus({ preventScroll: true });

        // A press outside the menu closes it, and goes no further, as on the
        // Mac. A secondary press opens the menu of what is under it instead.
        this.layer.addEventListener("mousedown", (event) => {
            if (event.target !== this.layer) return;
            event.preventDefault();
            this.close();
        });
        this.layer.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            if (event.target !== this.layer) return;
            this.close();
            document.elementFromPoint(event.clientX, event.clientY)?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: 2,
                }),
            );
        });
        this.layer.addEventListener("mousemove", () => (this.pointerMoved = true), { once: true });
        this.listen(window, "keydown", (event) => this.key(event as KeyboardEvent), true);
        this.listen(window, "blur", () => this.close(), false);
        this.listen(window, "resize", () => this.close(), false);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        window.clearTimeout(this.submenuTimer);
        for (const [target, type, listener, capture] of this.listeners) target.removeEventListener(type, listener, capture);
        this.layer.remove();
        if (!this.activating) this.releaseOverlay();
        if (Menu.current === this) Menu.current = null;
        if (this.restoreFocus instanceof HTMLElement && this.restoreFocus.isConnected) {
            this.restoreFocus.focus({ preventScroll: true });
        }
        this.onClose?.();
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture: boolean): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    private panel(entries: readonly MenuEntry[]): Panel {
        const node = element("div", "menu");
        node.setAttribute("role", "menu");
        const panel: Panel = { node, items: [], highlighted: -1, child: null };
        const shown = tidy(entries);
        if (shown.some((entry) => entry !== "separator" && entry.checked !== undefined)) node.classList.add("checks");
        for (const entry of shown) {
            if (entry === "separator") {
                const separator = element("div", "menu-separator");
                separator.setAttribute("role", "separator");
                node.append(separator);
                continue;
            }
            const index = panel.items.length;
            const row = element("div", "menu-item");
            row.setAttribute("role", entry.checked !== undefined ? "menuitemcheckbox" : "menuitem");
            if (entry.checked !== undefined) row.setAttribute("aria-checked", String(entry.checked));
            if (entry.disabled) row.setAttribute("aria-disabled", "true");
            if (entry.destructive) row.classList.add("destructive");
            if (entry.checked !== undefined) {
                const check = element("span", "menu-check");
                if (entry.checked) check.innerHTML = sfSymbol("checkmark", 12);
                row.append(check);
            }
            const title = element("span", "menu-title");
            title.textContent = entry.title;
            row.append(iconElement(entry.icon), title);
            if (entry.submenu) {
                row.setAttribute("aria-haspopup", "menu");
                const chevron = element("span", "menu-chevron");
                chevron.innerHTML = sfSymbol("chevron.right", 10);
                row.append(chevron);
            }
            row.addEventListener("mouseenter", () => this.hover(panel, index));
            row.addEventListener("mouseup", (event) => {
                if (event.button === 1) return;
                if (!this.pointerMoved && performance.now() - this.openedAt < openingRelease) return;
                this.activate(panel, index, false);
            });
            node.append(row);
            panel.items.push({ item: entry, node: row });
        }
        node.addEventListener("mouseleave", (event) => {
            // Leaving towards the open submenu keeps its item highlighted.
            const into = event.relatedTarget as Node | null;
            if (panel.child && into && panel.child.panel.node.contains(into)) return;
            if (!panel.child) this.highlight(panel, -1);
        });
        this.panels.push(panel);
        return panel;
    }

    private place(node: HTMLElement, placement: MenuPlacement): void {
        node.style.maxHeight = `${window.innerHeight - 2 * margin}px`;
        const box = node.getBoundingClientRect();
        const width = window.innerWidth;
        const height = window.innerHeight;
        let left: number;
        let top: number;
        if ("anchor" in placement) {
            left = placement.anchor.left;
            top = placement.anchor.bottom + 4;
            if (left + box.width > width - margin) left = placement.anchor.right - box.width;
            if (top + box.height > height - margin) top = placement.anchor.top - 4 - box.height;
        } else {
            left = placement.x;
            top = placement.y;
            if (left + box.width > width - margin) left = placement.x - box.width;
            if (top + box.height > height - margin) top = placement.y - box.height;
        }
        node.style.left = `${Math.round(Math.max(margin, Math.min(left, width - margin - box.width)))}px`;
        node.style.top = `${Math.round(Math.max(margin, Math.min(top, height - margin - box.height)))}px`;
    }

    private placeSubmenu(node: HTMLElement, parent: HTMLElement, row: HTMLElement): void {
        node.style.maxHeight = `${window.innerHeight - 2 * margin}px`;
        const box = node.getBoundingClientRect();
        const outer = parent.getBoundingClientRect();
        const item = row.getBoundingClientRect();
        const padding = parseFloat(getComputedStyle(node).paddingTop) || 0;
        let left = outer.right - 1;
        if (left + box.width > window.innerWidth - margin) left = outer.left - box.width + 1;
        let top = item.top - padding;
        if (top + box.height > window.innerHeight - margin) top = window.innerHeight - margin - box.height;
        node.style.left = `${Math.round(Math.max(margin, left))}px`;
        node.style.top = `${Math.round(Math.max(margin, top))}px`;
    }

    private highlight(panel: Panel, index: number): void {
        panel.highlighted = index;
        panel.items.forEach(({ node }, at) => node.classList.toggle("highlighted", at === index));
        panel.items[index]?.node.scrollIntoView({ block: "nearest" });
    }

    private hover(panel: Panel, index: number): void {
        this.pointerMoved = true;
        const entry = panel.items[index]!;
        this.highlight(panel, entry.item.disabled ? -1 : index);
        window.clearTimeout(this.submenuTimer);
        if (panel.child?.index === index) {
            this.closeChild(panel.child.panel);
            return;
        }
        this.submenuTimer = window.setTimeout(() => {
            if (panel.child) this.closeChild(panel);
            if (entry.item.submenu && !entry.item.disabled) this.openSubmenu(panel, index, false);
        }, panel.child || entry.item.submenu ? submenuDelay : 0);
    }

    /** Closes the submenus open below `panel`. */
    private closeChild(panel: Panel): void {
        const child = panel.child;
        if (!child) return;
        this.closeChild(child.panel);
        child.panel.node.remove();
        this.panels.splice(this.panels.indexOf(child.panel), 1);
        panel.child = null;
    }

    private openSubmenu(panel: Panel, index: number, highlightFirst: boolean): void {
        const entry = panel.items[index];
        if (!entry?.item.submenu || entry.item.disabled) return;
        if (panel.child?.index === index) {
            // Already open from the pointer: the keyboard moves into it.
            const open = panel.child.panel;
            if (highlightFirst && open.highlighted < 0) this.highlight(open, this.next(open, -1, 1));
            return;
        }
        this.closeChild(panel);
        const child = this.panel(entry.item.submenu);
        this.layer.append(child.node);
        this.placeSubmenu(child.node, panel.node, entry.node);
        panel.child = { index, panel: child };
        if (highlightFirst) this.highlight(child, this.next(child, -1, 1));
    }

    private activate(panel: Panel, index: number, fromKeyboard: boolean): void {
        const entry = panel.items[index];
        if (!entry || entry.item.disabled) return;
        if (entry.item.submenu) {
            this.openSubmenu(panel, index, fromKeyboard);
            return;
        }
        // The overlay stays up through the action, so a surface it opens, such
        // as a rename field or an alert, keeps the keyboard rather than losing
        // it to the page as the overlay drops.
        this.activating = true;
        try {
            this.close();
            entry.item.action?.();
        } finally {
            this.activating = false;
            this.releaseOverlay();
        }
    }

    /** The next enabled item from `from` going `step`, or `from` when there is none. */
    private next(panel: Panel, from: number, step: number): number {
        const count = panel.items.length;
        for (let offset = 1; offset <= count; offset++) {
            const index = (((from + step * offset) % count) + count) % count;
            if (!panel.items[index]!.item.disabled) return index;
        }
        return from;
    }

    private key(event: KeyboardEvent): void {
        const panel = this.panels.at(-1)!;
        const parent = this.panels.at(-2);
        // Every key belongs to the menu while it is open.
        event.preventDefault();
        event.stopPropagation();
        switch (event.key) {
            case "ArrowDown":
                this.highlight(panel, this.next(panel, panel.highlighted < 0 ? -1 : panel.highlighted, 1));
                break;
            case "ArrowUp":
                this.highlight(panel, this.next(panel, panel.highlighted < 0 ? 0 : panel.highlighted, -1));
                break;
            case "Home":
                this.highlight(panel, this.next(panel, -1, 1));
                break;
            case "End":
                this.highlight(panel, this.next(panel, 0, -1));
                break;
            case "ArrowRight":
                if (panel.highlighted >= 0) this.openSubmenu(panel, panel.highlighted, true);
                // A submenu the pointer opened takes the keyboard on its first item.
                else if (parent) this.highlight(panel, this.next(panel, -1, 1));
                break;
            case "ArrowLeft":
                if (parent) this.closeChild(parent);
                break;
            case "Enter":
            case " ":
                if (panel.highlighted >= 0) this.activate(panel, panel.highlighted, true);
                break;
            case "Escape":
                this.close();
                break;
            case "Tab":
                break;
            default:
                if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) this.typeAhead(panel, event.key);
        }
    }

    /** Highlights the first enabled item whose title starts with what the person typed. */
    private typeAhead(panel: Panel, key: string): void {
        const now = performance.now();
        this.typed = (now - this.typedAt > typeAheadReset ? "" : this.typed) + key.toLowerCase();
        this.typedAt = now;
        const index = panel.items.findIndex(
            ({ item }) => !item.disabled && item.title.toLowerCase().startsWith(this.typed),
        );
        if (index >= 0) this.highlight(panel, index);
    }
}
