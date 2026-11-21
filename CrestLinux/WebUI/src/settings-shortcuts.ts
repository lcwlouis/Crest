// Settings' Shortcuts page (BrowserShortcutSettingsView): every command the
// Linux window performs, by section, with the keys the core says it has, a
// recorder to press new ones, and each command's menu (Clear Shortcut,
// Reset to Default, and what happens when a website uses the same keys).
// The core keeps the bindings in its device store and refuses a shortcut
// another command holds, which the page then offers to replace.

import { ShortcutCommand, ShortcutPreference, ShortcutSection, ShortcutSpecialKey } from "../generated/crest_contracts.js";
import type { KeyCombination, ShortcutBinding } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { dispatch, Refused } from "./bridge.js";
import { keysLabel, keysOf, performsOnLinux } from "./commands.js";
import type { MenuEntry } from "./menu.js";
import { Menu } from "./menu.js";
import { Notices, postNotice } from "./notices.js";
import type { SettingsContext } from "./settings.js";
import { button, element, glyphButton, group, row } from "./settings-form.js";
import { explanation } from "./space-actions.js";

/** The command whose recorder waits for keys, and the search, while Settings stays open. */
let recording: ShortcutCommand | null = null;
let filter = "";
let stopWatching: (() => void) | null = null;

export function shortcutsPage(context: SettingsContext): (HTMLElement | null)[] {
    const shortcuts = context.preferences.shortcuts;
    if (!shortcuts) return [];
    const bindings = new Map(shortcuts.bindings.map((binding) => [binding.command, binding]));
    const search = element("input", "settings-field settings-shortcut-search");
    search.type = "search";
    search.placeholder = "Search shortcuts";
    search.setAttribute("aria-label", "Search shortcuts");
    search.value = filter;
    search.addEventListener("input", () => {
        filter = search.value;
        const scroll = search.closest(".settings-scroller");
        const top = scroll?.scrollTop ?? 0;
        context.redraw();
        // The field the person types in stays theirs.
        const again = document.querySelector<HTMLInputElement>(".settings-shortcut-search");
        again?.focus();
        again?.setSelectionRange(filter.length, filter.length);
        if (scroll) scroll.scrollTop = top;
    });
    const resetAll = button("Reset All…", () =>
        showAlert({
            title: "Reset all Crest shortcuts?",
            message: "Every Crest command will return to its default shortcut.",
            buttons: [
                { title: "Reset Crest Shortcuts", role: "destructive", action: () => void context.send({ kind: "ResetShortcuts", value: {} }) },
                { title: "Cancel", role: "cancel" },
            ],
        }),
        "plain",
        !shortcuts.isCustomized,
    );
    const toolbar = element("div", "settings-toolbar");
    toolbar.append(search, resetAll);
    const words = filter.trim().toLowerCase();
    const sections = ShortcutSection.all.map((section) => {
        const rows = ShortcutCommand.all
            .filter((command) => ShortcutCommand.facts[command].section === section && performsOnLinux(command))
            .filter((command) => {
                if (!words) return true;
                const facts = ShortcutCommand.facts[command];
                const keys = bindings.get(command)?.keys;
                return `${facts.title.text} ${facts.searchTerms?.text ?? ""} ${keys ? keysLabel(keys) : ""}`.toLowerCase().includes(words);
            })
            .map((command) => commandRow(context, command, bindings.get(command)));
        return group(ShortcutSection.facts[section].title.text, rows);
    });
    return [toolbar, element("p", "settings-note", "Click a shortcut, then press the new keys."), ...sections];
}

function commandRow(context: SettingsContext, command: ShortcutCommand, binding: ShortcutBinding | undefined): HTMLElement {
    const title = ShortcutCommand.facts[command].title.text;
    const controls = element("div", "settings-inline-controls");
    if (binding?.isCustomized) controls.append(element("span", "settings-row-detail", "Custom"));
    controls.append(recorder(context, command, title, binding?.keys ?? null));
    controls.append(glyphButton("ellipsis", `Actions for ${title}`, (anchor) => Menu.open(actions(context, command, binding), { anchor: anchor.getBoundingClientRect() })));
    return row(title, controls);
}

/** The keys a command has, which waits for new ones once clicked (BrowserShortcutRecorder). */
function recorder(context: SettingsContext, command: ShortcutCommand, title: string, keys: KeyCombination | null): HTMLButtonElement {
    const isRecording = recording === command;
    const node = element("button", isRecording ? "settings-recorder recording" : "settings-recorder", isRecording ? "Type Shortcut" : keys ? keysLabel(keys) : "Unassigned");
    node.type = "button";
    node.setAttribute("aria-label", `Shortcut for ${title}`);
    node.addEventListener("click", () => {
        recording = recording === command ? null : command;
        context.redraw();
    });
    if (isRecording) {
        // A press anywhere else stops recording; redraws move the keys' focus, so blur cannot.
        stopWatching?.();
        const stop = (event: PointerEvent): void => {
            if (recording !== command || node.contains(event.target as Node)) return;
            stopWatching?.();
            recording = null;
            setTimeout(() => context.redraw(), 0);
        };
        document.addEventListener("pointerdown", stop, true);
        stopWatching = () => {
            document.removeEventListener("pointerdown", stop, true);
            stopWatching = null;
        };
    }
    node.addEventListener("keydown", (event) => {
        if (recording !== command) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            recording = null;
            context.redraw();
            return;
        }
        const pressed = keysOf(event);
        if (!pressed) return;
        const special = ShortcutSpecialKey.all.find((key) => ShortcutSpecialKey.facts[key].name === pressed.key);
        const isFunctionKey = pressed.isSpecialKey && special !== undefined && ShortcutSpecialKey.facts[special].functionKeyNumber !== null;
        if (pressed.modifiers === 0 && !isFunctionKey) {
            postNotice(Notices.failure("Use a function key, or a key with Ctrl, Alt or Shift."));
            return;
        }
        recording = null;
        void assign(context, command, pressed);
    });
    if (isRecording) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".settings-recorder.recording")?.focus());
    return node;
}

/** Gives `command` the keys, offering to take them from the command that has them. */
async function assign(context: SettingsContext, command: ShortcutCommand, keys: KeyCombination): Promise<void> {
    try {
        await dispatch({ kind: "AssignShortcut", value: { command, keys } });
    } catch (error) {
        if (!(error instanceof Refused) || error.rejection.kind !== "ShortcutInUse") {
            postNotice(Notices.failure(explanation(error)));
            context.redraw();
            return;
        }
        const holders = error.rejection.value.commands.map((holder) => ShortcutCommand.facts[holder].title.text);
        const many = holders.length > 1;
        showAlert({
            title: "Shortcut Already in Use",
            message: `${keysLabel(keys)} is assigned to ${new Intl.ListFormat(undefined, { type: "conjunction" }).format(holders)}. Replacing it will clear the shortcut from ${many ? "those commands" : "that command"}.`,
            buttons: [
                { title: "Replace Existing Shortcut", role: "default", action: () => void context.send({ kind: "ReassignShortcut", value: { command, keys } }) },
                { title: "Cancel", role: "cancel", action: () => context.redraw() },
            ],
        });
    }
}

function actions(context: SettingsContext, command: ShortcutCommand, binding: ShortcutBinding | undefined): MenuEntry[] {
    const entries: MenuEntry[] = [
        {
            title: "Clear Shortcut",
            icon: { kind: "symbol", name: "xmark" },
            disabled: !binding?.keys,
            action: () => void context.send({ kind: "UnassignShortcut", value: { command } }),
        },
        {
            title: "Reset to Default",
            icon: { kind: "symbol", name: "arrow.counterclockwise" },
            disabled: !binding?.isCustomized,
            action: () => void context.send({ kind: "ResetShortcut", value: { command } }),
        },
    ];
    if (binding?.choosesPreference) {
        entries.push("separator", {
            title: "When a Website Uses These Keys",
            icon: { kind: "symbol", name: "globe" },
            submenu: ShortcutPreference.all.map((preference) => ({
                title: ShortcutPreference.facts[preference].title.text,
                icon: { kind: "symbol", name: ShortcutPreference.facts[preference].symbol },
                checked: binding.preference === preference,
                action: () => void context.send({ kind: "ChooseShortcutPreference", value: { command, preference } }),
            })),
        });
    }
    return entries;
}
