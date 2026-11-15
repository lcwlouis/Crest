// An alert over the window, for the few decisions the Mac asks for in one:
// confirming that a folder and what it holds go (its confirmationDialog), and
// naming a pinned tab, whose tile has no title to edit in place (its alert).
// Escape or Cancel dismisses it; Enter takes the default button.

import { holdOverlay } from "./overlay.js";

export interface AlertButton {
    readonly title: string;
    /** "default" answers Enter; "cancel" answers Escape; "destructive" reads as such. */
    readonly role: "default" | "cancel" | "destructive";
    /** What the button does, given the field's text when the alert has one. */
    readonly action?: (text: string) => void;
}

export interface AlertContent {
    readonly title: string;
    readonly message?: string;
    readonly field?: { readonly value: string; readonly placeholder: string };
    readonly buttons: readonly AlertButton[];
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function showAlert(content: AlertContent): void {
    const release = holdOverlay();
    const restoreFocus = document.activeElement;
    const layer = element("div", "alert-layer");
    const card = element("div", "alert");
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    const title = element("h2", "alert-title", content.title);
    card.append(title);
    if (content.message) card.append(element("p", "alert-message", content.message));
    const field = content.field ? element("input", "alert-field") : null;
    if (field && content.field) {
        field.value = content.field.value;
        field.placeholder = content.field.placeholder;
        field.spellcheck = false;
        field.setAttribute("aria-label", content.field.placeholder);
        card.append(field);
    }
    const buttons = element("div", "alert-buttons");
    let done = false;
    const finish = (button: AlertButton | undefined): void => {
        if (done) return;
        done = true;
        window.removeEventListener("keydown", onKey, true);
        layer.remove();
        release();
        if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus({ preventScroll: true });
        button?.action?.(field?.value ?? "");
    };
    for (const button of content.buttons) {
        const node = element("button", `alert-button ${button.role}`, button.title);
        node.addEventListener("click", () => finish(button));
        buttons.append(node);
    }
    card.append(buttons);
    layer.append(card);
    document.body.append(layer);

    const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            finish(content.buttons.find((button) => button.role === "cancel"));
        } else if (event.key === "Enter") {
            const fallback = content.buttons.find((button) => button.role === "default");
            if (!fallback && event.target === field) return;
            event.preventDefault();
            const focused = [...buttons.children].indexOf(document.activeElement as Element);
            finish(focused >= 0 ? content.buttons[focused] : fallback);
        }
        event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    if (field) {
        field.focus();
        field.select();
    } else {
        (buttons.querySelector(".alert-button.cancel") as HTMLElement | null)?.focus();
    }
}
