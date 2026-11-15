// Crest's commands on Linux: the ShortcutCommand list the core publishes,
// performed as the Mac's BrowserCommandActions perform them, and their
// default keys, read from the contract with Ctrl in place of Command.
//
// A command the Linux window cannot perform yet is left out of the command
// bar and its keys do nothing, so nothing offers what does not work.

import { ShortcutCommand, ShortcutModifiers, ShortcutSection } from "../generated/crest_contracts.js";
import type { Guid, Intent, PageState, PaletteCommand, TabState } from "../generated/crest_contracts.js";
import { pageRequest, query } from "./bridge.js";
import { listKey } from "./model.js";
import type { Model, Space, Workspace } from "./model.js";
import { Notices, postNotice } from "./notices.js";

/** What commands act on: the window's shown Space, tab and page. */
export interface CommandContext {
    readonly model: Model;
    readonly windowId: () => Guid;
    readonly workspace: () => Workspace | undefined;
    readonly space: () => Space | undefined;
    readonly tab: () => TabState | undefined;
    readonly page: () => PageState | undefined;
    readonly send: (intent: Intent) => void;
    readonly report: (error: unknown) => void;
    readonly openPalette: (mode: "newTab" | "current") => void;
    readonly find: (action: "open" | "next" | "previous") => void;
}

/** The commands the Linux window performs; the rest wait for their surfaces. */
const known = new Set<string>([
    "NewTab", "OpenLocation", "CloseTabOrWindow", "ArchiveTab", "Back", "Forward", "ReloadPage", "ReloadFromOrigin",
    "StopLoading", "ToggleSelectedTabPinned", "DuplicateTab", "ReopenClosedTab", "ClearUnpinnedTabs", "PreviousTab",
    "NextTab", "PreviousSpace", "NextSpace", "SelectNumbered", "ZoomIn", "ZoomOut", "ActualSize", "CopyPageLink",
    "CopyPageLinkAsMarkdown", "FindInPage", "FindNext", "FindPrevious",
]);

/** The levels the page zoom commands step through, as the Mac's pageZoomLevels. */
const zoomSteps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Two zooms closer than this are the same level. */
const zoomTolerance = 0.001;

export class Commands {
    private readonly context: CommandContext;
    private readonly zoom = new Map<Guid, number>();

    constructor(context: CommandContext) {
        this.context = context;
    }

    /** The commands the command bar offers, in the contract's order. */
    paletteCommands(): PaletteCommand[] {
        return ShortcutCommand.all
            .filter((command) => ShortcutCommand.facts[command].offersInPalette && this.supports(command))
            .map((command) => {
                const facts = ShortcutCommand.facts[command];
                return {
                    command,
                    title: facts.title.text,
                    sectionTitle: ShortcutSection.facts[facts.section].title.text,
                };
            });
    }

    /** Whether the Linux window performs `command` at all, whatever it shows now. */
    isKnown(command: ShortcutCommand): boolean {
        return known.has(ShortcutCommand.facts[command].kind);
    }

    supports(command: ShortcutCommand): boolean {
        return this.action(command) !== null;
    }

    perform(command: ShortcutCommand): boolean {
        const action = this.action(command);
        if (!action) return false;
        action();
        return true;
    }

    /**
     * Runs the command `event` names by its default keys, as the Mac's menu
     * does. True when a command took the keys.
     */
    handleKey(event: KeyLike): boolean {
        const command = commandForKeys(event);
        if (!command) return false;
        return this.perform(command);
    }

    private action(command: ShortcutCommand): (() => void) | null {
        const facts = ShortcutCommand.facts[command];
        const { send } = this.context;
        const workspace = this.context.workspace();
        const space = this.context.space();
        const tab = this.context.tab();
        const page = this.context.page();
        const windowId = this.context.windowId();
        const ids = workspace && space ? { workspaceId: workspace.id, windowId, spaceId: space.state.id } : null;
        switch (facts.kind) {
            case "NewTab":
                return () => this.context.openPalette("newTab");
            case "OpenLocation":
                return () => this.context.openPalette("current");
            case "CloseTabOrWindow":
            case "ArchiveTab":
                return ids && tab ? () => send({ kind: "CloseTab", value: { ...ids, tabId: tab.id } }) : null;
            case "Back":
                return page ? () => send({ kind: "StepHistory", value: { pageId: page.id, offset: -1 } }) : null;
            case "Forward":
                return page ? () => send({ kind: "StepHistory", value: { pageId: page.id, offset: 1 } }) : null;
            case "ReloadPage":
            case "ReloadFromOrigin": {
                const bypassesCache = facts.kind === "ReloadFromOrigin";
                return page ? () => this.request(pageRequest("ReloadPage", { pageId: page.id, bypassesCache })) : null;
            }
            case "StopLoading":
                return page ? () => this.request(pageRequest("StopLoading", { pageId: page.id })) : null;
            case "ToggleSelectedTabPinned":
                return ids && tab
                    ? () => send({ kind: "TogglePin", value: { workspaceId: ids.workspaceId, spaceId: ids.spaceId, tabId: tab.id } })
                    : null;
            case "DuplicateTab":
                return ids && tab
                    ? () => send({ kind: "DuplicateTab", value: { ...ids, tabId: tab.id, placement: null, shows: true } })
                    : null;
            case "ReopenClosedTab":
                return ids ? () => send({ kind: "ReopenClosedTab", value: ids }) : null;
            case "ClearUnpinnedTabs":
                return ids ? () => send({ kind: "ClearCurrentTabs", value: ids }) : null;
            case "PreviousTab":
            case "NextTab":
                return space ? () => this.step(space, facts.kind === "NextTab" ? 1 : -1) : null;
            case "PreviousSpace":
            case "NextSpace":
                return () =>
                    send({
                        kind: "ShowAdjacentSpace",
                        value: { windowId, direction: facts.kind === "NextSpace" ? "Next" : "Previous" },
                    });
            case "SelectNumbered":
                return space && facts.number ? () => this.selectNumbered(space, facts.selects, facts.number!) : null;
            case "ZoomIn":
            case "ZoomOut":
            case "ActualSize": {
                const kind = facts.kind;
                return page ? () => this.zoomPage(page, kind) : null;
            }
            case "FindInPage":
                return page ? () => this.context.find("open") : null;
            case "FindNext":
            case "FindPrevious": {
                const action = facts.kind === "FindNext" ? "next" : "previous";
                return page ? () => this.context.find(action) : null;
            }
            case "CopyPageLink":
            case "CopyPageLinkAsMarkdown": {
                const url = page?.live.url ?? tab?.url;
                if (!url) return null;
                const title = page?.live.title || tab?.displayTitle || url;
                const markdown = facts.kind === "CopyPageLinkAsMarkdown";
                // Every address leaving Crest goes through the core's Super
                // Copy, which takes trackers out of it.
                return () =>
                    void query("LinkToCopy", { url })
                        .then((clean) => navigator.clipboard.writeText(markdown ? `[${title}](${clean})` : clean))
                        .then(() => postNotice(Notices.urlCopied))
                        .catch(this.context.report);
            }
            default:
                return null;
        }
    }

    private request(request: Promise<unknown>): void {
        void request.catch(this.context.report);
    }

    /** The tabs in the order the sidebar draws them: pinned, saved, current. */
    private sidebarOrder(space: Space): Guid[] {
        const order: Guid[] = [];
        const walk = (section: "Pinned" | "Saved" | "Current", folderId: Guid | null): void => {
            for (const row of space.lists.get(listKey(section, folderId))?.rows ?? []) {
                if (row.kind === "Tab") order.push(row.id);
                else if (row.kind === "Split") order.push(...row.members);
                else if (row.kind === "Folder" && !space.folders.get(row.id)?.isCollapsed) walk(section, row.id);
            }
        };
        walk("Pinned", null);
        if (space.state.settings.isSavedTabsExpanded) walk("Saved", null);
        walk("Current", null);
        return order;
    }

    private step(space: Space, offset: number): void {
        const order = this.sidebarOrder(space);
        if (order.length === 0) return;
        const index = order.indexOf(this.context.tab()?.id ?? "");
        const next = order[(index + offset + order.length) % order.length];
        if (next) this.show(space, next);
    }

    private selectNumbered(space: Space, target: string | null, number: number): void {
        if (target === "Space") {
            const workspace = this.context.workspace();
            const spaceId = workspace?.order[number - 1];
            if (spaceId) this.context.send({ kind: "ShowSpace", value: { windowId: this.context.windowId(), spaceId } });
            return;
        }
        // 9 selects the last tab, as in every browser.
        const order = this.sidebarOrder(space);
        const tabId = number === 9 ? order.at(-1) : order[number - 1];
        if (tabId) this.show(space, tabId);
    }

    private show(space: Space, tabId: Guid): void {
        this.context.send({ kind: "ShowTab", value: { windowId: this.context.windowId(), spaceId: space.state.id, tabId } });
    }

    /**
     * Steps the page's zoom and says where it is now, as the Mac's zoom
     * commands do; a step that changes nothing says nothing.
     */
    private zoomPage(page: PageState, kind: "ZoomIn" | "ZoomOut" | "ActualSize"): void {
        const current = this.zoom.get(page.id) ?? 1;
        let factor = 1;
        if (kind === "ZoomIn") factor = zoomSteps.find((step) => step > current + zoomTolerance) ?? Math.max(current, zoomSteps.at(-1)!);
        if (kind === "ZoomOut") factor = [...zoomSteps].reverse().find((step) => step < current - zoomTolerance) ?? Math.min(current, zoomSteps[0]!);
        if (factor === current) return;
        this.zoom.set(page.id, factor);
        this.request(pageRequest("ZoomPage", { pageId: page.id, factor }));
        postNotice(Notices.pageZoom(`${Math.round(factor * 100)}%`));
    }
}

/** Linux spells the Mac's Command as Ctrl, Option as Alt and Control as Ctrl. */
function linuxModifiers(modifiers: number): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } {
    const command = (modifiers & ShortcutModifiers.Command) !== 0;
    const control = (modifiers & ShortcutModifiers.Control) !== 0;
    return {
        ctrl: command || control,
        // Command and Control together need a key of their own.
        meta: command && control,
        alt: (modifiers & ShortcutModifiers.Option) !== 0,
        shift: (modifiers & ShortcutModifiers.Shift) !== 0,
    };
}

const specialKeys: Record<string, string> = {
    upArrow: "ArrowUp",
    downArrow: "ArrowDown",
    leftArrow: "ArrowLeft",
    rightArrow: "ArrowRight",
    tab: "Tab",
    return: "Enter",
    escape: "Escape",
    delete: "Backspace",
    space: " ",
};

/** The keys each command answers to by default on a desktop. */
const keymap: { command: ShortcutCommand; key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }[] =
    ShortcutCommand.all.flatMap((command) =>
        ShortcutCommand.facts[command].defaultShortcuts
            .filter((shortcut) => shortcut.platform === "Desktop")
            .map((shortcut) => ({
                command,
                key: shortcut.keys.isSpecialKey ? (specialKeys[shortcut.keys.key] ?? shortcut.keys.key) : shortcut.keys.key.toLowerCase(),
                ...linuxModifiers(shortcut.keys.modifiers),
            })),
    );

/** What a key press says, from the page's own events or from the window. */
export interface KeyLike {
    readonly key: string;
    readonly code?: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
}

/** Whether Shift is part of a binding: not for a key whose character Shift makes. */
function shiftMatters(key: string): boolean {
    return key.length !== 1 || /[a-z0-9]/.test(key);
}

/**
 * The keys the window takes for Crest while a page has the focus: the ones
 * Crest reserves from pages before the page sees them, the rest only when the
 * page declines them.
 */
export function shortcutTable(commands: Commands): [string, boolean, boolean, boolean, number, boolean][] {
    return keymap
        .filter((binding) => commands.isKnown(binding.command))
        .map((binding) => [
            binding.key,
            binding.ctrl,
            binding.alt,
            binding.meta,
            shiftMatters(binding.key) ? Number(binding.shift) : -1,
            ShortcutCommand.facts[binding.command].isReservedFromPages,
        ]);
}

export function commandForKeys(event: KeyLike): ShortcutCommand | null {
    if (!event.ctrlKey && !event.altKey && !event.metaKey) return null;
    // Shift changes the key a person types ("+" is Shift+"=" on most layouts),
    // so a key compares by what it typed and by its plain key.
    const typed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const code = event.code ?? "";
    const plain = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : typed;
    for (const binding of keymap) {
        if (binding.key !== typed && binding.key !== plain && !(binding.key === "+" && typed === "=")) continue;
        if (binding.ctrl !== event.ctrlKey || binding.alt !== event.altKey || binding.meta !== event.metaKey) continue;
        if (shiftMatters(binding.key) && binding.shift !== event.shiftKey) continue;
        return binding.command;
    }
    return null;
}
