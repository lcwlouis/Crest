// What the sidebar reads of the core's state, kept from the changes the core
// publishes. The core owns every rule; this only follows what it says, as the
// Swift UI's CoreState does on the Mac.

import type {
    Change,
    FolderState,
    Guid,
    PageState,
    SidebarList,
    SpaceState,
    SplitGroupState,
    TabPlacement,
    TabState,
    WindowState,
} from "../generated/crest_contracts.js";

export interface Space {
    state: SpaceState;
    tabs: TabState[];
    folders: Map<Guid, FolderState>;
    splitGroups: Map<Guid, SplitGroupState>;
    /** The core's sidebar outline: each list by `listKey`. */
    lists: Map<string, SidebarList>;
}

/** The key of the list holding `section`'s top level, or the inside of `folderId`. */
export function listKey(section: TabPlacement, folderId: Guid | null): string {
    return folderId ? `folder:${folderId}` : `section:${section}`;
}

function spaceFrom(state: SpaceState): Space {
    return {
        state,
        tabs: [...state.tabs],
        folders: new Map(state.folders.map((folder) => [folder.id, folder])),
        splitGroups: new Map(state.splitGroups.map((group) => [group.id, group])),
        lists: new Map(state.sidebar.lists.map((list) => [listKey(list.section, list.folderId), list])),
    };
}

export interface Workspace {
    readonly id: Guid;
    spaces: Map<Guid, Space>;
    order: Guid[];
}

export class Model {
    readonly workspaces = new Map<Guid, Workspace>();
    readonly windows = new Map<Guid, WindowState>();
    readonly pages = new Map<Guid, PageState>();

    apply(changes: readonly Change[]): void {
        for (const change of changes) this.applyOne(change);
    }

    /** The first persistent workspace the core holds open. */
    get workspace(): Workspace | undefined {
        return this.workspaces.values().next().value;
    }

    /** The page that shows `tabId`, if the engine has one. */
    pageFor(tabId: Guid): PageState | undefined {
        for (const page of this.pages.values()) if (page.tabId === tabId) return page;
        return undefined;
    }

    private applyOne(change: Change): void {
        switch (change.kind) {
            case "WorkspaceOpened": {
                const { workspaceId, session } = change.value;
                const spaces = new Map<Guid, Space>();
                for (const space of session.spaces) spaces.set(space.id, spaceFrom(space));
                this.workspaces.set(workspaceId, {
                    id: workspaceId,
                    spaces,
                    order: session.spaces.map((space) => space.id),
                });
                break;
            }
            case "WorkspaceClosed":
                this.workspaces.delete(change.value.workspaceId);
                break;
            case "SpacesChanged": {
                const workspace = this.workspaces.get(change.value.workspaceId);
                if (!workspace) break;
                for (const id of change.value.removed) workspace.spaces.delete(id);
                for (const space of change.value.added) {
                    workspace.spaces.set(space.id, spaceFrom(space));
                }
                workspace.order = change.value.order
                    ? [...change.value.order]
                    : [
                          ...workspace.order.filter((id) => workspace.spaces.has(id)),
                          ...change.value.added.map((space) => space.id).filter((id) => !workspace.order.includes(id)),
                      ];
                break;
            }
            case "SpaceSettingsChanged": {
                const space = this.workspaces.get(change.value.workspaceId)?.spaces.get(change.value.spaceId);
                if (space) space.state = { ...space.state, settings: change.value.settings };
                break;
            }
            case "TabsChanged": {
                const space = this.workspaces.get(change.value.workspaceId)?.spaces.get(change.value.spaceId);
                if (!space) break;
                const removed = new Set(change.value.removed);
                const byId = new Map(space.tabs.filter((tab) => !removed.has(tab.id)).map((tab) => [tab.id, tab]));
                for (const tab of change.value.updated) byId.set(tab.id, tab);
                const order = change.value.order ?? [
                    ...space.tabs.map((tab) => tab.id).filter((id) => byId.has(id)),
                    ...change.value.updated.map((tab) => tab.id).filter((id) => !space.tabs.some((tab) => tab.id === id)),
                ];
                space.tabs = order.map((id) => byId.get(id)).filter((tab): tab is TabState => tab !== undefined);
                break;
            }
            case "SidebarChanged": {
                const space = this.workspaces.get(change.value.workspaceId)?.spaces.get(change.value.spaceId);
                if (!space) break;
                for (const folderId of change.value.removedFolderIds) space.lists.delete(listKey("Current", folderId));
                for (const list of change.value.lists) space.lists.set(listKey(list.section, list.folderId), list);
                break;
            }
            case "FoldersChanged": {
                const space = this.workspaces.get(change.value.workspaceId)?.spaces.get(change.value.spaceId);
                if (!space) break;
                for (const id of change.value.removed) space.folders.delete(id);
                for (const folder of change.value.updated) space.folders.set(folder.id, folder);
                break;
            }
            case "SplitGroupsChanged": {
                const space = this.workspaces.get(change.value.workspaceId)?.spaces.get(change.value.spaceId);
                if (space) space.splitGroups = new Map(change.value.groups.map((group) => [group.id, group]));
                break;
            }
            case "WindowChanged":
                this.windows.set(change.value.window.id, change.value.window);
                break;
            case "WindowClosed":
                this.windows.delete(change.value.windowId);
                break;
            case "PageOpened":
            case "PageChanged":
                this.pages.set(change.value.page.id, change.value.page);
                break;
            case "PageRemoved":
                this.pages.delete(change.value.pageId);
                break;
            default:
                break;
        }
    }
}
