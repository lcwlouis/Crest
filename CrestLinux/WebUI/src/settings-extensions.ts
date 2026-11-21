// Settings' Extensions page and a Space page's Extensions section, as the
// Mac's BrowserExtensionSettingsPane draws them: a Space picker on the page,
// the Space's installed extensions (each a disclosure row with its icon,
// name, version, description and Enabled switch, and inside it a copy into
// other Spaces, its permissions, Chromium's page for it, its settings and
// its removal), and the Chrome Web Store, Chromium's extension manager and
// its shortcuts. What a Space has and whether it may change are the core's;
// every change goes through the store (extensions.ts).

import type { Guid, InstalledExtension } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { iconView, spaceChoice } from "./extension-install.js";
import { ExtensionCommand, ExtensionStore } from "./extensions.js";
import type { Space } from "./model.js";
import { holdOverlay } from "./overlay.js";
import type { SettingsContext } from "./settings.js";
import { button, element, group, note, picker, row, toggle } from "./settings-form.js";
import { SpaceGroups } from "./space-groups.js";
import { sfSymbol } from "./symbols.js";

/** The Space the page shows, once the person picked one. */
let pickedSpace: Guid | null = null;
/** The rows the person opened, by extension. */
const expanded = new Set<string>();

function byName(a: InstalledExtension, b: InstalledExtension): number {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/** Settings' Extensions page: a Space picker over the picked Space's extensions. */
export function extensionsPage(context: SettingsContext): (HTMLElement | null)[] {
    const workspace = context.workspace();
    if (!workspace) return [];
    const spaces = new SpaceGroups(workspace).available;
    const shown = context.model.windows.get(context.windowId())?.shownSpaceId ?? null;
    if (!pickedSpace || !spaces.some((space) => space.state.id === pickedSpace)) pickedSpace = shown;
    const space = spaces.find((candidate) => candidate.state.id === pickedSpace) ?? spaces[0];
    if (!space) return [];
    const choices = spaces.map((candidate) => ({ value: candidate.state.id, title: candidate.state.settings.name }));
    const spacePicker = picker(choices, space.state.id, (spaceId) => {
        pickedSpace = spaceId;
        context.redraw();
    });
    return [group(null, [row("Space", spacePicker)]), ...extensionsSection(context, space)];
}

/** A Space's Extensions: what it has installed, and where more come from. */
export function extensionsSection(context: SettingsContext, space: Space): (HTMLElement | null)[] {
    const store = ExtensionStore.current;
    if (!store) return [note("Extensions are unavailable in this window.")];
    store.prepare(space);
    const run = (command: ExtensionCommand, extensionId = ""): void => void store.command(command, extensionId, space);
    // TODO(linux): the Mac shows a locked Space's unlock section here, and
    // the note on a Space group sharing one profile
    // (BrowserSpaceGroupSharingNote); the core refuses a locked Space's
    // changes, and Linux has no Space unlock yet.
    const installed = store.installed(space);
    const changes = store.mayChange(space) === true;
    let rows: HTMLElement[];
    if (installed === null) {
        rows = [element("div", "settings-row extension-loading", "Loading…")];
    } else if (installed.length === 0) {
        rows = [element("div", "settings-row settings-row-detail", "No extensions")];
    } else {
        rows = [...installed].sort(byName).flatMap((item) => extensionRows(context, store, space, item, changes));
    }
    const add = element("div", "settings-row wide extension-add-row");
    add.append(
        button("Open Chrome Web Store", () => run(ExtensionCommand.store)),
        button("Chromium Extension Manager", () => run(ExtensionCommand.manage)),
        element("span", "settings-spacer"),
        // Extension shortcuts are the engine's own bindings: Crest routes an
        // unclaimed key to them but does not own their list.
        button("Shortcuts…", () => run(ExtensionCommand.shortcuts)),
    );
    return [group("Installed", rows), group("Add extensions", [add])];
}

/** One extension's disclosure row, and what it holds while open (BrowserExtensionRow). */
function extensionRows(context: SettingsContext, store: ExtensionStore, space: Space, item: InstalledExtension, spaceChanges: boolean): HTMLElement[] {
    const open = expanded.has(item.id);
    const node = element("div", "settings-row extension-row");
    const disclosure = element("button", open ? "settings-disclosure open" : "settings-disclosure");
    disclosure.type = "button";
    disclosure.innerHTML = sfSymbol("chevron.right", 11);
    disclosure.setAttribute("aria-label", `${item.name} details`);
    disclosure.setAttribute("aria-expanded", String(open));
    disclosure.addEventListener("click", () => {
        if (open) expanded.delete(item.id);
        else expanded.add(item.id);
        context.redraw();
    });
    const label = element("div", "settings-row-label");
    const title = element("span", "settings-row-title extension-row-title");
    title.append(element("span", "", item.name), element("span", "extension-row-version", item.version));
    label.append(title);
    if (item.description) label.append(element("span", "settings-row-detail extension-row-description", item.description));
    if (item.fromWebStore) label.append(element("span", "extension-row-source", "From Chrome Web Store"));
    const enabled = toggle(item.enabled, (isOn) => void store.command(isOn ? ExtensionCommand.enable : ExtensionCommand.disable, item.id, space), !item.changeable || !spaceChanges);
    enabled.setAttribute("aria-label", `${item.name} Enabled`);
    enabled.classList.add("settings-control");
    node.append(disclosure, iconView(store.icon(item.id, space), 28), label, enabled);
    if (!open) return [node];

    const detail = element("div", "settings-row extension-row-detail");
    const actions: HTMLElement[] = [];
    if (item.fromWebStore && spaceChanges) actions.push(button("Install a copy in other spaces", () => showCopySheet(store, space, item)));
    if (item.permissions.length > 0) {
        const permissions = element("div", "extension-permissions");
        permissions.append(element("h4", "", "Permissions and Website Access"));
        for (const permission of item.permissions) permissions.append(element("p", "", permission));
        actions.push(permissions);
    }
    actions.push(labelledButton("Manage Permissions in Chromium", "hand.raised", () => void store.command(ExtensionCommand.details, item.id, space)));
    if (item.optionsUrl && item.enabled) actions.push(labelledButton("Extension Settings", "gearshape", () => void store.command(ExtensionCommand.options, item.id, space)));
    if (item.changeable && spaceChanges) {
        const remove = labelledButton("Remove Extension", "trash", () => confirmRemoval(store, space, item));
        remove.classList.add("destructive");
        actions.push(remove);
    }
    detail.append(...actions);
    return [node, detail];
}

function labelledButton(title: string, symbol: string, action: () => void): HTMLButtonElement {
    const node = button("", action);
    node.classList.add("extension-labelled-button");
    node.innerHTML = sfSymbol(symbol, 12);
    node.append(element("span", "", title));
    return node;
}

/** The pane's own removal question (its confirmationDialog). */
function confirmRemoval(store: ExtensionStore, space: Space, item: InstalledExtension): void {
    showAlert({
        title: "Remove Extension?",
        message: store.sharesProfile(space)
            ? `${item.name} and its data are removed from every Space in this group.`
            : `${item.name} and its data are removed from this Space only.`,
        buttons: [
            {
                title: `Remove from ${space.state.settings.name}`,
                role: "destructive",
                action: () => void store.command(ExtensionCommand.remove, item.id, space),
            },
            { title: "Cancel", role: "cancel" },
        ],
    });
}

// MARK: - The copy sheet

/** How often and how many times the sheet asks again while the core still lists some Space. */
const destinationRetry = { delay: 400, attempts: 10 } as const;

/**
 * The sheet that installs a copy of `item` in other Spaces
 * (BrowserExtensionCopySheet): the Spaces the core says a copy may go to,
 * then the review of the first, with the rest as its copies.
 */
function showCopySheet(store: ExtensionStore, space: Space, item: InstalledExtension): void {
    const release = holdOverlay();
    const layer = element("div", "alert-layer");
    const sheet = element("div", "extension-review extension-copy-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    layer.append(sheet);
    document.body.append(layer);
    const selection = new Set<Guid>();
    let destinations: Space[] = [];
    let listed = false;
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        window.removeEventListener("keydown", onKey, true);
        layer.remove();
        release();
    };
    const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        }
        event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);

    const draw = (): void => {
        if (closed) return;
        const list = element("div", "extension-space-list");
        for (const destination of destinations) {
            const choice = spaceChoice(destination, selection, draw);
            choice.querySelector("input")!.disabled = !listed;
            list.append(choice);
        }
        if (listed && destinations.length === 0) list.append(element("p", "extension-review-secondary", "No other Spaces can take a copy."));
        const buttons = element("div", "extension-review-buttons");
        const cancel = button("Cancel", close);
        const targets = destinations.filter((destination) => selection.has(destination.state.id));
        const review = button(
            "Review Installation",
            () => {
                const [first, ...rest] = targets;
                if (!first) return;
                close();
                window.setTimeout(() => store.beginInstall(item.id, first, rest.map((target) => target.state.id)));
            },
            "prominent",
            !listed || targets.length === 0,
        );
        buttons.append(cancel, element("span", "settings-spacer"));
        if (!listed) buttons.append(element("span", "extension-review-spinner"));
        buttons.append(review);
        sheet.replaceChildren(
            element("h2", "extension-review-title large", "Install a Copy in Other Spaces"),
            element("h3", "extension-copy-name", item.name),
            element(
                "p",
                "extension-review-secondary",
                "Each Space keeps its own extension data; existing data is not copied. Review the verified package and permissions before installing.",
            ),
            list,
            buttons,
        );
    };

    // The core hears what each Space has once the engine listed its profile.
    for (const target of store.spaces) store.load(target);
    const ask = async (attempt: number): Promise<void> => {
        const answer = await store.destinations(item.id, space);
        destinations = answer.spaces;
        listed = answer.listed;
        draw();
        if (!listed && !closed && attempt < destinationRetry.attempts) window.setTimeout(() => void ask(attempt + 1), destinationRetry.delay);
    };
    draw();
    void ask(0);
}
