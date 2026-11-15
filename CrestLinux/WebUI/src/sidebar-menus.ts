// The sidebar's menus, item for item as the Mac builds them: a tab's
// (BrowserTabOrganizationMenuContent, which a pinned tile shares), a
// folder's (BrowserFolderOrganizationMenuContent), the Space header's actions
// (BrowserSpaceHeaderActionsMenu) and the empty sidebar's
// (BrowserSidebarBackgroundInteractionView).
//
// Every item sends the intent the Mac's item sends. Where the Mac asks the
// core whether an item would do anything (CanSend, which it asks through
// family.canSend), the menu asks the same before it opens and dims the item
// the core would refuse.
//
// Items whose surface Linux does not draw yet are left out rather than
// offered dead: tab sharing, the icon picker (Change Icon…, Folder Icon…),
// the folder colour popover, Pull New Icon (it needs the page's image
// bytes), multi-selection, history, passwords, settings, private browsing
// and new windows. The empty sidebar's menu and the Space switcher's are the
// Space actions' (space-actions.ts).

import type {
    FolderState,
    Guid,
    Intent,
    ShortcutCommand,
    SidebarRow,
    TabPlacement,
    TabState,
} from "../generated/crest_contracts.js";
import { ShortcutCommand as Commands, TabIconMode, TabPlacement as Placements } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { query } from "./bridge.js";
import type { TabIcons } from "./icons.js";
import { Menu } from "./menu.js";
import type { MenuEntry, MenuIcon, MenuItem, MenuPlacement } from "./menu.js";
import { listKey } from "./model.js";
import { SpaceGroups } from "./space-groups.js";
import type { Model, Space, Workspace } from "./model.js";
import type { InlineRename } from "./rename.js";
import { css } from "./sidebar.js";
import { spaceMenuIcon } from "./space-actions.js";

/** What the menus act through. */
export interface SidebarMenuHost {
    readonly model: Model;
    readonly icons: TabIcons;
    readonly rename: InlineRename;
    readonly windowId: () => Guid;
    readonly shownTabId: () => Guid | null;
    /** Sends an intent, reporting a refusal; resolves once the core took it. */
    readonly send: (intent: Intent) => Promise<boolean>;
    readonly report: (error: unknown) => void;
    /** Performs one of the core's commands, as the command bar does. */
    readonly perform: (command: ShortcutCommand) => void;
    /** Opens Settings, as the Mac's Space header menu does. */
    readonly openSettings: () => void;
}

/** The colour a new folder takes (BrandColor.folderDefault, "Slate"). */
const folderDefault = { red: 0.43, green: 0.48, blue: 0.54, alpha: 1 };
const newFolderTitle = "New Folder";

function symbol(name: string): MenuIcon {
    return { kind: "symbol", name };
}

function folderIcon(folder: FolderState): MenuIcon {
    const emoji = /\p{Extended_Pictographic}/u.test(folder.displaySymbol) ? folder.displaySymbol : undefined;
    return emoji ? { kind: "folder", color: css(folder.displayColor), emoji } : { kind: "folder", color: css(folder.displayColor) };
}

function commandItem(command: ShortcutCommand, action: () => void): MenuItem {
    const facts = Commands.facts[command];
    return { title: (facts.menuTitle ?? facts.title).text, icon: symbol(facts.symbol), action };
}

interface FolderChoice {
    readonly folder: FolderState;
    readonly pathTitle: string;
}

/**
 * The folders of `sections`, in the order the sidebar lists them, each titled
 * with the folders that hold it (SpaceModel.folderChoices).
 */
function folderChoices(space: Space, sections: readonly TabPlacement[]): FolderChoice[] {
    const choices: FolderChoice[] = [];
    const walk = (key: string, path: string | null, seen: Set<Guid>): void => {
        for (const row of space.lists.get(key)?.rows ?? []) {
            const folder = row.kind === "Folder" ? space.folders.get(row.id) : undefined;
            if (!folder || seen.has(folder.id)) continue;
            seen.add(folder.id);
            const title = path === null ? folder.title : `${path} › ${folder.title}`;
            choices.push({ folder, pathTitle: title });
            walk(listKey("Current", folder.id), title, seen);
        }
    };
    for (const section of sections) walk(listKey(section, null), null, new Set());
    return choices;
}

/** The folders inside `folderId`, however deep. */
function foldersInside(space: Space, folderId: Guid): Set<Guid> {
    const inside = new Set<Guid>();
    const walk = (id: Guid): void => {
        for (const row of space.lists.get(listKey("Current", id))?.rows ?? []) {
            if (row.kind === "Folder" && !inside.has(row.id)) {
                inside.add(row.id);
                walk(row.id);
            }
        }
    };
    walk(folderId);
    return inside;
}

/** The split row the sidebar shows the tab in, if it shows it in one. */
function splitRow(space: Space, tabId: Guid): SidebarRow | undefined {
    for (const list of space.lists.values()) {
        const row = list.rows.find((candidate) => candidate.kind === "Split" && candidate.members.includes(tabId));
        if (row) return row;
    }
    return undefined;
}

/** How many tabs and folders a folder holds, however deep. */
function contents(space: Space, folderId: Guid): { tabs: number; folders: number } {
    let tabs = 0;
    const folders = foldersInside(space, folderId);
    for (const id of [folderId, ...folders]) {
        for (const row of space.lists.get(listKey("Current", id))?.rows ?? []) {
            if (row.kind !== "Folder") tabs += row.kind === "Split" ? row.members.length : 1;
        }
    }
    return { tabs, folders: folders.size };
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** BrowserFolderDeletionMessage. */
function deletionMessage(space: Space, folderId: Guid): string {
    const { tabs, folders } = contents(space, folderId);
    if (tabs === 0 && folders === 0) return "The folder is empty.";
    if (folders === 0) return `This also deletes the ${plural(tabs, "tab", "tabs")} inside it. Deleted tabs go to the Archive.`;
    if (tabs === 0) return `This also deletes the ${plural(folders, "empty folder", "empty folders")} inside it.`;
    return `This also deletes everything inside it: ${plural(tabs, "tab", "tabs")} and ${plural(folders, "folder", "folders")}. Deleted tabs go to the Archive.`;
}

export class SidebarMenus {
    private readonly host: SidebarMenuHost;

    constructor(host: SidebarMenuHost) {
        this.host = host;
    }

    // --- Tabs ---

    /** A tab's menu, from its row (`pinned` false) or its pinned tile. */
    async tab(space: Space, tab: TabState, at: MenuPlacement, pinned: boolean): Promise<void> {
        const workspace = this.host.model.workspace;
        if (!workspace) return;
        const entries = await this.tabEntries(workspace, space, tab, pinned);
        Menu.open(entries, at);
    }

    private async tabEntries(workspace: Workspace, space: Space, tab: TabState, pinned: boolean): Promise<MenuEntry[]> {
        const { send } = this.host;
        const windowId = this.host.windowId();
        const ids = { workspaceId: workspace.id, spaceId: space.state.id };
        const durable = Placements.facts[tab.placement].isDurable;
        const isStartPage = tab.surface === "StartPage";
        const page = this.host.model.pageFor(tab.id);
        const shown = this.host.shownTabId();
        const split = splitRow(space, tab.id);
        const destinations = this.destinationSpaces(workspace, space);

        const [splitsWithShown, stepsLeft, stepsRight, ...movesTo] = await Promise.all([
            shown && shown !== tab.id
                ? this.canSend({ kind: "JoinSplit", value: { ...ids, windowId, tabId: tab.id, targetTabId: shown, index: null } })
                : false,
            split ? this.canSend({ kind: "StepSplitMember", value: { ...ids, tabId: tab.id, offset: -1 } }) : false,
            split ? this.canSend({ kind: "StepSplitMember", value: { ...ids, tabId: tab.id, offset: 1 } }) : false,
            ...destinations.map((other) =>
                this.canSend({
                    kind: "MoveTabToSpace",
                    value: {
                        ...ids,
                        windowId,
                        tabId: tab.id,
                        destinationSpaceId: other.state.id,
                        placement: null,
                        folderId: null,
                        beforeTabId: null,
                    },
                }),
            ),
        ]);

        const move = (placement: TabPlacement, folderId: Guid | null = null): Promise<boolean> =>
            send({ kind: "MoveTab", value: { ...ids, tabId: tab.id, placement, folderId, beforeTabId: null, leavesSplit: false } });
        const file = (folderId: Guid | null): Promise<boolean> =>
            send({
                kind: "FileTabs",
                value: {
                    ...ids,
                    windowId,
                    selection: { tabIds: [tab.id], folderIds: [], memberTabIds: [tab.id] },
                    placement: "Current",
                    folderId,
                    beforeTabId: null,
                    beforeFolderId: null,
                    leavesSplits: false,
                },
            });

        const entries: MenuEntry[] = [];
        if (tab.surface === "WebPage") {
            entries.push({ title: "Copy Link URL", icon: symbol("link"), action: () => this.copyLink(tab) }, "separator");
        }
        entries.push({ title: "Rename Tab…", icon: symbol("pencil"), action: () => this.renameTab(space, tab, pinned) }, "separator");

        if (!isStartPage) {
            const iconActions: MenuItem[] = [
                {
                    title: "Clear Icon",
                    icon: symbol("xmark.circle"),
                    disabled: TabIconMode.facts[tab.iconMode].followsPage && this.host.icons.imageOf(tab.id) === null,
                    action: () => void send({ kind: "ChooseTabIcon", value: { ...ids, tabId: tab.id, mode: "Automatic", emoji: null, accent: null } }),
                },
            ];
            if (durable && (tab.savedUrl ?? tab.url) !== null) {
                entries.push({
                    title: "Edit Tab",
                    icon: symbol("pencil"),
                    submenu: [
                        {
                            title: "Replace with Current URL",
                            icon: symbol("arrow.triangle.2.circlepath"),
                            disabled: !tab.isAwayFromSavedAddress,
                            action: () => void send({ kind: "ReplaceSavedAddress", value: { ...ids, tabId: tab.id } }),
                        },
                        {
                            title: "Return to Saved URL",
                            icon: symbol("arrow.uturn.backward"),
                            disabled: !tab.isAwayFromSavedAddress,
                            action: () => void this.returnToSavedAddress(space, tab),
                        },
                        "separator",
                        ...iconActions,
                    ],
                });
            } else {
                entries.push(...iconActions);
            }
            entries.push("separator");
        }

        // Unpin Tab takes Pin Tab's place so the two read as a pair.
        entries.push(
            tab.placement === "Pinned"
                ? { title: "Unpin Tab", icon: symbol("pin.slash"), action: () => void move("Current") }
                : { title: "Pin Tab", icon: symbol("pin"), action: () => void move("Pinned") },
        );

        if (!durable && !isStartPage) {
            const folders = folderChoices(space, ["Current"]).map((choice) => choice.folder);
            entries.push({
                title: "Add to Current Tabs Folder",
                icon: symbol("folder.badge.plus"),
                submenu: [
                    {
                        title: newFolderTitle,
                        icon: symbol("folder.badge.plus"),
                        action: () =>
                            void send({
                                kind: "CreateFolder",
                                value: {
                                    ...ids,
                                    folderId: crypto.randomUUID(),
                                    placement: "Current",
                                    parentId: null,
                                    title: newFolderTitle,
                                    color: folderDefault,
                                    symbol: "folder",
                                    tabIds: [tab.id],
                                    leavesSplits: false,
                                },
                            }),
                    },
                    "separator",
                    ...folders.map(
                        (folder): MenuItem => ({
                            title: folder.title,
                            icon: { kind: "folder", color: css(folder.displayColor) },
                            disabled: folder.id === tab.folderId,
                            action: () => void file(folder.id),
                        }),
                    ),
                ],
            });
            if (tab.folderId !== null) {
                entries.push({ title: "Remove from Folder", icon: symbol("folder.badge.minus"), action: () => void file(null) });
            }
        }

        entries.push({
            title: "Save in Folder",
            icon: symbol("folder"),
            submenu: [
                {
                    title: "Saved Tabs",
                    icon: symbol("bookmark"),
                    disabled: tab.placement === "Saved" && tab.folderId === null,
                    action: () => void move("Saved"),
                },
                "separator",
                ...folderChoices(space, ["Saved"]).map(
                    (choice): MenuItem => ({
                        title: choice.pathTitle,
                        icon: folderIcon(choice.folder),
                        disabled: tab.placement === "Saved" && tab.folderId === choice.folder.id,
                        action: () => void move("Saved", choice.folder.id),
                    }),
                ),
            ],
        });

        if (durable && tab.placement !== "Pinned") {
            entries.push({ title: "Move to Current Tabs", icon: symbol("rectangle.stack"), action: () => void move("Current") });
        }

        if (destinations.length > 0) {
            entries.push({
                title: "Move to Space",
                icon: symbol("square.grid.2x2"),
                submenu: this.spaceItems(destinations, movesTo, (other) =>
                    send({
                        kind: "MoveTabToSpace",
                        value: {
                            ...ids,
                            windowId,
                            tabId: tab.id,
                            destinationSpaceId: other.state.id,
                            placement: null,
                            folderId: null,
                            beforeTabId: null,
                        },
                    }),
                ),
            });
        }

        entries.push("separator", {
            title: "Split with Current Tab",
            icon: symbol("rectangle.split.2x1"),
            disabled: !splitsWithShown,
            action: () =>
                shown && void send({ kind: "JoinSplit", value: { ...ids, windowId, tabId: tab.id, targetTabId: shown, index: null } }),
        });
        if (split) {
            // The Mac's Move Left and Move Right step by -1 and +1 in a
            // left-to-right window, which this one is.
            const step = (offset: number) => () => void send({ kind: "StepSplitMember", value: { ...ids, tabId: tab.id, offset } });
            entries.push(
                { title: "Move Left", icon: symbol("arrow.left"), disabled: !stepsLeft, action: step(-1) },
                { title: "Move Right", icon: symbol("arrow.right"), disabled: !stepsRight, action: step(1) },
                {
                    title: "Remove from Split",
                    icon: symbol("rectangle.badge.minus"),
                    action: () => void send({ kind: "LeaveSplit", value: { ...ids, tabId: tab.id } }),
                },
            );
        }

        entries.push("separator");
        if (tab.nativeContent === null) {
            entries.push({
                title: tab.keepsPageLoaded ? "Stop Keeping Loaded" : "Keep Loaded",
                icon: symbol(tab.keepsPageLoaded ? "lock.open" : "lock"),
                action: () => void send({ kind: "KeepPageLoaded", value: { ...ids, tabId: tab.id, keeps: !tab.keepsPageLoaded } }),
            });
        }
        if (page && (tab.nativeContent === null || durable)) {
            // The page goes, and the tab stays where it is, unloaded.
            entries.push({
                title: durable ? "Close Tab" : "Unload Tab",
                icon: symbol(durable ? "xmark" : "minus"),
                action: () => void send({ kind: "ReleasePage", value: { pageId: page.id, keepsState: true } }),
            });
        }
        entries.push(
            {
                title: "Duplicate Tab",
                icon: symbol("plus.square.on.square"),
                action: () => void send({ kind: "DuplicateTab", value: { ...ids, windowId, tabId: tab.id, placement: null, shows: true } }),
            },
            {
                title: durable ? "Delete Tab" : "Close Tab",
                icon: symbol(durable ? "trash" : "xmark"),
                destructive: true,
                action: () =>
                    void send(
                        durable
                            ? { kind: "DeleteTab", value: { ...ids, windowId, tabId: tab.id } }
                            : { kind: "CloseTab", value: { ...ids, windowId, tabId: tab.id } },
                    ),
            },
        );
        return entries;
    }

    /** Copies the tab's address through Super Copy, which takes its trackers out. */
    private copyLink(tab: TabState): void {
        const url = this.host.model.pageFor(tab.id)?.live.url ?? tab.url;
        if (!url) return;
        void query("LinkToCopy", { url })
            .then((clean) => navigator.clipboard.writeText(clean))
            .catch(this.host.report);
    }

    /** A row names its tab in place; a pinned tile, which shows no title, asks in an alert. */
    private renameTab(space: Space, tab: TabState, pinned: boolean): void {
        const workspaceId = this.host.model.workspace?.id;
        if (!workspaceId) return;
        const commit = (title: string): void =>
            void this.host.send({ kind: "RenameTab", value: { workspaceId, spaceId: space.state.id, tabId: tab.id, title } });
        if (!pinned) {
            this.host.rename.begin({ kind: "tab", id: tab.id }, tab.displayTitle, commit);
            return;
        }
        showAlert({
            title: "Rename Tab",
            field: { value: tab.displayTitle, placeholder: "Tab Name" },
            buttons: [
                { title: "Rename", role: "default", action: commit },
                { title: "Cancel", role: "cancel" },
            ],
        });
    }

    /**
     * Sends a saved or pinned tab back to its saved address and shows it, as
     * BrowserSavedLocationRestoreAction does: an unloaded tab opens there, and
     * a page that is open loads it.
     */
    private async returnToSavedAddress(space: Space, tab: TabState): Promise<void> {
        const workspaceId = this.host.model.workspace?.id;
        if (!workspaceId) return;
        const page = this.host.model.pageFor(tab.id);
        if (!(await this.host.send({ kind: "ReturnToSavedAddress", value: { workspaceId, spaceId: space.state.id, tabId: tab.id } }))) return;
        await this.host.send({ kind: "ShowTab", value: { windowId: this.host.windowId(), spaceId: space.state.id, tabId: tab.id } });
        const url = space.tabs.find((held) => held.id === tab.id)?.savedUrl ?? tab.savedUrl;
        if (page && url && page.live.url !== url) await this.host.send({ kind: "LoadAddress", value: { pageId: page.id, url } });
    }

    // --- Folders ---

    async folder(space: Space, folder: FolderState, at: MenuPlacement): Promise<void> {
        const workspace = this.host.model.workspace;
        if (!workspace) return;
        const { send } = this.host;
        const windowId = this.host.windowId();
        const ids = { workspaceId: workspace.id, spaceId: space.state.id };
        const excluded = foldersInside(space, folder.id).add(folder.id);
        const candidates = folderChoices(space, ["Saved", "Current"]).filter((choice) => !excluded.has(choice.folder.id));
        const destinations = this.destinationSpaces(workspace, space);
        const moveInto = (parentId: Guid | null): Intent => ({
            kind: "MoveFolder",
            value: { ...ids, folderId: folder.id, placement: null, parentId, beforeFolderId: null, beforeTabId: null },
        });
        const toSpace = (other: Space): Intent => ({
            kind: "MoveFolderToSpace",
            value: { ...ids, windowId, folderId: folder.id, destinationSpaceId: other.state.id },
        });
        const [nests, ...answers] = await Promise.all([
            this.canSend(this.creatingFolder(ids, folder.id)),
            ...candidates.map((choice) => this.canSend(moveInto(choice.folder.id))),
            ...destinations.map((other) => this.canSend(toSpace(other))),
        ]);
        const movesInto = answers.slice(0, candidates.length);
        const movesTo = answers.slice(candidates.length);
        const intoFolders = candidates.filter((_, index) => movesInto[index]);
        const toSaved = folder.location === "Current";

        const entries: MenuEntry[] = [
            {
                title: "New Nested Folder",
                icon: symbol("folder.badge.plus"),
                disabled: !nests,
                action: () => void this.createNestedFolder(space, folder),
            },
            {
                title: "Rename Folder",
                icon: symbol("pencil"),
                action: () =>
                    this.host.rename.begin({ kind: "folder", id: folder.id }, folder.title, (title) =>
                        void send({ kind: "RenameFolder", value: { ...ids, folderId: folder.id, title } }),
                    ),
            },
            {
                title: toSaved ? "Move to Saved Tabs" : "Move to Current Tabs",
                icon: symbol(toSaved ? "bookmark" : "rectangle.stack"),
                action: () =>
                    void send({
                        kind: "MoveFolder",
                        value: {
                            ...ids,
                            folderId: folder.id,
                            placement: toSaved ? "Saved" : "Current",
                            parentId: null,
                            beforeFolderId: null,
                            beforeTabId: null,
                        },
                    }),
            },
            {
                title: "Move to Folder",
                icon: symbol("folder.badge.gearshape"),
                submenu: [
                    {
                        title: "Top Level",
                        icon: symbol("rectangle.topthird.inset.filled"),
                        disabled: folder.parentId === null,
                        action: () => void send(moveInto(null)),
                    },
                    "separator",
                    ...intoFolders.map(
                        (choice): MenuItem => ({
                            title: `${choice.folder.location === "Saved" ? "Saved Tabs" : "Current Tabs"} › ${choice.pathTitle}`,
                            icon: folderIcon(choice.folder),
                            disabled: folder.parentId === choice.folder.id,
                            action: () => void send(moveInto(choice.folder.id)),
                        }),
                    ),
                ],
            },
        ];
        if (destinations.length > 0) {
            entries.push({
                title: "Move to Space",
                icon: symbol("square.grid.2x2"),
                submenu: this.spaceItems(destinations, movesTo, (other) => send(toSpace(other))),
            });
        }
        entries.push("separator", {
            title: "Delete Folder",
            icon: symbol("trash"),
            destructive: true,
            action: () =>
                showAlert({
                    title: `Delete ${folder.title}?`,
                    message: deletionMessage(space, folder.id),
                    buttons: [
                        {
                            title: "Delete Folder",
                            role: "destructive",
                            action: () => void send({ kind: "DeleteFolderAndContents", value: { ...ids, windowId, folderId: folder.id } }),
                        },
                        { title: "Cancel", role: "cancel" },
                    ],
                }),
        });
        Menu.open(entries, at);
    }

    private creatingFolder(
        ids: { workspaceId: Guid; spaceId: Guid },
        parentId: Guid | null,
        folderId: Guid = crypto.randomUUID(),
        title: string | null = null,
    ): Intent {
        return {
            kind: "CreateFolder",
            value: {
                ...ids,
                folderId,
                placement: "Saved",
                parentId,
                title,
                color: title === null ? null : folderDefault,
                symbol: title === null ? null : "folder",
                tabIds: [],
                leavesSplits: false,
            },
        };
    }

    /** Makes a folder inside `folder`, opens it, and starts naming the new one. */
    private async createNestedFolder(space: Space, folder: FolderState): Promise<void> {
        const workspaceId = this.host.model.workspace?.id;
        if (!workspaceId) return;
        const ids = { workspaceId, spaceId: space.state.id };
        const folderId = crypto.randomUUID();
        if (!(await this.host.send(this.creatingFolder(ids, folder.id, folderId, newFolderTitle)))) return;
        if (folder.isCollapsed) await this.host.send({ kind: "CollapseFolder", value: { ...ids, folderId: folder.id, collapsed: false } });
        this.nameNewFolder(space, folderId);
    }

    private nameNewFolder(space: Space, folderId: Guid): void {
        const workspaceId = this.host.model.workspace?.id;
        if (!workspaceId) return;
        this.host.rename.begin({ kind: "folder", id: folderId }, newFolderTitle, (title) =>
            void this.host.send({ kind: "RenameFolder", value: { workspaceId, spaceId: space.state.id, folderId, title } }),
        );
    }

    // --- The Space ---

    /** The Space header's actions, under its "…" control. */
    spaceActions(space: Space, anchor: DOMRect): void {
        const workspaceId = this.host.model.workspace?.id;
        if (!workspaceId) return;
        const ids = { workspaceId, spaceId: space.state.id };
        Menu.open(
            [
                commandItem("NewTab", () => this.host.perform("NewTab")),
                {
                    title: newFolderTitle,
                    icon: symbol("folder.badge.plus"),
                    action: () =>
                        void (async () => {
                            const folderId = crypto.randomUUID();
                            if (!(await this.host.send(this.creatingFolder(ids, null, folderId, newFolderTitle)))) return;
                            await this.host.send({ kind: "ExpandSavedTabs", value: { ...ids, isExpanded: true } });
                            this.nameNewFolder(space, folderId);
                        })(),
                },
                { title: "Settings", icon: symbol("gearshape"), action: () => this.host.openSettings() },
                commandItem("ClearUnpinnedTabs", () => this.host.perform("ClearUnpinnedTabs")),
            ],
            { anchor },
        );
    }

    // --- Shared ---

    /** The other Spaces a tab or folder may move to, in the window's order, leaving out those being deleted. */
    private destinationSpaces(workspace: Workspace, space: Space): Space[] {
        return new SpaceGroups(workspace).available.filter((other) => other.state.id !== space.state.id);
    }

    /** The Move to Space items, each group of Spaces set apart, as the Mac's grouped(_:). */
    private spaceItems(spaces: Space[], allowed: readonly boolean[], move: (space: Space) => void): MenuEntry[] {
        const entries: MenuEntry[] = [];
        let group: Guid | null = null;
        spaces.forEach((other, index) => {
            const primary = other.state.membership?.primaryId ?? other.state.id;
            if (group !== null && primary !== group) entries.push("separator");
            group = primary;
            const settings = other.state.settings;
            entries.push({
                title: settings.name,
                icon: spaceMenuIcon(settings),
                disabled: !allowed[index],
                action: () => move(other),
            });
        });
        return entries;
    }

    /** Whether the core would take `intent` now, as the Mac's menus ask it. */
    private async canSend(intent: Intent): Promise<boolean> {
        try {
            return (await query("CanSend", { intent })).refusal === null;
        } catch (error) {
            console.error(error);
            return false;
        }
    }
}
