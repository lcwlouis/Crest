// Settings' Passwords: the Passwords page, which lists each Space to open its
// own, and a Space page's Passwords section (BrowserPasswordSettingsPane):
// Use Crest Passwords, the Space's saved passwords to search, view, copy and
// delete, and the ones that no longer read back to remove. A password opens
// in place of the list, as the Mac's sheet (BrowserCredentialDetailView)
// would, since Linux opens no window for it.
//
// The Secret Service unlocks the desktop's keyring when a password is first
// read, in place of the Mac's Touch ID before every reveal or copy.
//
// Left out on Linux, each with a TODO(linux): importing and exporting a CSV
// file of passwords, which needs a file picker and save dialog the shell does
// not offer yet; and the Mac's iCloud Keychain, system Passwords and system
// passkey choices, which Linux has none of.

import { showAlert } from "./alert.js";
import { copyPassword } from "./bridge.js";
import { identityIcon } from "./crest.js";
import { CredentialStore, isSecureOrigin, originDescription } from "./credentials.js";
import type { CredentialDescriptor, CredentialScope } from "./credentials.js";
import { Menu } from "./menu.js";
import type { Space } from "./model.js";
import type { SettingsContext } from "./settings.js";
import { button, element, glyphButton, group, row, toggle, wideRow } from "./settings-form.js";
import { SpaceGroups } from "./space-groups.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Types

/** How long a revealed password shows, and a copied one stays on the clipboard (BrowserCredentialDetailModel). */
const revealLifetime = 30_000;
const clipboardLifetime = 60;

const disabledDescription = "Saved passwords stay here until you delete them.";

/** What the section holds for one Space between draws (BrowserCredentialSpaceStore). */
interface PasswordsState {
    descriptors: CredentialDescriptor[];
    unreadableCount: number;
    isLoading: boolean;
    errorMessage: string | null;
    searchText: string;
    isSelecting: boolean;
    selected: Set<string>;
    deleting: Set<string>;
    detail: DetailState | null;
}

/** A password open in place of the list (BrowserCredentialDetailModel). */
interface DetailState {
    readonly descriptor: CredentialDescriptor;
    visiblePassword: string | null;
    isReading: boolean;
    showsCopyConfirmation: boolean;
    errorMessage: string | null;
    hideTimer: number | null;
}

const states = new Map<string, PasswordsState>();
/** The Space whose passwords were read last, so they are read again when another Space shows. */
let loadedSpace: string | null = null;

function stateOf(spaceId: string): PasswordsState {
    let state = states.get(spaceId);
    if (!state) {
        state = {
            descriptors: [],
            unreadableCount: 0,
            isLoading: false,
            errorMessage: null,
            searchText: "",
            isSelecting: false,
            selected: new Set(),
            deleting: new Set(),
            detail: null,
        };
        states.set(spaceId, state);
    }
    return state;
}

/** Forgets every password read for a Space other than `spaceId`, as the Mac clears its sensitive state. */
function clearOthers(spaceId: string): void {
    for (const [id, state] of states) {
        if (id === spaceId) continue;
        if (state.detail?.hideTimer) clearTimeout(state.detail.hideTimer);
        states.delete(id);
    }
}

// MARK: - Loading

async function load(context: SettingsContext, space: Space): Promise<void> {
    const workspace = context.workspace();
    const state = stateOf(space.state.id);
    if (!workspace || state.isLoading) return;
    state.isLoading = true;
    state.errorMessage = null;
    try {
        const inventory = await CredentialStore.shared.inventory(workspace, space.state.id);
        state.descriptors = inventory.descriptors;
        state.unreadableCount = inventory.unreadableCount;
        state.selected = new Set([...state.selected].filter((id) => inventory.descriptors.some((descriptor) => descriptor.id === id)));
    } catch (error) {
        console.error(error);
        state.descriptors = [];
        state.unreadableCount = 0;
        state.errorMessage = "Crest couldn’t read this Space’s passwords.";
    }
    state.isLoading = false;
    context.redraw();
}

// MARK: - Settings words (CredentialDescriptor+Settings)

function scopeLabel(scope: CredentialScope): string | null {
    if (scope.kind === "webForm") return null;
    const kind = scope.kind === "httpBasic" ? "HTTP Basic" : "HTTP Digest";
    return scope.realm ? `${kind} · ${scope.realm}` : kind;
}

function contains(text: string | null, query: string): boolean {
    return text !== null && text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/** The passwords a settings query finds, by site, then account, then identity. */
function matching(descriptors: readonly CredentialDescriptor[], searchText: string): CredentialDescriptor[] {
    const query = searchText.trim();
    const found = query
        ? descriptors.filter(
              (descriptor) =>
                  contains(descriptor.username, query) ||
                  contains(originDescription(descriptor.origin), query) ||
                  contains(descriptor.displayName, query) ||
                  contains(scopeLabel(descriptor.scope), query),
          )
        : [...descriptors];
    const compare = (left: string, right: string): number => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
    return found.sort(
        (left, right) =>
            compare(left.origin.host, right.origin.host) ||
            compare(left.username, right.username) ||
            (left.id.toUpperCase() < right.id.toUpperCase() ? -1 : 1),
    );
}

function deletionMessage(descriptor: CredentialDescriptor, spaceName: string): string {
    const scope = scopeLabel(descriptor.scope);
    const scoped = scope ? ` (${scope})` : "";
    return `Delete ${descriptor.username}’s password for ${originDescription(descriptor.origin)}${scoped} from ${spaceName}? This cannot be undone.`;
}

// MARK: - Pages

/** The Passwords page: each Space's saved passwords, one page of that Space. */
export function passwordsPage(context: SettingsContext): (HTMLElement | null)[] {
    const workspace = context.workspace();
    if (!workspace) return [];
    const rows = new SpaceGroups(workspace).available.map((space) => {
        const node = element("button", "settings-row settings-link");
        node.type = "button";
        node.dataset.space = space.state.id;
        node.append(
            identityIcon(space.state.settings.look, space.state.settings.symbol, 22),
            element("span", "settings-row-title", space.state.settings.name),
            element("span", "settings-spacer"),
        );
        const chevron = element("span", "settings-chevron");
        chevron.innerHTML = sfSymbol("chevron.right", 12);
        node.append(chevron);
        node.addEventListener("click", () => context.go({ kind: "space", spaceId: space.state.id, section: "passwords" }));
        return node;
    });
    // TODO(linux): the Mac's System passkeys section, which hands passkeys to
    // the system's own; Linux has no system passkey store to hand them to.
    return [group("Spaces", rows, { footer: "Each Space keeps its own passwords." })];
}

/** A Space page's Passwords section. */
export function passwordsSection(context: SettingsContext, space: Space): (HTMLElement | null)[] {
    const workspace = context.workspace();
    if (!workspace) return [];
    const spaceId = space.state.id;
    const state = stateOf(spaceId);
    if (loadedSpace !== spaceId) {
        loadedSpace = spaceId;
        clearOthers(spaceId);
        void load(context, space);
    }
    const preferences = space.state.settings.credentialPreferences;
    if (state.detail && state.detail.descriptor.spaceID !== spaceId &&
        !CredentialStore.shared.vaults(workspace, space).includes(state.detail.descriptor.spaceID)) {
        state.detail = null;
    }
    if (state.detail) return detailView(context, space, state, state.detail);

    const enabled = toggle(preferences.isEnabled, (isEnabled) =>
        void context.send({
            kind: "SetCredentialPreferences",
            value: { workspaceId: workspace.id, spaceId, preferences: { ...preferences, isEnabled } },
        }),
    );
    // TODO(linux): the Mac's Sync with iCloud Keychain and Offer a copy to
    // Passwords, which Linux has no counterpart for.
    const parts: (HTMLElement | null)[] = [
        group("Crest Passwords", [row("Use Crest Passwords", enabled)], {
            footer: preferences.isEnabled ? undefined : disabledDescription,
        }),
        savedPasswords(context, space, state),
    ];
    if (state.errorMessage) {
        const message = element("p", "settings-row-detail warning");
        message.innerHTML = sfSymbol("exclamationmark.triangle.fill", 12);
        message.append(` ${state.errorMessage}`);
        parts.push(group(null, [wideRow(message)]));
    }
    const groups = new SpaceGroups(workspace);
    if (groups.members(space).length > 1) {
        parts.push(group(null, [], { footer: `Shared by ${groups.primary(space).state.settings.name}’s Sub-Spaces.` }));
    }
    return parts;
}

// MARK: - Saved passwords

function savedPasswords(context: SettingsContext, space: Space, state: PasswordsState): HTMLElement {
    const rows: (HTMLElement | null)[] = [];
    if (state.descriptors.length > 0 || state.searchText) {
        const search = element("input", "settings-field");
        search.type = "search";
        search.placeholder = "Search saved passwords";
        search.value = state.searchText;
        search.setAttribute("aria-label", "Search saved passwords");
        search.addEventListener("input", () => {
            state.searchText = search.value;
            context.redraw();
        });
        rows.push(wideRow(search));
    }
    // TODO(linux): Import Passwords… and Export Passwords…, which read and
    // write a CSV file through the core (CredentialImportPreview,
    // CredentialExport) once the shell offers a file picker and save dialog.
    if (state.descriptors.length > 0) {
        const select = button(state.isSelecting ? "Done" : "Select", () => {
            state.isSelecting = !state.isSelecting;
            if (!state.isSelecting) state.selected.clear();
            context.redraw();
        }, "plain", state.deleting.size > 0);
        const toolbar = element("div", "settings-toolbar");
        toolbar.append(element("span", "settings-spacer"), select);
        rows.push(wideRow(toolbar));
        if (state.isSelecting) {
            const shown = matching(state.descriptors, state.searchText);
            const actions = element("div", "settings-toolbar");
            actions.append(
                button("Select All", () => {
                    state.selected = new Set(shown.map((descriptor) => descriptor.id));
                    context.redraw();
                }, "plain", shown.length === 0),
                button("Delete Selected", () => confirmSelectionDeletion(context, space, state), "destructive", state.selected.size === 0 || state.deleting.size > 0),
            );
            rows.push(wideRow(actions));
        }
    }
    const descriptors = matching(state.descriptors, state.searchText);
    if (state.isLoading && state.descriptors.length === 0) {
        rows.push(wideRow(element("span", "settings-row-detail", "Reading this Space’s passwords…")));
    } else if (descriptors.length === 0) {
        // Passwords that can't be read have their own row, so the Space isn't
        // called empty above it.
        if (state.searchText || state.unreadableCount === 0) {
            rows.push(wideRow(element("span", "settings-row-detail", state.searchText ? "No matches" : "No saved passwords")));
        }
    } else {
        rows.push(...descriptors.map((descriptor) => descriptorRow(context, space, state, descriptor)));
    }
    if (state.unreadableCount > 0) {
        const label = element("span", "settings-row-detail");
        label.innerHTML = sfSymbol("exclamationmark.triangle", 12);
        label.append(
            state.unreadableCount === 1 ? " 1 saved password can’t be read" : ` ${state.unreadableCount} saved passwords can’t be read`,
        );
        const toolbar = element("div", "settings-toolbar");
        toolbar.append(label, element("span", "settings-spacer"), button("Remove…", () => confirmUnreadableRemoval(context, space), "destructive"));
        rows.push(wideRow(toolbar));
    }
    const count = state.descriptors.length;
    return group("Saved passwords", rows, {
        footer: count === 0 ? undefined : count === 1 ? "1 password" : `${count} passwords`,
    });
}

/** One saved password (BrowserPasswordDescriptorRow). */
function descriptorRow(context: SettingsContext, space: Space, state: PasswordsState, descriptor: CredentialDescriptor): HTMLElement {
    const isDeleting = state.deleting.has(descriptor.id);
    const isSelected = state.selected.has(descriptor.id);
    const node = element("div", "settings-row settings-password-row");
    const main = element("button", "settings-link settings-password-main");
    main.type = "button";
    main.disabled = isDeleting;
    const icon = element("span", "settings-password-icon");
    icon.innerHTML = sfSymbol(state.isSelecting ? (isSelected ? "checkmark.circle.fill" : "circle") : "key.fill", 15);
    const label = element("span", "settings-row-label");
    const account = descriptor.username || "No username";
    label.append(
        element("span", "settings-row-title", descriptor.displayName ?? descriptor.origin.host),
        element(
            "span",
            "settings-row-detail",
            descriptor.displayName === null ? `${account} · ${originDescription(descriptor.origin)}` : `${account} · ${descriptor.origin.host}`,
        ),
    );
    const scope = scopeLabel(descriptor.scope);
    if (scope) label.append(element("span", "settings-row-detail", scope));
    main.append(icon, label, element("span", "settings-spacer"));
    if (!isSecureOrigin(descriptor.origin)) {
        const insecure = element("span", "settings-password-status");
        insecure.innerHTML = sfSymbol("exclamationmark.shield.fill", 13);
        insecure.title = "Imported from an insecure HTTP site. Crest keeps it available for manual access but does not autofill it on insecure connections.";
        insecure.setAttribute("aria-label", "Manual access only for insecure HTTP site");
        main.append(insecure);
    }
    if (!state.isSelecting && !isDeleting) {
        const chevron = element("span", "settings-chevron");
        chevron.innerHTML = sfSymbol("chevron.forward", 12);
        main.append(chevron);
    }
    main.addEventListener("click", () => {
        if (state.isSelecting) {
            if (!state.selected.delete(descriptor.id)) state.selected.add(descriptor.id);
            context.redraw();
        } else {
            openDetail(context, state, descriptor);
        }
    });
    node.append(main);
    if (isDeleting) {
        node.append(element("span", "settings-row-detail", "Deleting…"));
    } else if (!state.isSelecting) {
        node.append(
            glyphButton("ellipsis.circle", "Password Actions", (anchor) =>
                Menu.open(
                    [
                        { title: "View Password", icon: { kind: "symbol", name: "eye" }, action: () => openDetail(context, state, descriptor) },
                        "separator",
                        {
                            title: "Delete Password",
                            icon: { kind: "symbol", name: "trash" },
                            destructive: true,
                            action: () => confirmDeletion(context, space, state, descriptor),
                        },
                    ],
                    { anchor: anchor.getBoundingClientRect() },
                ),
            ),
        );
    }
    return node;
}

// MARK: - Deleting

function confirmDeletion(context: SettingsContext, space: Space, state: PasswordsState, descriptor: CredentialDescriptor): void {
    showAlert({
        title: "Delete Password?",
        message: deletionMessage(descriptor, space.state.settings.name),
        buttons: [
            { title: "Delete", role: "destructive", action: () => void deleteDescriptors(context, space, state, [descriptor.id]) },
            { title: "Cancel", role: "cancel" },
        ],
    });
}

function confirmSelectionDeletion(context: SettingsContext, space: Space, state: PasswordsState): void {
    const count = state.selected.size;
    const ids = [...state.selected];
    showAlert({
        title: "Delete Selected Passwords?",
        message: `Delete ${count} selected ${count === 1 ? "password" : "passwords"} from ${space.state.settings.name}? This cannot be undone.`,
        buttons: [
            {
                title: count === 1 ? "Delete 1 Password" : `Delete ${count} Passwords`,
                role: "destructive",
                action: () => {
                    state.isSelecting = false;
                    state.selected.clear();
                    void deleteDescriptors(context, space, state, ids);
                },
            },
            { title: "Cancel", role: "cancel" },
        ],
    });
}

async function deleteDescriptors(context: SettingsContext, space: Space, state: PasswordsState, ids: readonly string[]): Promise<void> {
    const workspace = context.workspace();
    if (!workspace) return;
    for (const id of ids) state.deleting.add(id);
    context.redraw();
    try {
        for (const id of ids) await CredentialStore.shared.delete(workspace, space.state.id, id);
    } catch (error) {
        console.error(error);
        state.errorMessage = "Crest couldn’t delete that password.";
    }
    for (const id of ids) state.deleting.delete(id);
    await load(context, space);
}

function confirmUnreadableRemoval(context: SettingsContext, space: Space): void {
    showAlert({
        title: "Remove Passwords Crest Can’t Read?",
        message: "Crest can’t show or fill them. This cannot be undone.",
        buttons: [
            {
                title: "Remove",
                role: "destructive",
                action: () => {
                    const workspace = context.workspace();
                    if (!workspace) return;
                    void CredentialStore.shared
                        .deleteUnreadable(workspace, space.state.id)
                        .catch((error: unknown) => {
                            console.error(error);
                            stateOf(space.state.id).errorMessage = "Crest couldn’t remove the passwords it can’t read.";
                        })
                        .then(() => load(context, space));
                },
            },
            { title: "Cancel", role: "cancel" },
        ],
    });
}

// MARK: - Detail

function openDetail(context: SettingsContext, state: PasswordsState, descriptor: CredentialDescriptor): void {
    state.detail = { descriptor, visiblePassword: null, isReading: false, showsCopyConfirmation: false, errorMessage: null, hideTimer: null };
    context.redraw();
}

function closeDetail(context: SettingsContext, state: PasswordsState): void {
    if (state.detail?.hideTimer) clearTimeout(state.detail.hideTimer);
    state.detail = null;
    context.redraw();
}

/** The password, read fresh from the Secret Service for each reveal or copy. */
async function readPassword(context: SettingsContext, space: Space, detail: DetailState): Promise<string | null> {
    const workspace = context.workspace();
    if (!workspace) return null;
    detail.isReading = true;
    detail.errorMessage = null;
    context.redraw();
    try {
        const credential = await CredentialStore.shared.credential(workspace, space.state.id, detail.descriptor.id);
        if (!credential) detail.errorMessage = "That password is no longer available.";
        return credential?.password ?? null;
    } catch (error) {
        console.error(error);
        detail.errorMessage = "Crest couldn’t read that password from this Space.";
        return null;
    } finally {
        detail.isReading = false;
    }
}

async function toggleReveal(context: SettingsContext, space: Space, detail: DetailState): Promise<void> {
    if (detail.visiblePassword !== null) {
        detail.visiblePassword = null;
        if (detail.hideTimer) clearTimeout(detail.hideTimer);
        detail.hideTimer = null;
        context.redraw();
        return;
    }
    const password = await readPassword(context, space, detail);
    detail.visiblePassword = password;
    if (password !== null) {
        if (detail.hideTimer) clearTimeout(detail.hideTimer);
        detail.hideTimer = window.setTimeout(() => {
            detail.visiblePassword = null;
            detail.hideTimer = null;
            context.redraw();
        }, revealLifetime);
    }
    context.redraw();
}

async function copy(context: SettingsContext, space: Space, detail: DetailState): Promise<void> {
    const password = await readPassword(context, space, detail);
    if (password === null) {
        context.redraw();
        return;
    }
    const copied = await copyPassword(password, clipboardLifetime).catch(() => false);
    detail.showsCopyConfirmation = copied;
    if (!copied) detail.errorMessage = "Crest couldn’t copy that password.";
    context.redraw();
}

/** A password open in place of the list (BrowserCredentialDetailContent). */
function detailView(context: SettingsContext, space: Space, state: PasswordsState, detail: DetailState): (HTMLElement | null)[] {
    const { descriptor } = detail;
    const owner = context.workspace()?.spaces.get(descriptor.spaceID) ?? space;
    const value = (title: string, text: string): HTMLElement => row(title, element("span", "settings-row-value", text));
    const scope = scopeLabel(descriptor.scope);
    const back = button("Done", () => closeDetail(context, state), "prominent");
    back.classList.add("small");
    const passwordValue = element("span", "settings-row-value settings-password-value", detail.visiblePassword ?? "••••••••••••");
    passwordValue.setAttribute("aria-label", detail.visiblePassword === null ? "Password hidden" : "Password visible");
    if (detail.visiblePassword !== null) passwordValue.classList.add("selectable");
    const actions = element("div", "settings-toolbar");
    actions.append(
        button(detail.visiblePassword === null ? "Reveal Password" : "Hide Password", () => void toggleReveal(context, space, detail), "plain", detail.isReading),
        button("Copy Password", () => void copy(context, space, detail), "plain", detail.isReading),
    );
    const passwordRows: HTMLElement[] = [wideRow(passwordValue), wideRow(actions)];
    if (detail.showsCopyConfirmation) {
        const confirmation = element("span", "settings-row-detail");
        confirmation.innerHTML = sfSymbol("checkmark.circle.fill", 12);
        confirmation.append(" Copied locally for 60 seconds");
        passwordRows.push(wideRow(confirmation));
    }
    if (detail.errorMessage) {
        const message = element("span", "settings-row-detail warning");
        message.innerHTML = sfSymbol("exclamationmark.triangle.fill", 12);
        message.append(` ${detail.errorMessage}`);
        passwordRows.push(wideRow(message));
    }
    return [
        group(
            "Account",
            [
                value("Website", originDescription(descriptor.origin)),
                value("Username", descriptor.username),
                scope ? value("Type", scope) : null,
                value("Space", owner.state.settings.name),
            ],
            {
                accessory: back,
                footer: isSecureOrigin(descriptor.origin)
                    ? undefined
                    : "This password was imported from an insecure HTTP site. Crest keeps it available to view or copy but will not autofill it on an insecure connection.",
            },
        ),
        group("Password", passwordRows, {
            footer: "The desktop’s keyring may ask to be unlocked before Crest reads a password. A revealed password hides after 30 seconds; a copied password expires after 60 seconds.",
        }),
    ];
}

/** Forgets every password the section read, as the Mac does when Settings leaves the Space. */
export function forgetPasswords(): void {
    clearOthers("");
    loadedSpace = null;
}
