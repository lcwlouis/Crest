// The command bar, as the Mac's BrowserCommandPalette: the core ranks every
// row (PaletteSuggestions), and the bar shows them, keeps the selection, and
// performs the row the person picks the way its kind says
// (PaletteRowKind.activation), then tells the core what was chosen
// (RecordPaletteChoice) so it can learn.
//
// It floats over the page: while it is open the window raises the WebUI over
// the page's view (setOverlay), and the page shows through around the card.
//
// TODO(linux): search suggestions from the provider (answer.suggestionAddress)
// need the host to fetch them; chrome://crest has no network access.

import { PaletteActivation, PaletteRowKind, PaletteScope, PaletteSection } from "../generated/crest_contracts.js";
import type {
    AddressCompletion,
    Guid,
    Intent,
    PageState,
    PaletteAnswer,
    PaletteRow,
    SearchProvider,
    TabState,
} from "../generated/crest_contracts.js";
import { query, setOverlay } from "./bridge.js";
import type { Commands } from "./commands.js";
import type { TabIcons } from "./icons.js";
import type { Space, Workspace } from "./model.js";
import { element, symbol } from "./sidebar.js";

/** Whether the bar opens a new tab, or opens over the tab the window shows. */
export type PaletteMode = "newTab" | "current";

export interface PaletteHost {
    readonly icons: TabIcons;
    readonly commands: Commands;
    readonly windowId: () => Guid;
    readonly workspace: () => Workspace | undefined;
    readonly space: () => Space | undefined;
    readonly tab: () => TabState | undefined;
    readonly page: () => PageState | undefined;
    readonly send: (intent: Intent) => void;
    readonly report: (error: unknown) => void;
}

/** Line glyphs for the SF Symbols the core names. */
const glyphs: Record<string, string> = {
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
    magnifyingglass: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    "pin.fill": '<path d="M12 17v5"/><path d="M8 3h8l-1 6 3 4H6l3-4z"/>',
    pin: '<path d="M12 17v5"/><path d="M8 3h8l-1 6 3 4H6l3-4z"/>',
    bookmark: '<path d="M7 3h10v18l-5-4-5 4z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "square.stack": '<rect x="4" y="8" width="13" height="12" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/>',
    "square.on.square": '<rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/>',
    archivebox: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    gearshape: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    equal: '<path d="M5 9h14"/><path d="M5 15h14"/>',
    "doc.on.clipboard": '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/>',
    "line.3.horizontal.decrease": '<path d="M4 7h16"/><path d="M7 12h10"/><path d="M10 17h4"/>',
    "arrow.turn.down.left": '<path d="M19 5v7a3 3 0 0 1-3 3H6"/><path d="M10 11l-4 4 4 4"/>',
};

function glyph(name: string, size = 16): string {
    return symbol(glyphs[name] ?? glyphs.globe!, size);
}

interface Item {
    readonly row: PaletteRow;
    readonly index: number;
}

export class Palette {
    private readonly host: PaletteHost;
    private readonly layer = element("div", "palette-layer");
    private readonly card = element("div", "palette-card");
    private readonly chip = element("span", "palette-chip");
    private readonly field = element("input", "palette-field");
    private readonly results = element("div", "palette-results");

    private mode: PaletteMode = "newTab";
    /** Where an embedded bar lives (the Start Page), or null for the floating one. */
    private readonly embedded: HTMLElement | null;
    private items: Item[] = [];
    private selected = 0;
    private asked = 0;
    private shown = 0;
    private provider: SearchProvider | null = null;
    private scope: PaletteScope | null = null;
    private answer: PaletteAnswer | null = null;
    /** Whether the field may show a completion: only right after typing at its end. */
    private mayComplete = false;
    private completion: AddressCompletion | null = null;
    private waitingKey: (() => void) | null = null;

    constructor(host: PaletteHost, embedIn: HTMLElement | null = null) {
        this.host = host;
        this.embedded = embedIn;
        this.layer.hidden = true;
        const scrim = element("div", "palette-scrim");
        scrim.addEventListener("mousedown", () => this.close());
        const bar = element("div", "palette-bar");
        const leading = element("span", "palette-leading");
        leading.innerHTML = glyph("magnifyingglass", 20);
        this.chip.hidden = true;
        this.field.spellcheck = false;
        this.field.autocomplete = "off";
        this.field.setAttribute("aria-label", "Search or enter address");
        bar.append(leading, this.chip, this.field);
        this.card.append(bar, this.results);
        if (embedIn) {
            this.mode = "current";
            this.card.classList.add("embedded");
            this.layer.hidden = false;
            embedIn.append(this.card);
        } else {
            this.layer.append(scrim, this.card);
            document.body.append(this.layer);
        }

        this.field.addEventListener("input", (event) => {
            const input = event as InputEvent;
            this.mayComplete = input.inputType.startsWith("insert") && this.field.selectionStart === this.field.value.length;
            this.ask();
        });
        this.field.addEventListener("keydown", (event) => this.key(event));
    }

    get isOpen(): boolean {
        return !this.layer.hidden;
    }

    open(mode: PaletteMode, text = ""): void {
        if (this.embedded) {
            this.reset();
            this.field.focus();
            return;
        }
        this.mode = mode;
        this.provider = null;
        this.scope = null;
        this.completion = null;
        this.mayComplete = false;
        this.selected = 0;
        this.field.value = text;
        this.drawChip();
        document.body.classList.add("overlay");
        this.layer.hidden = false;
        setOverlay(true);
        this.field.focus();
        this.field.select();
        this.ask();
    }

    /** Empties an embedded bar, which stays where it is. */
    reset(): void {
        this.provider = null;
        this.scope = null;
        this.completion = null;
        this.mayComplete = false;
        this.selected = 0;
        this.field.value = "";
        this.drawChip();
        this.ask();
    }

    close(): void {
        if (this.embedded) {
            this.reset();
            this.field.blur();
            return;
        }
        if (!this.isOpen) return;
        this.layer.hidden = true;
        this.waitingKey = null;
        this.asked++;
        setOverlay(false);
        document.body.classList.remove("overlay");
        this.field.blur();
    }

    /** The text the person typed, without a completion the field shows. */
    private get typed(): string {
        if (this.completion && this.field.selectionEnd === this.field.value.length) {
            return this.field.value.slice(0, this.field.selectionStart ?? this.field.value.length);
        }
        return this.field.value;
    }

    private ask(): void {
        const text = this.typed;
        const asked = ++this.asked;
        this.selected = 0;
        void query("PaletteSuggestions", {
            windowId: this.host.windowId(),
            text,
            // The Start Page's bar offers no commands at rest, as the Mac's.
            commands: this.embedded && text.trim().length === 0 ? [] : this.host.commands.paletteCommands(),
            settingsPages: [],
            remote: [],
            provider: this.provider,
            scope: this.scope,
            allowsCompletion: this.mayComplete,
            pasteboard: null,
            spaceId: null,
        })
            .then((answer) => {
                if (asked !== this.asked || !this.isOpen) return;
                this.show(answer, asked);
            })
            .catch(this.host.report);
    }

    private show(answer: PaletteAnswer, asked: number): void {
        this.shown = asked;
        this.answer = answer;
        const unscoped = !this.provider && !this.scope;
        // The core names an entry when the text itself picks a provider or a
        // scope ("@tabs", a provider's keyword and a space).
        if (unscoped && answer.entry) {
            this.provider = answer.entry.provider;
            this.scope = answer.entry.scope;
            this.field.value = answer.entry.text;
            this.drawChip();
            this.ask();
            return;
        }
        this.items = [];
        this.results.replaceChildren();
        for (const group of answer.groups) {
            const title = PaletteSection.facts[group.section].title;
            if (title && group.rows.length > 0) this.results.append(element("div", "palette-section", title.text));
            for (const row of group.rows) {
                const item = { row, index: this.items.length };
                this.items.push(item);
                this.results.append(this.rowView(item));
            }
        }
        if (this.selected >= this.items.length) this.selected = 0;
        this.complete(answer.completion);
        this.drawSelection();
        const key = this.waitingKey;
        this.waitingKey = null;
        key?.();
    }

    /** Shows the core's completion after the caret, selected, as the Mac's field does. */
    private complete(completion: AddressCompletion | null): void {
        const typed = this.typed;
        this.completion = null;
        if (!completion || !this.mayComplete || this.provider || this.scope) return;
        if (completion.typed.toLowerCase() !== typed.toLowerCase() || completion.suffix.length === 0) return;
        this.completion = completion;
        this.field.value = typed + completion.suffix;
        this.field.setSelectionRange(typed.length, this.field.value.length);
    }

    private rowView(item: Item): HTMLElement {
        const { row } = item;
        const view = element("div", "palette-row");
        view.dataset.index = String(item.index);
        const icon = element("span", "palette-icon");
        const image = row.tabId ? this.host.icons.imageOf(row.tabId) : null;
        if (image) {
            const img = element("img", "");
            img.src = image;
            img.alt = "";
            icon.append(img);
        } else {
            icon.innerHTML = glyph(row.symbol || PaletteRowKind.facts[row.kind].symbol);
        }
        const text = element("span", "palette-text");
        text.append(element("span", "palette-title", row.title));
        if (row.subtitle) text.append(element("span", "palette-subtitle", row.subtitle));
        const facts = PaletteRowKind.facts[row.kind];
        const trailing = element("span", "palette-trailing", (facts.action ?? facts.label).text);
        view.append(icon, text, trailing);
        view.addEventListener("mousemove", () => {
            if (this.selected === item.index) return;
            this.selected = item.index;
            this.drawSelection();
        });
        view.addEventListener("mousedown", (event) => event.preventDefault());
        view.addEventListener("click", (event) => this.activate(row, event.ctrlKey || event.metaKey));
        return view;
    }

    private drawSelection(): void {
        for (const view of this.results.querySelectorAll<HTMLElement>(".palette-row")) {
            const selected = Number(view.dataset.index) === this.selected;
            view.classList.toggle("selected", selected);
            if (selected) view.scrollIntoView({ block: "nearest" });
        }
    }

    private drawChip(): void {
        const title = this.provider?.title ?? (this.scope ? PaletteScope.facts[this.scope].title.text : null);
        this.chip.hidden = !title;
        this.chip.textContent = title ?? "";
        this.field.placeholder = this.provider
            ? `Search ${this.provider.title}`
            : this.scope
              ? `Search ${PaletteScope.facts[this.scope].title.text}`
              : "Search or enter address";
    }

    private enter(provider: SearchProvider | null, scope: PaletteScope | null): void {
        this.provider = provider;
        this.scope = scope;
        this.completion = null;
        this.field.value = "";
        this.drawChip();
        this.ask();
    }

    /** A key acts once the answer to what was typed is shown, as on the Mac. */
    private whenAnswered(key: () => void): void {
        if (this.shown === this.asked) key();
        else this.waitingKey = key;
    }

    private key(event: KeyboardEvent): void {
        switch (event.key) {
            case "Escape":
                event.preventDefault();
                if (this.provider || this.scope) this.enter(null, null);
                else this.close();
                return;
            case "ArrowDown":
            case "ArrowUp": {
                event.preventDefault();
                const offset = event.key === "ArrowDown" ? 1 : -1;
                this.whenAnswered(() => this.move(offset));
                return;
            }
            case "Tab":
                event.preventDefault();
                if (event.shiftKey) this.move(-1);
                else this.whenAnswered(() => this.tab());
                return;
            case "Enter": {
                event.preventDefault();
                const newTab = event.ctrlKey || event.metaKey;
                this.whenAnswered(() => {
                    const item = this.items[this.selected];
                    if (item) this.activate(item.row, newTab);
                });
                return;
            }
            case "Backspace":
                if (this.field.value.length === 0 && (this.provider || this.scope)) {
                    event.preventDefault();
                    this.enter(null, null);
                }
                return;
            case "ArrowRight":
            case "End":
                // Moving the caret to the end takes the completion.
                if (this.completion) {
                    this.completion = null;
                    this.mayComplete = false;
                }
                return;
        }
    }

    private move(offset: number): void {
        if (this.items.length === 0) return;
        this.selected = (this.selected + offset + this.items.length) % this.items.length;
        if (this.completion) {
            this.field.value = this.typed;
            this.completion = null;
        }
        this.drawSelection();
    }

    /** Tab enters the offered provider or scope, takes the completion, or moves down. */
    private tab(): void {
        const answer = this.answer;
        const unscoped = !this.provider && !this.scope;
        const atEnd = this.field.selectionStart === this.field.value.length || this.completion !== null;
        if (unscoped && atEnd && answer?.offeredSearch && (!this.completion || answer.offeredSearch.beatsCompletion)) {
            this.enter(answer.offeredSearch.provider, null);
            return;
        }
        if (this.completion) {
            this.field.value = this.completion.accepted;
            this.field.setSelectionRange(this.field.value.length, this.field.value.length);
            this.completion = null;
            this.mayComplete = false;
            this.ask();
            return;
        }
        if (unscoped && atEnd && answer?.offeredScope) {
            this.enter(null, answer.offeredScope);
            return;
        }
        this.move(1);
    }

    private activate(row: PaletteRow, newTab: boolean): void {
        const activation = PaletteRowKind.facts[row.kind].activation;
        const typed = this.typed;
        if (activation === "EntersScope") {
            if (row.scope) this.enter(null, row.scope);
            return;
        }
        this.close();
        if (!this.perform(row, activation, newTab)) return;
        if (PaletteActivation.facts[activation].closesPalette) {
            this.host.send({
                kind: "RecordPaletteChoice",
                value: { windowId: this.host.windowId(), text: typed, row, spaceId: null },
            });
        }
    }

    private perform(row: PaletteRow, activation: PaletteActivation, newTab: boolean): boolean {
        const { send } = this.host;
        const workspace = this.host.workspace();
        const space = this.host.space();
        if (!workspace || !space) return false;
        const windowId = this.host.windowId();
        switch (activation) {
            case "SwitchesToTab":
                if (!row.tabId) return false;
                send({ kind: "ShowTab", value: { windowId, spaceId: space.state.id, tabId: row.tabId } });
                return true;
            case "OpensAddress":
            case "Searches":
                return row.address ? this.openAddress(workspace, space, row.address, newTab) : false;
            case "RunsCommand":
                return row.command ? this.host.commands.perform(row.command) : false;
            case "ShowsSpace":
                if (!row.subjectId) return false;
                send({ kind: "ShowSpace", value: { windowId, spaceId: row.subjectId } });
                return true;
            case "ReopensArchivedTab":
                if (!row.subjectId) return false;
                send({
                    kind: "RestoreArchivedTab",
                    value: { workspaceId: workspace.id, windowId, spaceId: space.state.id, tabId: row.subjectId },
                });
                return true;
            case "CopiesAnswer":
                void navigator.clipboard.writeText(row.title).catch(this.host.report);
                return true;
            default:
                return false;
        }
    }

    /**
     * Opens `address` in a new tab when the bar opened for one or the person
     * held Ctrl, else in the tab the window shows, as the Mac's palette opener.
     */
    private openAddress(workspace: Workspace, space: Space, address: string, newTab: boolean): boolean {
        const windowId = this.host.windowId();
        const tab = this.host.tab();
        const page = this.host.page();
        if (this.mode === "newTab" || newTab || !tab) {
            this.host.send({
                kind: "OpenAddress",
                value: { workspaceId: workspace.id, windowId, spaceId: space.state.id, tabId: crypto.randomUUID(), address },
            });
        } else if (page) {
            this.host.send({ kind: "LoadAddress", value: { pageId: page.id, url: address } });
        } else {
            this.host.send({
                kind: "NavigateTab",
                value: { workspaceId: workspace.id, spaceId: space.state.id, tabId: tab.id, input: address },
            });
        }
        return true;
    }
}
