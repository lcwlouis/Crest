// Crest's commands on Linux: the ShortcutCommand list the core publishes,
// performed as the Mac's BrowserCommandActions perform them, and their keys:
// the person's own as the core publishes them, else the contract's
// defaults, with Ctrl in place of Command.
//
// A command the Linux window cannot perform yet is left out of the command
// bar and its keys do nothing, so nothing offers what does not work.

import { ShortcutCommand, ShortcutModifiers, ShortcutPreference, ShortcutSection, ShortcutSpecialKey } from "../generated/crest_contracts.js";
import type { Guid, Intent, KeyCombination, PageState, PaletteCommand, ShortcutBinding, TabState } from "../generated/crest_contracts.js";
import { dispatch, pageRequest, query, Refused } from "./bridge.js";
import { listKey } from "./model.js";
import type { Model, Space, Workspace } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import { UtilitySurface } from "./utilities.js";

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
    /** Opens one of the sidebar's lists, or puts it away when it shows. */
    readonly toggleUtility: (surface: UtilitySurface) => void;
    /** The tabs the window shows as cards: one, or a split's members. */
    readonly cards: () => readonly Guid[];
    /** The Peek over the page, which Close Tab closes before the tab under it. */
    readonly peek: { readonly isOpen: boolean; close(): boolean };
    /** The windows the window opens, and its own close, which asks it first. */
    readonly windows: { openNewWindow(): void; openQuickWindow(): void; close(): void };
}

/**
 * The commands the Linux window performs; the rest wait for their surfaces.
 *
 * TODO(linux): PrintPage, ExportPDF, SaveWebArchive and CapturePage need the
 * host's print call and a save panel for ExportPage and CapturePage, and
 * ToggleDeveloperToolbar needs the Mac's BrowserDeveloperToolbar (viewport
 * presets and the capture tools), which the Settings toggle
 * automaticallyShowsDeveloperToolbar already names.
 */
const known = new Set<string>([
    "NewTab", "OpenLocation", "CloseTabOrWindow", "ArchiveTab", "Back", "Forward", "ReloadPage", "ReloadFromOrigin",
    "StopLoading", "ToggleSelectedTabPinned", "DuplicateTab", "ReopenClosedTab", "ClearUnpinnedTabs", "PreviousTab",
    "NextTab", "PreviousSpace", "NextSpace", "SelectNumbered", "ZoomIn", "ZoomOut", "ActualSize", "CopyPageLink",
    "CopyPageLinkAsMarkdown", "FindInPage", "FindNext", "FindPrevious", "ShowHistory", "ShowArchive", "ShowDownloads",
    "SplitWithNextTab", "FocusNextSplitCard", "FocusPreviousSplitCard", "RemoveTabFromSplit", "SeparateSplitTabs",
    "MoveSplitCardLeft", "MoveSplitCardRight", "NewWindow", "NewQuickWindow", "CloseWindow", "ShowWebInspector",
]);

/** Whether the Linux window performs `command` at all. */
export function performsOnLinux(command: ShortcutCommand): boolean {
    return known.has(ShortcutCommand.facts[command].kind);
}

/** The levels the page zoom commands step through, as the Mac's pageZoomLevels. */
export const zoomSteps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Two zooms closer than this are the same level. */
const zoomTolerance = 0.001;

export class Commands {
    private readonly context: CommandContext;
    private readonly zoom = new Map<Guid, number>();

    /** The zoom this window set on the page `pageId`; 1 when it set none. */
    zoomOf(pageId: Guid): number {
        return this.zoom.get(pageId) ?? 1;
    }

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
        return performsOnLinux(command);
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
        // The core says which commands the window leaves nothing to do for,
        // as it does for the split commands of a tab shown alone.
        if (this.context.model.windows.get(windowId)?.unavailableCommands.includes(command)) return null;
        switch (facts.kind) {
            case "NewTab":
                return () => this.context.openPalette("newTab");
            case "OpenLocation":
                return () => this.context.openPalette("current");
            case "CloseTabOrWindow":
                // A Peek closes before the tab under it, as on the Mac.
                if (this.context.peek.isOpen) return () => void this.context.peek.close();
                return ids && tab ? () => void this.closeTabOrWindow({ ...ids, tabId: tab.id }) : () => this.context.windows.close();
            case "NewWindow":
                return () => this.context.windows.openNewWindow();
            case "NewQuickWindow":
                return space ? () => this.context.windows.openQuickWindow() : null;
            case "CloseWindow":
                return () => this.context.windows.close();
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
            case "ShowHistory":
                return () => this.context.toggleUtility(UtilitySurface.history);
            case "ShowArchive":
                return () => this.context.toggleUtility(UtilitySurface.archive);
            case "ShowDownloads":
                return () => this.context.toggleUtility(UtilitySurface.downloads);
            case "SplitWithNextTab":
                return ids && tab ? () => this.splitWithNextTab(ids, tab.id) : null;
            case "FocusNextSplitCard":
            case "FocusPreviousSplitCard": {
                // Focus is selection, and wraps at both ends of the split.
                const cards = this.context.cards();
                const index = tab ? cards.indexOf(tab.id) : -1;
                if (!space || cards.length < 2 || index < 0) return null;
                const next = cards[(index + (facts.kind === "FocusNextSplitCard" ? 1 : -1) + cards.length) % cards.length]!;
                return () => this.show(space, next);
            }
            case "RemoveTabFromSplit":
                return ids && tab?.splitGroupId
                    ? () => send({ kind: "LeaveSplit", value: { workspaceId: ids.workspaceId, spaceId: ids.spaceId, tabId: tab.id } })
                    : null;
            case "SeparateSplitTabs": {
                const groupId = tab?.splitGroupId;
                return ids && groupId
                    ? () => send({ kind: "DissolveSplit", value: { workspaceId: ids.workspaceId, spaceId: ids.spaceId, groupId } })
                    : null;
            }
            case "MoveSplitCardLeft":
            case "MoveSplitCardRight": {
                // Left and right step back and on in a left-to-right window, which this one is.
                const offset = facts.kind === "MoveSplitCardRight" ? 1 : -1;
                if (!ids || !tab?.splitGroupId) return null;
                const step: Intent = {
                    kind: "StepSplitMember",
                    value: { workspaceId: ids.workspaceId, spaceId: ids.spaceId, tabId: tab.id, offset },
                };
                // The Mac's item is off where the card has nowhere to go, as
                // the core says (canMoveFocusedSplitCard asks CanSend).
                return () =>
                    void query("CanSend", { intent: step })
                        .then((permission) => (permission.refusal === null ? send(step) : undefined))
                        .catch(console.error);
            }
            case "ShowWebInspector":
                return page ? () => void this.toggleInspector(page.id).catch(this.context.report) : null;
            default:
                return null;
        }
    }

    /**
     * Closes the page's inspector, or opens one docked in its card, as the
     * Mac's Show Web Inspector does.
     */
    private async toggleInspector(pageId: Guid): Promise<void> {
        if (!(await pageRequest("PageInspected", { pageId }))) {
            await pageRequest("OpenInspector", { pageId, panel: null });
            return;
        }
        await pageRequest("CloseInspector", { pageId });
    }

    /**
     * Adds the tab the core picks, the next one in the shown tab's own
     * section, to the shown tab's split, making the split when there is none,
     * as the Mac's Split With Next Tab does.
     */
    private splitWithNextTab(ids: { workspaceId: Guid; windowId: Guid; spaceId: Guid }, tabId: Guid): void {
        void query("SplitJoinCandidate", { windowId: ids.windowId })
            .then((candidate) => {
                if (candidate.tabId) {
                    this.context.send({ kind: "JoinSplit", value: { ...ids, tabId: candidate.tabId, targetTabId: tabId, index: null } });
                }
            })
            .catch(this.context.report);
    }

    /**
     * Closes the tab the way the core closes it, or the window when the core
     * says only the window is left to close: it keeps the Start Page that is
     * its Space's only tab, as the Mac's closeTabOrWindow asks it.
     */
    private async closeTabOrWindow(value: { workspaceId: Guid; windowId: Guid; spaceId: Guid; tabId: Guid }): Promise<void> {
        try {
            await dispatch({ kind: "CloseTab", value });
        } catch (error) {
            if (error instanceof Refused && error.rejection.kind === "LastStartPage") this.context.windows.close();
            else this.context.report(error);
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

/** The DOM names of the special keys that are not function keys. */
const namedKeys: Partial<Record<ShortcutSpecialKey, string>> = {
    Tab: "Tab",
    LeftArrow: "ArrowLeft",
    RightArrow: "ArrowRight",
    UpArrow: "ArrowUp",
    DownArrow: "ArrowDown",
    Escape: "Escape",
    ReturnKey: "Enter",
    Delete: "Backspace",
    ForwardDelete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Space: " ",
};

/** A special key's DOM name (ShortcutSpecialKey). */
function domKey(key: ShortcutSpecialKey): string {
    const number = ShortcutSpecialKey.facts[key].functionKeyNumber;
    return number !== null ? `F${number}` : (namedKeys[key] ?? key);
}

/** The DOM key of a special key, by the name a binding spells it with. */
const specialKeys: Record<string, string> = Object.fromEntries(
    ShortcutSpecialKey.all.map((key) => [ShortcutSpecialKey.facts[key].name, domKey(key)]),
);

interface Binding {
    readonly command: ShortcutCommand;
    readonly key: string;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly meta: boolean;
    /** Whether the window takes the keys before the page sees them. */
    readonly reserved: boolean;
}

function binding(command: ShortcutCommand, keys: KeyCombination, reserved: boolean): Binding {
    return {
        command,
        key: keys.isSpecialKey ? (specialKeys[keys.key] ?? keys.key) : keys.key.toLowerCase(),
        ...linuxModifiers(keys.modifiers),
        reserved,
    };
}

/** The keys each command answers to: its desktop defaults until the core publishes the person's own. */
let keymap: Binding[] = ShortcutCommand.all.flatMap((command) =>
    ShortcutCommand.facts[command].defaultShortcuts
        .filter((shortcut) => shortcut.platform === "Desktop")
        .map((shortcut) => binding(command, shortcut.keys, ShortcutCommand.facts[command].isReservedFromPages)),
);

/**
 * Answers each command to the keys the core says it has (ShortcutsChanged),
 * taken before the page sees them where its preference runs Crest first.
 */
export function useShortcutBindings(bindings: readonly ShortcutBinding[]): void {
    keymap = bindings.flatMap((entry) =>
        entry.keys ? [binding(entry.command, entry.keys, ShortcutPreference.facts[entry.preference].runsBeforePage)] : [],
    );
}

/** The keys `event` holds as the contract spells them, or null for a lone modifier. */
export function keysOf(event: KeyLike): KeyCombination | null {
    if (["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"].includes(event.key)) return null;
    const special = ShortcutSpecialKey.all.find((key) => domKey(key) === event.key);
    const code = event.code ?? "";
    const plain = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : event.key.toLowerCase();
    let modifiers = 0;
    if (event.ctrlKey) modifiers |= ShortcutModifiers.Command;
    if (event.ctrlKey && event.metaKey) modifiers |= ShortcutModifiers.Control;
    if (event.altKey) modifiers |= ShortcutModifiers.Option;
    if (event.shiftKey) modifiers |= ShortcutModifiers.Shift;
    return special
        ? { key: ShortcutSpecialKey.facts[special].name, isSpecialKey: true, modifiers }
        : { key: plain, isSpecialKey: false, modifiers };
}

/** How Linux writes `keys`: its modifiers by their Linux names, then the key. */
export function keysLabel(keys: KeyCombination): string {
    const { ctrl, alt, shift, meta } = linuxModifiers(keys.modifiers);
    const special = keys.isSpecialKey ? ShortcutSpecialKey.all.find((key) => ShortcutSpecialKey.facts[key].name === keys.key) : undefined;
    const facts = special ? ShortcutSpecialKey.facts[special] : undefined;
    const key = facts ? (facts.functionKeyNumber !== null ? `F${facts.functionKeyNumber}` : (facts.glyph ?? facts.title?.text ?? keys.key)) : keys.key.toUpperCase();
    return [ctrl && "Ctrl", meta && "Super", alt && "Alt", shift && "Shift", key].filter(Boolean).join("+");
}

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
            binding.reserved,
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
