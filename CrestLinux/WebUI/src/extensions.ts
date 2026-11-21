// The extensions Chromium keeps for the person's Spaces, as the Mac's
// ChromiumExtensionStore presents them: what each Space has installed, the
// actions a page's controls and a Space's pinned row offer, the menus, the
// removal confirmation and the install review. Which Spaces may change, where
// a copy may go and which consent answers a later question are the core's:
// every change and install is an intent the core checks first, and what each
// Space has comes from the changes the core publishes. The engine answers the
// actions and icons directly (PinnedExtensions, PageExtensions,
// ExtensionIcons), and the window's host runs them (crest_extensions_linux).

import { textsOfRejection } from "../generated/crest_contracts.js";
import type {
    Change,
    EnginePresentation,
    ExtensionAction,
    ExtensionChange,
    ExtensionInstallAsked,
    ExtensionInstallState,
    Guid,
    InstalledExtension,
    Intent,
    PageState,
} from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { dispatch, listenToExtensions, pageRequest, query, Refused, runExtension, setExtensionAnchors } from "./bridge.js";
import type { ExtensionAnchor } from "./bridge.js";
import { InstallReview } from "./extension-install.js";
import { ExtensionSidePanels } from "./extension-side-panel.js";
import { Menu } from "./menu.js";
import type { MenuEntry } from "./menu.js";
import type { Model, Space } from "./model.js";
import { postNotice } from "./notices.js";
import { SpaceGroups } from "./space-groups.js";

// MARK: - Types

/** An extension's action as a control shows it (BrowserExtensionActionPresentation). */
export interface ExtensionActionPresentation {
    readonly id: string;
    readonly displayName: string;
    readonly badgeText: string;
    /** The icon, as an address an image can show, or null for the fallback glyph. */
    readonly icon: string | null;
    readonly isEnabled: boolean;
    readonly isPinned: boolean;
}

/** An image address for an icon the engine encoded, or null for none. */
export function extensionIconUrl(bytes: Uint8Array | null): string | null {
    if (!bytes || bytes.length === 0) return null;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:image/png;base64,${btoa(binary)}`;
}

function presentation(action: ExtensionAction): ExtensionActionPresentation {
    return {
        id: action.id,
        displayName: action.name,
        badgeText: action.badge,
        icon: extensionIconUrl(action.icon),
        isEnabled: action.enabled,
        isPinned: action.pinned,
    };
}

function byName(a: ExtensionActionPresentation, b: ExtensionActionPresentation): number {
    return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Something a person asks of a Space's extensions: to open one of the
 * engine's own pages or the Chrome Web Store, or to change one extension
 * (the Mac's ExtensionCommand). Each command carries what it does.
 */
export class ExtensionCommand {
    // MARK: - Static Variables

    /** The Chrome Web Store, at the extension's listing when one is named. */
    static readonly store = new ExtensionCommand((extensionId) =>
        extensionId ? `https://chromewebstore.google.com/detail/${extensionId}` : "https://chromewebstore.google.com/",
    );
    /** Chromium's extension manager. */
    static readonly manage = new ExtensionCommand(() => "chrome://extensions/");
    /** The keyboard shortcuts the engine binds to extensions. */
    static readonly shortcuts = new ExtensionCommand(() => "chrome://extensions/shortcuts");
    /** The extension's page in Chromium's extension manager. */
    static readonly details = new ExtensionCommand((extensionId) => `chrome://extensions/?id=${extensionId}`);
    /** The extension's own settings page, when it has one. */
    static readonly options = new ExtensionCommand((_extensionId, options) => options || null);
    static readonly enable = new ExtensionCommand(() => null, "Enable");
    static readonly disable = new ExtensionCommand(() => null, "Disable");
    static readonly remove = new ExtensionCommand(() => null, "Remove");
    static readonly pin = new ExtensionCommand(() => null, "Pin");
    static readonly unpin = new ExtensionCommand(() => null, "Unpin");

    // MARK: - Variables

    /** The address the command opens for the extension it names, given its settings page; null when it opens nothing. */
    readonly destination: (extensionId: string, options: string | null) => string | null;
    /** The change the command makes to the extension, when it opens nothing. */
    readonly change: ExtensionChange | null;

    // MARK: - Initializers

    private constructor(destination: (extensionId: string, options: string | null) => string | null, change: ExtensionChange | null = null) {
        this.destination = destination;
        this.change = change;
    }
}

/** What the store reads of the window it serves. */
export interface ExtensionsHost {
    readonly model: Model;
    readonly windowId: () => Guid;
    /** The Space the window shows. */
    readonly space: () => Space | undefined;
    /** The page the window shows. */
    readonly page: () => PageState | undefined;
    /** Whether the window shows the page `pageId` in one of its cards. */
    readonly showsPage: (pageId: Guid) => boolean;
    /** Opens Settings' Extensions section of the Space `spaceId`. */
    readonly openSettings: (spaceId: Guid) => void;
    /** Draws what shows extensions again. */
    readonly redraw: () => void;
}

/** The shortest time between two refreshes of one Space's actions, as the Mac's refreshInterval. */
const refreshInterval = 250;
/** A click this soon after its control's popup closed is the click that closed it. */
const dismissingClick = 400;
/** Where the engine's own pages are named in Crest's address namespace (ChromiumInternalURL). */
const engineScheme = "chrome://";
const crestScheme = "crest://";

/** An engine page's address in Crest's spelling; web and extension addresses stay as they are. */
function presented(address: string): string {
    return address.toLowerCase().startsWith(engineScheme) ? crestScheme + address.slice(engineScheme.length) : address;
}

// MARK: - The store

export class ExtensionStore {
    // MARK: - Static Variables

    /** The window's store, which Settings and Site Controls show. */
    static current: ExtensionStore | null = null;

    // MARK: - Variables

    readonly host: ExtensionsHost;
    readonly sidePanels: ExtensionSidePanels;
    /** Each profile's installed extensions, as the core last listed them. */
    private readonly installedByProfile = new Map<Guid, readonly InstalledExtension[]>();
    /** The installs the core runs, as it last published them. */
    private readonly installs = new Map<Guid, ExtensionInstallState>();
    /** Each profile's extension icons, as the engine last answered them. */
    private readonly icons = new Map<Guid, ReadonlyMap<string, string>>();
    private readonly iconsAsked = new Set<Guid>();
    /** Whether the core lets each Space's extensions change, as it last answered. */
    private readonly permissions = new Map<Guid, boolean>();
    private readonly permissionsAsked = new Set<Guid>();
    /** Each profile's pinned actions and each page's actions, as the engine last answered them. */
    private readonly pinned = new Map<Guid, readonly ExtensionActionPresentation[]>();
    private readonly onPage = new Map<Guid, readonly ExtensionActionPresentation[]>();
    /** What was asked of the engine and not answered yet, so it is asked once. */
    private readonly asking = new Set<string>();
    /** Profiles whose actions changed while a refresh was too recent. */
    private readonly pendingRefreshes = new Set<Guid>();
    private refreshWindow = 0;
    /** When each extension's popup last closed on its own. */
    private readonly popupClosedAt = new Map<string, number>();
    /** The controls a popup an extension opens itself hangs from, by extension. */
    private readonly anchors = new Map<string, ExtensionAnchor>();
    private sentAnchors = "";
    private review: InstallReview | null = null;

    // MARK: - Initializers

    constructor(host: ExtensionsHost) {
        this.host = host;
        this.sidePanels = new ExtensionSidePanels(this);
        ExtensionStore.current = this;
        listenToExtensions({
            popupClosed: (extensionId) => this.popupClosedAt.set(extensionId, performance.now()),
            sidePanelClosed: (pageId, extensionId) => this.sidePanels.dismiss(extensionId, pageId),
            actionKey: (extensionId) => this.runFromKey(extensionId),
        });
    }

    // MARK: - Actions - Following the core

    /** Follows a batch of the core's changes. */
    apply(changes: readonly Change[]): void {
        let changed = false;
        for (const change of changes) {
            switch (change.kind) {
                case "InstalledExtensionsChanged":
                    if (change.value.engine !== "Chromium") break;
                    this.installedByProfile.set(change.value.profileId, change.value.extensions);
                    this.icons.delete(change.value.profileId);
                    this.iconsAsked.delete(change.value.profileId);
                    changed = true;
                    break;
                case "ExtensionInstallChanged":
                    this.installs.set(change.value.install.installId, change.value.install);
                    this.review?.refresh();
                    break;
                case "ExtensionInstallAsked":
                    this.ask(change.value);
                    break;
                case "SpacesChanged":
                case "SpaceSettingsChanged":
                case "SpaceLockChanged":
                    // Whether a Space may change follows its lock and its deletion.
                    this.permissions.clear();
                    this.permissionsAsked.clear();
                    changed = true;
                    break;
                default:
                    break;
            }
        }
        this.sidePanels.follow();
        if (changed) this.host.redraw();
    }

    /** Follows one of the engine's presentations. */
    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "ExtensionsChanged":
                this.refresh(presentation.value.profileId);
                break;
            case "ExtensionDownloadProgressed":
                if (this.review?.installId === presentation.value.installId) this.review.downloaded(presentation.value.fraction);
                break;
            case "SidePanelRequested":
                if (this.host.showsPage(presentation.value.pageId)) this.sidePanels.route(presentation.value);
                break;
            case "StoreInstallRequested":
                if (this.host.showsPage(presentation.value.pageId)) this.performStoreRequest(presentation.value.pageId, presentation.value.extensionId, false);
                break;
            case "StoreRemovalRequested":
                if (this.host.showsPage(presentation.value.pageId)) this.performStoreRequest(presentation.value.pageId, presentation.value.extensionId, true);
                break;
            default:
                break;
        }
    }

    /**
     * The engine changed something `profileId`'s Space shows. Refreshes that
     * Space at once when it was last refreshed longer ago than the interval,
     * and otherwise with every other change that arrives before it ends: a
     * blocker's count changes many times while a page loads.
     */
    private refresh(profileId: Guid): void {
        this.pendingRefreshes.add(profileId);
        if (this.refreshWindow) return;
        this.refreshPending();
    }

    private refreshPending(): void {
        if (this.pendingRefreshes.size === 0) {
            this.refreshWindow = 0;
            return;
        }
        for (const profileId of this.pendingRefreshes) {
            this.pinned.delete(profileId);
            this.icons.delete(profileId);
            this.iconsAsked.delete(profileId);
        }
        this.pendingRefreshes.clear();
        // A page's actions follow its profile's; each is asked again as it shows.
        this.onPage.clear();
        this.host.redraw();
        this.refreshWindow = window.setTimeout(() => this.refreshPending(), refreshInterval);
    }

    // MARK: - Actions - Spaces

    /** The person's own Spaces, in the order the window lists them. */
    get spaces(): Space[] {
        const workspace = this.host.model.workspace;
        return workspace ? new SpaceGroups(workspace).available : [];
    }

    space(spaceId: Guid): Space | undefined {
        return this.spaces.find((space) => space.state.id === spaceId);
    }

    /** Whether another Space browses with `space`'s profile, as a group's Spaces do, so a removal leaves them all. */
    sharesProfile(space: Space): boolean {
        return this.spaces.some((other) => other.state.id !== space.state.id && other.state.profileId === space.state.profileId);
    }

    /**
     * Whether the core lets `space`'s extensions change now; a locked Space's
     * and one being deleted do not. Null until the core answered, when what
     * shows it draws again.
     */
    mayChange(space: Space): boolean | null {
        const spaceId = space.state.id;
        const known = this.permissions.get(spaceId);
        if (known !== undefined) return known;
        if (!this.permissionsAsked.has(spaceId)) {
            this.permissionsAsked.add(spaceId);
            void this.askPermission(spaceId).then(() => this.host.redraw());
        }
        return null;
    }

    /** Asks the core whether `spaceId`'s extensions may change, and keeps its answer. */
    async askPermission(spaceId: Guid): Promise<boolean> {
        let allowed = false;
        try {
            const permission = await query("CanChangeExtensions", { spaceId, engine: "Chromium" });
            allowed = permission.refusal === null;
        } catch (error) {
            console.error(error);
        }
        this.permissions.set(spaceId, allowed);
        return allowed;
    }

    // MARK: - Actions - Listing

    /** The extensions the core lists for `space`'s profile, or null before the engine listed it. */
    installed(space: Space): readonly InstalledExtension[] | null {
        return this.installedByProfile.get(space.state.profileId) ?? null;
    }

    /** Whether the engine listed every profile a Space of the person's browses with. */
    installedRecord(extensionId: string, space: Space): InstalledExtension | undefined {
        return this.installed(space)?.find((item) => item.id === extensionId);
    }

    /** Asks the core to list `space`'s extensions, which the engine loads the Space's profile for. */
    load(space: Space): void {
        void this.send({ kind: "ListExtensions", value: { spaceId: space.state.id, engine: "Chromium" } }, false);
    }

    /** Makes sure `space`'s profile is listed, so its pinned row shows before anything opened in it. */
    prepare(space: Space): void {
        if (!this.installedByProfile.has(space.state.profileId)) this.load(space);
    }

    /** The icon of `extensionId` in `space`'s profile, asking the engine for the profile's icons once. */
    icon(extensionId: string, space: Space): string | null {
        const profileId = space.state.profileId;
        const icons = this.icons.get(profileId);
        if (icons) return icons.get(extensionId) ?? null;
        if (!this.iconsAsked.has(profileId)) {
            this.iconsAsked.add(profileId);
            void pageRequest("ExtensionIcons", { profileId })
                .then((answer) => {
                    const found = new Map<string, string>();
                    for (const icon of answer.icons) {
                        const url = extensionIconUrl(icon.image);
                        if (url && !found.has(icon.extensionId)) found.set(icon.extensionId, url);
                    }
                    this.icons.set(profileId, found);
                    this.host.redraw();
                })
                .catch((error: unknown) => console.error(error));
        }
        return null;
    }

    // MARK: - Actions - Toolbar

    /** The actions `page`'s controls offer, with each one's state for its tab; empty until the engine answered. */
    actions(page: PageState): readonly ExtensionActionPresentation[] {
        const held = this.onPage.get(page.id);
        if (held) return held;
        this.ask(`page:${page.id}`, async () => {
            const answer = await pageRequest("PageExtensions", { pageId: page.id });
            this.onPage.set(page.id, answer.actions.map(presentation).sort(byName));
        });
        return [];
    }

    /**
     * The pinned actions of a Space's own row. The row belongs to the Space,
     * so the list comes from the Space's profile whether or not a page is
     * open; where one is, its per-tab state (badge, icon) lies over it.
     */
    pinnedActions(space: Space, page: PageState | undefined): readonly ExtensionActionPresentation[] {
        const profileId = space.state.profileId;
        const pinned = this.pinned.get(profileId);
        if (!pinned) {
            this.ask(`pinned:${profileId}`, async () => {
                const answer = await pageRequest("PinnedExtensions", { profileId });
                this.pinned.set(profileId, answer.actions.map(presentation));
            });
            return [];
        }
        const live = new Map((page && page.spaceId === space.state.id ? this.actions(page) : []).map((action) => [action.id, action]));
        return pinned
            .map((action) => {
                const tab = live.get(action.id);
                return tab ? { ...tab, isPinned: true } : action;
            })
            .sort(byName);
    }

    /** Asks the engine once under `key`, and draws again with what it answered. */
    private ask(key: string, asking: () => Promise<void>): void;
    private ask(asked: ExtensionInstallAsked): void;
    private ask(key: string | ExtensionInstallAsked, asking?: () => Promise<void>): void {
        if (typeof key !== "string") {
            this.reviewAsked(key);
            return;
        }
        if (this.asking.has(key) || !asking) return;
        this.asking.add(key);
        void asking()
            .catch((error: unknown) => console.error(error))
            .finally(() => {
                this.asking.delete(key);
                this.host.redraw();
            });
    }

    /**
     * Runs `action` from its control at `anchor`: on the page the window
     * shows in `space`, or with none, from the Space, where only an action
     * with its own popup can run.
     */
    async run(action: Pick<ExtensionActionPresentation, "id">, anchor: ExtensionAnchor, space: Space): Promise<void> {
        // The click that closed the action's popup only closes it.
        const closedAt = this.popupClosedAt.get(action.id);
        if (closedAt !== undefined && performance.now() - closedAt < dismissingClick) return;
        const page = this.host.page();
        const onPage = page && page.spaceId === space.state.id ? page : undefined;
        let ran = false;
        try {
            ran = await runExtension(action.id, onPage?.id ?? null, onPage ? null : space.state.profileId, anchor);
        } catch (error) {
            console.error(error);
        }
        if (ran) return;
        postNotice({
            message: onPage ? "This extension action is unavailable on this page." : "This extension action needs an open page.",
            symbol: "puzzlepiece.extension",
            label: null,
        });
    }

    /** A key ran `extensionId`'s action: it runs from its pinned control, or from the window's fallback. */
    private runFromKey(extensionId: string): void {
        const space = this.host.space();
        const anchor = this.anchors.get(extensionId) ?? this.anchors.get("");
        if (!space || !anchor) return;
        void this.run({ id: extensionId }, anchor, space);
    }

    /**
     * Tells the window where each pinned control is, and the control every
     * other extension's popup opens from, as the Mac's toolbar anchor registry
     * and its Site Controls anchor do.
     */
    placeAnchors(anchors: ReadonlyMap<string, ExtensionAnchor>): void {
        this.anchors.clear();
        for (const [id, anchor] of anchors) this.anchors.set(id, anchor);
        const sent = JSON.stringify([...this.anchors]);
        if (sent === this.sentAnchors) return;
        this.sentAnchors = sent;
        setExtensionAnchors(this.anchors);
    }

    // MARK: - Actions - Commands

    /**
     * Runs `command` for `extensionId` in `space`: opens the page it names as
     * a tab of the Space in this window, or asks the core to make its change,
     * which says why when it refuses. False when nothing happened.
     */
    async command(command: ExtensionCommand, extensionId: string, space: Space): Promise<boolean> {
        const options = this.installedRecord(extensionId, space)?.optionsUrl ?? null;
        const destination = command.destination(extensionId, options);
        if (destination) return this.open(destination, space);
        if (!command.change) return false;
        return this.send({
            kind: "ChangeExtension",
            value: { spaceId: space.state.id, engine: "Chromium", extensionId, change: command.change },
        });
    }

    togglePin(action: ExtensionActionPresentation, space: Space): void {
        void this.command(action.isPinned ? ExtensionCommand.unpin : ExtensionCommand.pin, action.id, space);
    }

    /**
     * Opens `address` as a tab of `space` in this window. Settings and an
     * extension's options are the Space's own tabs even with no web page
     * open, so no opener is made up and no other Space is borrowed.
     */
    private async open(address: string, space: Space): Promise<boolean> {
        const workspace = this.host.model.workspace;
        if (!workspace) return false;
        const windowId = this.host.windowId();
        if (!(await this.send({ kind: "ShowSpace", value: { windowId, spaceId: space.state.id } }))) return false;
        return this.send({
            kind: "OpenTab",
            value: {
                workspaceId: workspace.id,
                windowId,
                spaceId: space.state.id,
                tabId: crypto.randomUUID(),
                content: { address: presented(address), view: null, title: null },
                placement: "Current",
                afterTabId: null,
                shows: true,
            },
        });
    }

    /** Sends `intent`; when the core refuses it, the person reads why, unless `reportsRefusal` is false. */
    async send(intent: Intent, reportsRefusal = true): Promise<boolean> {
        try {
            await dispatch(intent);
            return true;
        } catch (error) {
            if (reportsRefusal) this.reportRefusal(error);
            else console.error(error);
            return false;
        }
    }

    private reportRefusal(error: unknown): void {
        console.error(error);
        const message =
            error instanceof Refused
                ? textsOfRejection(error.rejection).message?.text
                : undefined;
        postNotice({
            message: message ?? "Couldn’t complete that extension action. Check its details for policy or permission requirements.",
            symbol: "exclamationmark.triangle",
            label: null,
        });
    }

    // MARK: - Actions - Menus

    /**
     * The menu of `action`'s control: its side panel, settings, pin, enable,
     * the engine's pages and removal, as the Mac's presentMenu offers them.
     * `closeSource` closes the surface the menu opened over, such as Site
     * Controls, before an item that leads somewhere else runs.
     */
    async presentMenu(action: ExtensionActionPresentation, space: Space, anchor: DOMRect, closeSource?: () => void): Promise<void> {
        const page = this.host.page();
        const record = this.installedRecord(action.id, space);
        // The core decides whether the Space's extensions may change; an
        // extension a policy manages offers no change either.
        const spaceChanges = await this.askPermission(space.state.id);
        const opensSettings = spaceChanges && (record ? Boolean(record.optionsUrl) && record.enabled : true);
        const changeable = spaceChanges && (record?.changeable ?? true);
        const sidePanel = page && page.spaceId === space.state.id ? await this.sidePanels.opener(action, page) : null;
        const leading = (perform: () => void) => () => {
            if (!closeSource) {
                perform();
                return;
            }
            closeSource();
            window.setTimeout(perform);
        };
        const entries: MenuEntry[] = [];
        if (sidePanel) entries.push({ title: "Open Side Panel", icon: { kind: "symbol", name: "sidebar.right" }, action: leading(sidePanel) }, "separator");
        if (opensSettings) {
            entries.push({
                title: "Extension Settings…",
                icon: { kind: "symbol", name: "gearshape" },
                action: leading(() => void this.command(ExtensionCommand.options, action.id, space)),
            });
        }
        if (changeable) {
            entries.push({
                title: action.isPinned ? "Unpin from Toolbar" : "Pin to Toolbar",
                icon: { kind: "symbol", name: action.isPinned ? "pin.slash" : "pin" },
                // The surface stays: the item changes what it shows.
                action: () => this.togglePin(action, space),
            });
            if (record) {
                entries.push({
                    title: record.enabled ? "Disable Extension" : "Enable Extension",
                    icon: { kind: "symbol", name: record.enabled ? "xmark.circle" : "checkmark.circle" },
                    action: leading(() => void this.command(record.enabled ? ExtensionCommand.disable : ExtensionCommand.enable, action.id, space)),
                });
            }
        }
        if (opensSettings || changeable) entries.push("separator");
        entries.push(
            {
                title: "Manage Extension…",
                icon: { kind: "symbol", name: "hand.raised" },
                action: leading(() => void this.command(ExtensionCommand.details, action.id, space)),
            },
            {
                title: "Manage Extensions…",
                icon: { kind: "symbol", name: "puzzlepiece.extension" },
                action: leading(() => void this.command(ExtensionCommand.manage, "", space)),
            },
        );
        if (record?.fromWebStore) {
            entries.push({
                title: "View on Chrome Web Store",
                icon: { kind: "symbol", name: "arrow.up.forward.square" },
                action: leading(() => void this.command(ExtensionCommand.store, action.id, space)),
            });
        }
        if (changeable && record) {
            entries.push("separator", {
                title: "Remove Extension…",
                icon: { kind: "symbol", name: "trash" },
                destructive: true,
                action: leading(() => this.confirmRemoval(record, space)),
            });
        }
        Menu.open(entries, { anchor });
    }

    /**
     * Asks before `record` goes from `space`, as the Mac's menu does, and
     * removes it when the person agrees. `completion` runs however it ended.
     */
    confirmRemoval(record: InstalledExtension, space: Space, completion?: () => void): void {
        const name = record.name || record.id;
        void this.askPermission(space.state.id).then((allowed) => {
            if (!allowed) {
                completion?.();
                return;
            }
            showAlert({
                title: `Remove ${name}?`,
                message: this.sharesProfile(space)
                    ? `${name} and its data will be removed from every Space in this group.`
                    : `${name} and its Space-local data will be removed. Other Spaces are unchanged.`,
                buttons: [
                    {
                        title: `Remove from ${space.state.settings.name}`,
                        role: "destructive",
                        action: () => void this.command(ExtensionCommand.remove, record.id, space).finally(() => completion?.()),
                    },
                    { title: "Cancel", role: "cancel", action: () => completion?.() },
                ],
            });
        });
    }

    // MARK: - Actions - Copies

    /** The Spaces a copy of `extensionId` from `space` may go to, and whether the core heard from all of them. */
    async destinations(extensionId: string, space: Space): Promise<{ readonly spaces: Space[]; readonly listed: boolean }> {
        try {
            const answer = await query("ExtensionCopyDestinations", { spaceId: space.state.id, engine: "Chromium", extensionId });
            return {
                spaces: answer.spaceIds.map((id) => this.space(id)).filter((found): found is Space => found !== undefined),
                listed: answer.listed,
            };
        } catch (error) {
            console.error(error);
            return { spaces: [], listed: false };
        }
    }

    // MARK: - Actions - Installs

    /** The install the core runs under `installId`, as it last published it. */
    install(installId: Guid): ExtensionInstallState | undefined {
        return this.installs.get(installId);
    }

    /**
     * Installs `extensionId` from the Chrome Web Store in `space`, and copies
     * in `copies`, behind the review the core asks the person through.
     * `completion` runs when the review closes, however it ended.
     */
    beginInstall(extensionId: string, space: Space, copies: readonly Guid[] = [], completion?: () => void): void {
        if (this.review) {
            completion?.();
            return;
        }
        const review = new InstallReview(this, extensionId, space, copies, () => {
            if (this.review === review) this.review = null;
            completion?.();
        });
        this.review = review;
        void this.send({
            kind: "InstallExtension",
            value: { installId: review.installId, spaceId: space.state.id, engine: "Chromium", extensionId, copySpaceIds: [], preApproved: false },
        }).then((sent) => {
            if (!sent) review.close(false);
        });
    }

    /**
     * The core asks whether to install the package an install verified. The
     * review this window shows for that install asks the person. Another
     * window's install is that window's to answer, and an install whose review
     * a page replays from history is long answered.
     */
    private reviewAsked(asked: ExtensionInstallAsked): void {
        // TODO(linux): the Mac declines a question no review shows any more;
        // a Linux window that closed mid-review leaves its install to the
        // engine's own timeout, since every window hears every question.
        if (this.review?.installId === asked.installId) this.review.ask(asked);
    }

    /**
     * The Chrome Web Store listing the window shows asked Crest to install or
     * remove the extension it is about. The engine checked the extension is
     * the one the listing names, and it goes to or from the page's own Space,
     * which the core refuses for a locked Space or one being deleted. The
     * listing restates its button once the review or confirmation ends.
     */
    private performStoreRequest(pageId: Guid, extensionId: string, removes: boolean): void {
        const page = this.host.model.pages.get(pageId);
        const space = page ? this.space(page.spaceId) : undefined;
        const refresh = (): void => void pageRequest("RefreshStoreListing", { pageId }).catch((error: unknown) => console.error(error));
        if (!space) {
            refresh();
            return;
        }
        if (!removes) {
            this.beginInstall(extensionId, space, [], refresh);
            return;
        }
        const record = this.installedRecord(extensionId, space);
        if (!record) {
            refresh();
            return;
        }
        this.confirmRemoval(record, space, refresh);
    }
}

/** The extension a Chrome Web Store listing names: `/detail/<id>` or `/detail/<name>/<id>`, as the Mac reads it. */
export function webStoreExtensionId(address: string | null): string | null {
    if (!address) return null;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "chromewebstore.google.com") return null;
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length < 2 || parts[0] !== "detail") return null;
    const isId = (candidate: string | undefined): candidate is string => candidate !== undefined && /^[a-p]{32}$/.test(candidate);
    if (parts.length > 2 && isId(parts[2])) return parts[2];
    return isId(parts[1]) ? parts[1] : null;
}
