// The questions sites ask, as the floating page draws them: a site's request
// for a capability as a card by the page's corner (the Mac's
// BrowserPagePermissionPrompt), and dialogs (script dialogs, sign-in,
// download approval) as a card over the dimmed page (the Mac's
// BrowserDialogPresenter sheets). The main WebUI words them and decides what
// each answer means; this page only draws them and reports what the person
// chose.

/** A button of a dialog, in the order it shows from left to right. */
export interface DialogButton {
    readonly label: string;
    /** Return chooses it, and it wears Crest's accent. */
    readonly isDefault: boolean;
    /** Escape chooses it. */
    readonly isCancel: boolean;
}

/** A text field of a dialog. */
export interface DialogField {
    readonly label: string;
    readonly value: string;
    readonly secret: boolean;
}

export type PromptFloatState =
    | {
          readonly kind: "dialog";
          readonly promptId: string;
          /** A warning's dialog shows the caution mark, as an NSAlert's warning style. */
          readonly warning: boolean;
          readonly title: string;
          readonly paragraphs: readonly string[];
          readonly fields: readonly DialogField[];
          readonly buttons: readonly DialogButton[];
      }
    | {
          readonly kind: "permission";
          readonly promptId: string;
          /** The permission's symbol, as the core names it (an SF Symbol name). */
          readonly symbol: string;
          readonly site: string;
          readonly request: string;
          /** "Inside <top-level site>", for a frame of another site. */
          readonly inside: string | null;
          readonly remember: string;
      };

export type PromptFloatEvent =
    | {
          readonly kind: "dialogAnswer";
          readonly promptId: string;
          /** The index of the chosen button in `buttons`. */
          readonly button: number;
          readonly fields: readonly string[];
      }
    | { readonly kind: "permissionAnswer"; readonly promptId: string; readonly grants: boolean; readonly remembers: boolean }
    | { readonly kind: "permissionDismiss"; readonly promptId: string }
    /** The permission card's height as drawn, which its surface takes. */
    | { readonly kind: "permissionSize"; readonly promptId: string; readonly height: number };

/** Whether the main WebUI asks for one of the prompts. */
export function isPromptState(state: { readonly kind: string }): state is PromptFloatState {
    return state.kind === "dialog" || state.kind === "permission";
}

// Line glyphs for the permissions' symbols, drawn on a 24-unit grid.
const glyphs: Readonly<Record<string, string>> = {
    video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/>',
    "video.and.waveform":
        '<rect x="2" y="6" width="12" height="12" rx="2"/><path d="M14 10l4-2v8l-4-2"/><path d="M21 9v6"/>',
    location: '<path d="M3 11l18-8-8 18-2-8z"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    "macwindow.on.rectangle":
        '<rect x="7" y="3" width="14" height="11" rx="2"/><path d="M7 7h14"/><path d="M3 9v10a2 2 0 0 0 2 2h11"/>',
    "arrow.down.circle": '<circle cx="12" cy="12" r="9"/><path d="M12 7v9"/><path d="M8 12l4 4 4-4"/>',
    "arrow.up.forward.app":
        '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M10 14l6-6"/><path d="M10 8h6v6"/>',
    "rectangle.inset.filled.and.person.filled":
        '<rect x="2" y="4" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M8 16a4 4 0 0 1 8 0"/>',
};
const caution =
    '<path d="M12 3L2 20h20z" fill="currentColor" stroke="none"/><path class="caution-mark" d="M12 10v4"/><circle class="caution-mark" cx="12" cy="17" r="0.6"/>';

function svg(paths: string, size: number): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const made = document.createElement(tag);
    made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
}

/** Draws the prompts the main WebUI sends, keeping what the person typed while the same prompt stays. */
export class PromptView {
    private readonly surface: HTMLElement;
    private readonly send: (event: PromptFloatEvent) => void;
    private shownId: string | null = null;
    private keys: ((event: KeyboardEvent) => void) | null = null;

    constructor(surface: HTMLElement, send: (event: PromptFloatEvent) => void) {
        this.surface = surface;
        this.send = send;
        document.addEventListener("keydown", (event) => {
            if (this.shownId) this.keys?.(event);
        });
    }

    draw(state: PromptFloatState): void {
        const key = `${state.kind}:${state.promptId}`;
        if (this.shownId === key && this.surface.firstElementChild?.isConnected) return;
        this.shownId = key;
        if (state.kind === "dialog") this.drawDialog(state);
        else this.drawPermission(state);
    }

    /** Something else shows on the surface now. */
    clear(): void {
        this.shownId = null;
        this.keys = null;
    }

    private drawDialog(state: Extract<PromptFloatState, { kind: "dialog" }>): void {
        const scrim = node("div", "prompt-scrim");
        const card = node("div", "dialog-card");
        card.setAttribute("role", "alertdialog");
        card.setAttribute("aria-modal", "true");
        card.tabIndex = -1;
        if (state.warning) {
            const mark = node("div", "dialog-caution");
            mark.innerHTML = svg(caution, 32);
            card.append(mark);
        }
        const title = node("h1", "dialog-title", state.title);
        title.id = "dialog-title";
        card.setAttribute("aria-labelledby", title.id);
        card.append(title);
        for (const paragraph of state.paragraphs) {
            if (paragraph) card.append(node("p", "dialog-message", paragraph));
        }
        const inputs = state.fields.map((field) => {
            const input = node("input", "dialog-field");
            input.type = field.secret ? "password" : "text";
            input.value = field.value;
            input.placeholder = field.label;
            input.spellcheck = false;
            input.autocomplete = "off";
            input.setAttribute("aria-label", field.label);
            card.append(input);
            return input;
        });
        const answer = (index: number): void => {
            this.send({ kind: "dialogAnswer", promptId: state.promptId, button: index, fields: inputs.map((input) => input.value) });
        };
        const row = node("div", "dialog-buttons");
        state.buttons.forEach((button, index) => {
            const control = node("button", button.isDefault ? "prompt-button prominent" : "prompt-button", button.label);
            control.addEventListener("click", () => answer(index));
            row.append(control);
        });
        card.append(row);
        scrim.append(card);
        this.surface.replaceChildren(scrim);
        // Return chooses the default button and Escape the cancelling one,
        // wherever the keyboard is in the dialog, as an NSAlert's sheet does.
        this.keys = (event) => {
            if (event.key === "Enter" && !event.isComposing) {
                const index = state.buttons.findIndex((button) => button.isDefault);
                if (index >= 0) {
                    event.preventDefault();
                    answer(index);
                }
            } else if (event.key === "Escape") {
                const index = state.buttons.findIndex((button) => button.isCancel);
                if (index >= 0) {
                    event.preventDefault();
                    answer(index);
                }
            }
        };
        const first = inputs.find((input) => !input.value) ?? inputs[0];
        if (first) {
            first.focus();
            first.select();
        } else {
            card.focus();
        }
    }

    private drawPermission(state: Extract<PromptFloatState, { kind: "permission" }>): void {
        const card = node("div", "permission-card");
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-label", `${state.site} ${state.request}`);
        card.tabIndex = -1;
        const head = node("div", "permission-head");
        const glyph = node("span", "permission-symbol");
        glyph.innerHTML = svg(glyphs[state.symbol] ?? glyphs["arrow.up.forward.app"]!, 20);
        const words = node("div", "permission-words");
        words.append(node("div", "permission-site", state.site), node("div", "permission-request", state.request));
        if (state.inside) words.append(node("div", "permission-inside", state.inside));
        const dismiss = node("button", "permission-dismiss");
        dismiss.title = "Dismiss Permission Request";
        dismiss.setAttribute("aria-label", dismiss.title);
        dismiss.innerHTML = svg('<path d="M7 7l10 10"/><path d="M17 7L7 17"/>', 14);
        dismiss.addEventListener("click", () => this.send({ kind: "permissionDismiss", promptId: state.promptId }));
        head.append(glyph, words, dismiss);

        const remember = node("label", "permission-remember");
        const box = node("input", "permission-check");
        box.type = "checkbox";
        box.checked = true;
        remember.append(box, document.createTextNode(state.remember));

        const row = node("div", "permission-buttons");
        const deny = node("button", "prompt-button", "Deny");
        const allow = node("button", "prompt-button prominent", "Allow");
        deny.addEventListener("click", () =>
            this.send({ kind: "permissionAnswer", promptId: state.promptId, grants: false, remembers: box.checked }),
        );
        allow.addEventListener("click", () =>
            this.send({ kind: "permissionAnswer", promptId: state.promptId, grants: true, remembers: box.checked }),
        );
        row.append(deny, allow);
        card.append(head, remember, row);
        this.surface.replaceChildren(card);
        // Escape dismisses, as the card's close control is its cancel action.
        this.keys = (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            this.send({ kind: "permissionDismiss", promptId: state.promptId });
        };
        card.focus();
        this.send({ kind: "permissionSize", promptId: state.promptId, height: Math.ceil(card.getBoundingClientRect().height) });
    }
}
