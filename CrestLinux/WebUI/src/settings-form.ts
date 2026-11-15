// The parts of a Settings page, as the Mac's grouped forms draw them
// (CrestSettingsGroup, CrestSettingRow): a group's title over a card of
// rows, each a title (and a detail under it) with its control at the
// trailing edge, and a footnote under the card.

import type { DeviceSetting, Resettable } from "./device-appearance.js";
import { sfSymbol } from "./symbols.js";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export interface Choice<T> {
    readonly value: T;
    readonly title: string;
}

export interface GroupOptions {
    readonly footer?: string | Node;
    /** A control in the group's header, such as Reset. */
    readonly accessory?: HTMLElement;
    readonly disabled?: boolean;
}

/** A titled card of rows; a group with no rows draws nothing. */
export function group(title: string | null, rows: readonly (HTMLElement | null)[], options: GroupOptions = {}): HTMLElement {
    const section = element("section", "settings-group");
    const shown = rows.filter((row): row is HTMLElement => row !== null);
    if (shown.length === 0 && !options.footer) {
        section.hidden = true;
        return section;
    }
    if (title || options.accessory) {
        const header = element("div", "settings-group-header");
        header.append(element("h3", "settings-group-title", title ?? ""));
        if (options.accessory) header.append(options.accessory);
        section.append(header);
        if (title) section.setAttribute("aria-label", title);
    }
    if (shown.length > 0) {
        const card = element("div", "settings-card");
        card.append(...shown);
        if (options.disabled) card.classList.add("disabled");
        section.append(card);
    }
    if (options.footer) {
        const footer = element("p", "settings-footer");
        footer.append(options.footer);
        section.append(footer);
    }
    return section;
}

/** One setting: its title, an optional detail under it, and its control. */
export function row(title: string, control: HTMLElement | null, detail?: string): HTMLElement {
    const node = element("div", "settings-row");
    const label = element("div", "settings-row-label");
    label.append(element("span", "settings-row-title", title));
    if (detail) label.append(element("span", "settings-row-detail", detail));
    node.append(label);
    if (control) {
        control.classList.add("settings-control");
        if (!control.getAttribute("aria-label")) control.setAttribute("aria-label", title);
        node.append(control);
    }
    return node;
}

/** A row that holds only `content`, such as a button or a note. */
export function wideRow(...content: (HTMLElement | string)[]): HTMLElement {
    const node = element("div", "settings-row wide");
    node.append(...content);
    return node;
}

export function toggle(isOn: boolean, change: (isOn: boolean) => void, disabled = false): HTMLInputElement {
    const input = element("input", "settings-switch");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = isOn;
    input.disabled = disabled;
    input.addEventListener("change", () => change(input.checked));
    return input;
}

export function picker<T>(choices: readonly Choice<T>[], selected: T, change: (value: T) => void, disabled = false): HTMLSelectElement {
    const select = element("select", "settings-select");
    choices.forEach((choice, index) => {
        const option = element("option", "", choice.title);
        option.value = String(index);
        option.selected = JSON.stringify(choice.value) === JSON.stringify(selected);
        select.append(option);
    });
    select.disabled = disabled;
    select.addEventListener("change", () => {
        const choice = choices[Number(select.value)];
        if (choice) change(choice.value);
    });
    return select;
}

/** A segmented control, as the Mac's `.segmented` pickers. */
export function segmented<T>(choices: readonly Choice<T>[], selected: T, change: (value: T) => void, disabled = false): HTMLElement {
    const control = element("div", "settings-segmented");
    control.setAttribute("role", "radiogroup");
    for (const choice of choices) {
        const isSelected = JSON.stringify(choice.value) === JSON.stringify(selected);
        const segment = element("button", isSelected ? "selected" : "", choice.title);
        segment.type = "button";
        segment.setAttribute("role", "radio");
        segment.setAttribute("aria-checked", String(isSelected));
        segment.disabled = disabled;
        segment.addEventListener("click", () => {
            if (!isSelected) change(choice.value);
        });
        control.append(segment);
    }
    return control;
}

export interface SliderOptions {
    readonly min: number;
    readonly max: number;
    readonly step?: number;
    /** What the readout says for a value. */
    readonly readout: (value: number) => string;
}

/** A slider with its readout, which sends once it settles. */
export function slider(value: number, options: SliderOptions, change: (value: number) => void): HTMLElement {
    const control = element("div", "settings-slider");
    const input = element("input", "");
    input.type = "range";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step ?? "any");
    input.value = String(value);
    const readout = element("span", "settings-slider-readout", options.readout(value));
    input.addEventListener("input", () => (readout.textContent = options.readout(Number(input.value))));
    input.addEventListener("change", () => change(Number(input.value)));
    control.append(input, readout);
    return control;
}

export type ButtonRole = "plain" | "prominent" | "destructive";

export function button(title: string, action: () => void, role: ButtonRole = "plain", disabled = false): HTMLButtonElement {
    const node = element("button", `settings-button ${role}`, title);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
}

/** A small glyph button, such as a row's menu. */
export function glyphButton(symbolName: string, label: string, action: (anchor: HTMLElement) => void): HTMLButtonElement {
    const node = element("button", "settings-glyph-button");
    node.type = "button";
    node.innerHTML = sfSymbol(symbolName, 14);
    node.title = label;
    node.setAttribute("aria-label", label);
    node.addEventListener("click", () => action(node));
    return node;
}

export function textField(value: string, placeholder: string, commit: (value: string) => void): HTMLInputElement {
    const input = element("input", "settings-field");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
    });
    return input;
}

/** A group header's Reset, enabled while any of `settings` differs from its default. */
export function resetButton(settings: readonly Resettable[]): HTMLButtonElement {
    const node = button("Reset", () => settings.forEach((setting) => setting.reset()), "plain", settings.every((setting) => setting.isDefault));
    node.classList.add("small");
    return node;
}

/** A row for a device choice: its control, and a reset glyph while it differs from its default. */
export function deviceRow<T>(title: string, setting: DeviceSetting<T>, control: (value: T, change: (value: T) => void) => HTMLElement, detail?: string): HTMLElement {
    const node = row(title, control(setting.value, (value) => setting.set(value)), detail);
    if (!setting.isDefault) {
        const reset = glyphButton("arrow.counterclockwise", `Reset ${title}`, () => setting.reset());
        reset.classList.add("settings-row-reset");
        node.querySelector(".settings-row-label")!.after(reset);
    }
    return node;
}

/** The note a page shows where Linux does not have a Mac feature yet. */
export function note(text: string): HTMLElement {
    return element("p", "settings-note", text);
}
