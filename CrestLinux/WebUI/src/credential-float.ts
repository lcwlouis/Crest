// Crest's password prompts over a page, as the floating page draws them (the
// Mac's BrowserCredentialChrome): the passwords a Space keeps for the site
// (BrowserCredentialSuggestionPrompt), a strong password for a new-password
// field (BrowserStrongPasswordPrompt), and the offer to save or update a
// submitted sign-in (BrowserCredentialSavePrompt). The main WebUI words them
// and does what the person picks (credential-prompts.ts); this only draws
// them and says what was chosen. The main WebUI draws the same card to
// measure it, so the surface fits it.

// MARK: - Types

/** A saved password the suggestions offer. */
export interface CredentialSuggestionRow {
    readonly id: string;
    readonly title: string;
    readonly detail: string | null;
}

export type CredentialPromptBody =
    | {
          readonly kind: "suggestions";
          /** "Checking this Space…" while the Space's passwords are read. */
          readonly loading: boolean;
          readonly rows: readonly CredentialSuggestionRow[];
      }
    | {
          readonly kind: "strongPassword";
          readonly explanation: string;
          readonly working: boolean;
      }
    | {
          readonly kind: "save";
          readonly destination: string;
          /** The commit or retry button's title; none while there is nothing to do but dismiss. */
          readonly primary: string | null;
          readonly dismiss: string;
          readonly busy: boolean;
      };

export interface CredentialPromptState {
    readonly kind: "credential";
    /** The fill request's or save candidate's id. */
    readonly promptId: string;
    readonly symbol: "key.fill" | "key.horizontal.fill";
    readonly title: string;
    readonly subtitle: string;
    /** Where an embedded frame's sign-in comes from. */
    readonly notice: string | null;
    readonly body: CredentialPromptBody;
    readonly error: string | null;
    /** The card's width, in CSS pixels. */
    readonly width: number;
}

export type CredentialFloatEvent =
    | { readonly kind: "credentialClose"; readonly promptId: string }
    | { readonly kind: "credentialFill"; readonly promptId: string; readonly credentialId: string }
    | { readonly kind: "credentialStrongPassword"; readonly promptId: string }
    | { readonly kind: "credentialPrimary"; readonly promptId: string };

export function isCredentialState(state: { readonly kind: string }): state is CredentialPromptState {
    return state.kind === "credential";
}

// MARK: - Drawing

const glyphs: Readonly<Record<string, string>> = {
    "key.fill": '<circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21v3M18 12v2.5"/>',
    "key.horizontal.fill": '<circle cx="7" cy="12" r="4"/><path d="M11 12h10M17 12v3M20 12v2"/>',
    xmark: '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>',
    person: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5a6.5 6.5 0 0 1 11 0"/>',
    arrow: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/><path d="M13 8.5l3.5 3.5-3.5 3.5"/>',
    keySlash: '<circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21v3M18 12v2.5"/><path d="M3 4l18 16"/>',
    caution: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>',
    frame: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    space: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};

function svg(name: string, size: number): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] ?? ""}</svg>`;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const made = document.createElement(tag);
    made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
}

function labelled(className: string, glyph: string, text: string): HTMLElement {
    const line = node("div", className);
    const mark = node("span", "credential-mark");
    mark.innerHTML = svg(glyph, 13);
    line.append(mark, node("span", "credential-label-text", text));
    return line;
}

/** The card `state` draws; `send` hears what the person chose, and nothing when the card is only measured. */
export function credentialCard(state: CredentialPromptState, send: (event: CredentialFloatEvent) => void): HTMLElement {
    const card = node("div", "credential-card");
    card.style.width = `${state.width}px`;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", state.title);
    // The card never takes the page's focus by being pressed.
    card.addEventListener("mousedown", (event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });
    const promptId = state.promptId;

    const header = node("div", "credential-header");
    const identity = node("span", "credential-identity");
    identity.innerHTML = svg(state.symbol, 14);
    const words = node("div", "credential-words");
    words.append(node("div", "credential-title", state.title), node("div", "credential-subtitle", state.subtitle));
    header.append(identity, words, node("span", "credential-spacer"));
    const body = state.body;
    if (body.kind === "save") {
        const actions = node("div", "credential-actions");
        const dismiss = node("button", "prompt-button", body.dismiss);
        dismiss.disabled = body.busy && body.primary === null;
        dismiss.addEventListener("click", () => send({ kind: "credentialClose", promptId }));
        actions.append(dismiss);
        if (body.busy) {
            actions.append(node("span", "credential-progress"));
        } else if (body.primary) {
            const primary = node("button", "prompt-button prominent", body.primary);
            primary.addEventListener("click", () => send({ kind: "credentialPrimary", promptId }));
            actions.append(primary);
        }
        header.append(actions);
    } else {
        const close = node("button", "credential-close");
        close.title = "Close";
        close.setAttribute("aria-label", "Close");
        close.innerHTML = svg("xmark", 13);
        close.addEventListener("click", () => send({ kind: "credentialClose", promptId }));
        header.append(close);
    }
    card.append(header);

    if (state.notice) card.append(labelled("credential-notice", "frame", state.notice));

    switch (body.kind) {
        case "suggestions":
            if (body.loading) {
                const loading = node("div", "credential-loading");
                loading.append(node("span", "credential-progress"), node("span", "", "Checking this Space…"));
                card.append(loading);
            } else if (body.rows.length === 0) {
                card.append(labelled("credential-empty", "keySlash", "No passwords saved for this site"));
            } else {
                const list = node("div", "credential-list");
                for (const row of body.rows) {
                    const button = node("button", "credential-row");
                    const person = node("span", "credential-row-icon");
                    person.innerHTML = svg("person", 17);
                    const text = node("span", "credential-row-text");
                    text.append(node("span", "credential-row-title", row.title));
                    if (row.detail) text.append(node("span", "credential-row-detail", row.detail));
                    const go = node("span", "credential-row-go");
                    go.innerHTML = svg("arrow", 16);
                    button.append(person, text, go);
                    button.addEventListener("click", () => send({ kind: "credentialFill", promptId, credentialId: row.id }));
                    list.append(button);
                }
                card.append(list);
            }
            break;
        case "strongPassword": {
            const use = node("button", "prompt-button prominent credential-strong");
            use.disabled = body.working;
            if (body.working) {
                use.append(node("span", "credential-progress"));
                use.setAttribute("aria-label", "Creating strong password");
            } else {
                const mark = node("span", "credential-mark");
                mark.innerHTML = svg("key.horizontal.fill", 13);
                use.append(mark, document.createTextNode("Use Strong Password"));
            }
            use.addEventListener("click", () => send({ kind: "credentialStrongPassword", promptId }));
            card.append(use, node("p", "credential-explanation", body.explanation));
            break;
        }
        case "save":
            card.append(labelled("credential-destination", "space", body.destination));
            break;
    }

    if (state.error) card.append(labelled("credential-error", "caution", state.error));
    return card;
}
