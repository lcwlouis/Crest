// What can be done to a Space, item for item as the Mac offers it: the empty
// sidebar's menu (BrowserSidebarBackgroundAction: Edit Space…, New Space…,
// New Sub-Space), the Space switcher's (CrestSpaceIconPicker: Move Left,
// Move Right) and a Space's own actions menu (BrowserSettingsSpaceMenu:
// Rename, Move Up and Down, its group items and its deletion), with the
// confirmations the Mac asks before a Space changes group or goes
// (BrowserSpaceGroupChange, BrowserSpaceDeletionPlan).
//
// Every change is a core intent. Where the core can say whether one would be
// taken, the menu asks it (CanSend) and dims the item it would refuse. The
// Space lock is left out until Linux decides what unlocks a Space (D3).

import type { Change, Guid, Intent, SpaceSettings } from "../generated/crest_contracts.js";
import { textsOfRejection } from "../generated/crest_contracts.js";
import { showAlert } from "./alert.js";
import { dispatch, query, Refused } from "./bridge.js";
import { Menu } from "./menu.js";
import type { MenuEntry, MenuItem, MenuPlacement } from "./menu.js";
import type { Model, Space, Workspace } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import { SpaceGroups } from "./space-groups.js";

// MARK: - Types

/** What a Space's editor is asked to do as it opens (BrowserSettingsSpaceIntent). */
export type SpaceEditorIntent = "none" | "rename" | "newSpace";

/** What the Space actions act through. */
export interface SpaceActionsHost {
    readonly model: Model;
    readonly windowId: () => Guid;
    /** Sends an intent, reporting a refusal; resolves once the core took it. */
    readonly send: (intent: Intent) => Promise<boolean>;
    /** Opens the Space's editor. */
    readonly edit: (spaceId: Guid, intent: SpaceEditorIntent) => void;
}

/** What deleting a Space removes, as its confirmation says it (BrowserSpaceDeletionPlan). */
interface DeletionPlan {
    readonly title: string;
    readonly message: string;
    readonly confirmation: string;
    /** The Sub-Spaces one of which takes the group over: empty unless a primary that leads them goes alone. */
    readonly successors: readonly Space[];
}

function symbol(name: string): MenuItem["icon"] {
    return { kind: "symbol", name };
}

/** A Space's icon in a menu, as BrowserSpaceIdentityLabel shows it. */
export function spaceMenuIcon(settings: SpaceSettings): MenuItem["icon"] {
    return { kind: "space", settings };
}

/** Why the core refused, in its own words, or what went wrong. */
export function explanation(error: unknown): string {
    if (error instanceof Refused) return textsOfRejection(error.rejection).message?.text ?? error.rejection.kind;
    return error instanceof Error ? error.message : String(error);
}

export class SpaceActions {
    private readonly host: SpaceActionsHost;
    /** Data erasures the core has yet to report, by request. */
    private readonly erasures = new Map<Guid, (deleted: boolean) => void>();

    constructor(host: SpaceActionsHost) {
        this.host = host;
    }

    /** Hears the core report each profile's data erased. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            if (change.kind !== "DataDeleted") continue;
            const waiter = this.erasures.get(change.value.requestId);
            this.erasures.delete(change.value.requestId);
            waiter?.(change.value.deleted);
        }
    }

    private get workspace(): Workspace | undefined {
        return this.host.model.workspace;
    }

    private groups(): SpaceGroups | null {
        const workspace = this.workspace;
        return workspace ? new SpaceGroups(workspace) : null;
    }

    // MARK: - Menus

    /** The empty sidebar's menu (BrowserSidebarBackgroundInteractionView). */
    async background(space: Space, at: MenuPlacement): Promise<void> {
        const workspace = this.workspace;
        if (!workspace) return;
        const windowId = this.host.windowId();
        const [creates, addsSubSpace] = await Promise.all([
            this.canSend({ kind: "CreateSpace", value: { workspaceId: workspace.id, windowId, spaceId: crypto.randomUUID() } }),
            this.canSend(this.addingSubSpace(workspace, space)),
        ]);
        Menu.open(
            [
                { title: "Edit Space…", icon: symbol("pencil"), action: () => this.host.edit(space.state.id, "none") },
                { title: "New Space…", icon: symbol("plus"), disabled: !creates, action: () => void this.create() },
                {
                    title: "New Sub-Space",
                    icon: symbol("plus.square.on.square"),
                    disabled: !addsSubSpace,
                    action: () => void this.addSubSpace(space),
                },
            ],
            at,
        );
    }

    /**
     * A Space's menu in the switcher, as the Mac's Space picker gives one where
     * Spaces are arranged (CrestSpaceIconPicker): it moves the Space one place
     * either way, a way to reorder that needs no drag.
     */
    switcher(space: Space, at: MenuPlacement): void {
        const groups = this.groups();
        if (!groups) return;
        const spaces = groups.available;
        const index = spaces.findIndex((other) => other.state.id === space.state.id);
        if (index < 0) return;
        const moveTo = (target: Space | undefined) => (): void => {
            const order = target ? groups.movedTo(space.state.id, target.state.id) : null;
            if (order) void this.reorder(order);
        };
        Menu.open(
            [
                { title: "Move Left", icon: symbol("arrow.left"), disabled: index === 0, action: moveTo(spaces[index - 1]) },
                {
                    title: "Move Right",
                    icon: symbol("arrow.right"),
                    disabled: index === spaces.length - 1,
                    action: moveTo(spaces[index + 1]),
                },
            ],
            at,
        );
    }

    /**
     * The items of a Space's actions menu (BrowserSettingsSpaceMenu), each
     * dimmed where the core would refuse it.
     */
    async spaceEntries(space: Space): Promise<MenuEntry[]> {
        const workspace = this.workspace;
        const groups = this.groups();
        if (!workspace || !groups) return [];
        const id = space.state.id;
        const up = groups.movedBy(id, -1);
        const down = groups.movedBy(id, 1);
        const joinable = groups.canJoinGroup(space) ? groups.joinableGroups(space) : [];
        const [addsSubSpace, separates, deletes, ...joins] = await Promise.all([
            this.canSend(this.addingSubSpace(workspace, space)),
            groups.isSubSpace(space) ? this.canSend({ kind: "SeparateSpace", value: { workspaceId: workspace.id, spaceId: id } }) : false,
            this.canSend(this.beginning(workspace, id, crypto.randomUUID(), null)),
            ...joinable.map((group) =>
                this.canSend({ kind: "JoinSpace", value: { workspaceId: workspace.id, spaceId: id, groupSpaceId: group.state.id } }),
            ),
        ]);
        const name = space.state.settings.name;
        const entries: MenuEntry[] = [
            { title: "Rename", icon: symbol("pencil"), action: () => this.host.edit(id, "rename") },
            "separator",
            { title: "Move Up", icon: symbol("arrow.up"), disabled: !up, action: () => up && void this.reorder(up) },
            { title: "Move Down", icon: symbol("arrow.down"), disabled: !down, action: () => down && void this.reorder(down) },
            "separator",
            {
                title: "New Sub-Space",
                icon: symbol("plus.square.on.square"),
                disabled: !addsSubSpace,
                action: () => void this.addSubSpace(space),
            },
        ];
        if (groups.isSubSpace(space)) {
            entries.push({
                title: `Separate from “${groups.primary(space).state.settings.name}”…`,
                icon: symbol("rectangle.portrait.and.arrow.right"),
                disabled: !separates,
                action: () => this.confirmSeparating(space),
            });
        }
        const offered = joinable.filter((_, index) => joins[index]);
        if (offered.length > 0) {
            entries.push({
                title: "Make Sub-Space of",
                icon: symbol("square.on.square"),
                submenu: offered.map((group) => ({
                    title: group.state.settings.name,
                    icon: spaceMenuIcon(group.state.settings),
                    action: () => this.confirmJoining(space, group),
                })),
            });
        }
        entries.push("separator", {
            title: `Delete “${name}”…`,
            icon: symbol("trash"),
            destructive: true,
            disabled: !deletes,
            action: () => this.requestDeletion(space, false),
        });
        if (groups.leadsGroup(space)) {
            entries.push({
                title: `Delete “${name}” and Its Sub-Spaces…`,
                icon: symbol("trash"),
                destructive: true,
                disabled: groups.members(space).length >= groups.available.length,
                action: () => this.requestDeletion(space, true),
            });
        }
        return entries;
    }

    // MARK: - Creating

    /**
     * Adds a Space, which the window shows, and opens its editor to name it and
     * choose where its crest starts, as the Mac's New Space… does.
     */
    async create(): Promise<void> {
        const workspace = this.workspace;
        if (!workspace) return;
        const spaceId = crypto.randomUUID();
        try {
            await dispatch({ kind: "CreateSpace", value: { workspaceId: workspace.id, windowId: this.host.windowId(), spaceId } });
        } catch (error) {
            postNotice(Notices.failure(explanation(error)));
            return;
        }
        this.host.edit(spaceId, "newSpace");
    }

    /** Adds a Sub-Space right after `space`, in its group, which the window shows. */
    async addSubSpace(space: Space): Promise<void> {
        const workspace = this.workspace;
        if (!workspace) return;
        try {
            await dispatch(this.addingSubSpace(workspace, space));
        } catch (error) {
            postNotice(Notices.failure(explanation(error)));
        }
    }

    private addingSubSpace(workspace: Workspace, space: Space): Intent {
        return {
            kind: "AddSubSpace",
            value: { workspaceId: workspace.id, windowId: this.host.windowId(), spaceId: crypto.randomUUID(), fromSpaceId: space.state.id },
        };
    }

    // MARK: - Ordering

    /** Puts the workspace's Spaces in `order`; the core keeps every group together. */
    private reorder(order: Guid[]): Promise<boolean> {
        const workspace = this.workspace;
        if (!workspace) return Promise.resolve(false);
        return this.host.send({ kind: "ReorderSpaces", value: { workspaceId: workspace.id, spaceIds: order } });
    }

    // MARK: - Groups

    /** Asks before `space` becomes a Sub-Space of `group`'s primary (BrowserSpaceGroupChange.joining). */
    private confirmJoining(space: Space, group: Space): void {
        const groups = this.groups();
        const workspace = this.workspace;
        if (!groups || !workspace) return;
        const name = space.state.settings.name;
        const target = groups.primary(group);
        const targetName = target.state.settings.name;
        this.confirm(
            `Make “${name}” a Sub-Space of “${targetName}”?`,
            `${name} will use ${targetName}’s sign-ins, history and extensions. Its own sign-ins and website data stay on this device and come back if you separate it.`,
            "Make Sub-Space",
            { kind: "JoinSpace", value: { workspaceId: workspace.id, spaceId: space.state.id, groupSpaceId: target.state.id } },
        );
    }

    /** Asks before the Sub-Space `space` leaves its group (BrowserSpaceGroupChange.separating). */
    private confirmSeparating(space: Space): void {
        const groups = this.groups();
        const workspace = this.workspace;
        if (!groups || !workspace) return;
        const name = space.state.settings.name;
        this.confirm(
            `Separate “${name}” from “${groups.primary(space).state.settings.name}”?`,
            `${name} will use sign-ins and extensions of its own. It keeps its tabs.`,
            "Separate",
            { kind: "SeparateSpace", value: { workspaceId: workspace.id, spaceId: space.state.id } },
        );
    }

    private confirm(title: string, message: string, confirmation: string, intent: Intent): void {
        showAlert({
            title,
            message,
            buttons: [
                {
                    title: confirmation,
                    role: "default",
                    action: () =>
                        void dispatch(intent).catch((error: unknown) => postNotice(Notices.failure(explanation(error)))),
                },
                { title: "Cancel", role: "cancel" },
            ],
        });
    }

    // MARK: - Deleting

    /** What deleting `space` removes (BrowserSpaceDeletionPlan), as its confirmation says. */
    private plan(space: Space, includesSubSpaces: boolean): DeletionPlan | null {
        const groups = this.groups();
        if (!groups) return null;
        const name = space.state.settings.name;
        const subSpaces = groups.members(space).filter((member) => member !== space);
        if (groups.isSubSpace(space)) {
            return {
                title: `Delete “${name}”?`,
                message: `Deletes its tabs. ${groups.primary(space).state.settings.name}’s sign-ins, history, passwords and extensions stay.`,
                confirmation: "Delete Sub-Space",
                successors: [],
            };
        }
        if (subSpaces.length === 0) {
            return {
                title: `Delete “${name}”?`,
                message: "This permanently removes this Space’s browser data from Crest. Downloaded files you already saved are kept.",
                confirmation: "Delete Space and Data",
                successors: [],
            };
        }
        if (includesSubSpaces) {
            return {
                title:
                    subSpaces.length === 1
                        ? `Delete “${name}” and its Sub-Space?`
                        : `Delete “${name}” and its ${subSpaces.length} Sub-Spaces?`,
                message: "This permanently removes their tabs and browser data from Crest. Downloaded files you already saved are kept.",
                confirmation: "Delete Spaces and Data",
                successors: [],
            };
        }
        return {
            title: `Delete “${name}”?`,
            message: `Choose the Space that keeps ${name}’s sign-ins, history, passwords and pinned tabs.`,
            confirmation: `Delete ${name}`,
            successors: subSpaces,
        };
    }

    /**
     * Asks before deleting `space`, as its plan describes: a primary that leads
     * Sub-Spaces asks which of them takes its group over. Then deletes it and
     * its data.
     */
    requestDeletion(space: Space, includesSubSpaces: boolean): void {
        const plan = this.plan(space, includesSubSpaces);
        if (!plan) return;
        const choice =
            plan.successors.length > 0
                ? {
                      label: "New primary",
                      options: plan.successors.map((member) => ({ value: member.state.id, title: member.state.settings.name })),
                  }
                : undefined;
        showAlert({
            title: plan.title,
            message: plan.message,
            ...(choice ? { choice } : {}),
            buttons: [
                {
                    title: plan.confirmation,
                    role: "destructive",
                    action: (successor) => void this.delete(space, includesSubSpaces, choice ? successor : null),
                },
                { title: "Cancel", role: "cancel" },
            ],
        });
    }

    /** Deletes what the plan names: a whole group's Sub-Spaces first, then the Space. */
    private async delete(space: Space, includesSubSpaces: boolean, successor: Guid | null): Promise<void> {
        const groups = this.groups();
        if (!groups) return;
        try {
            if (includesSubSpaces) {
                for (const member of groups.members(space)) {
                    if (member !== space) await this.deleteOne(member.state.id, null);
                }
            }
            await this.deleteOne(space.state.id, successor);
        } catch (error) {
            // The window may have moved off the Space that asked, so the notice says it.
            postNotice(Notices.failure(`${explanation(error)} The Space was kept so you can try again.`));
        }
    }

    /**
     * Deletes one Space in the core's two steps (BrowserStore.deleteSpace):
     * the deletion begins, the window lets go of the Space's pages and every
     * engine erases each profile the deletion erases, then the Space goes.
     * A primary that leads Sub-Spaces hands its group to `newPrimaryId`.
     * Throws the rule the core applied or why erasing failed; the Space then
     * stays, its deletion recorded for another try.
     */
    private async deleteOne(spaceId: Guid, newPrimaryId: Guid | null): Promise<void> {
        const workspace = this.workspace;
        if (!workspace) return;
        const windowId = this.host.windowId();
        const operationId = workspace.deletions.find((deletion) => deletion.spaceId === spaceId)?.id ?? crypto.randomUUID();
        await dispatch(this.beginning(workspace, spaceId, operationId, newPrimaryId));
        const deletion = this.workspace?.deletions.find((pending) => pending.spaceId === spaceId);
        if (!deletion) throw new Error("That Space no longer exists.");
        for (const page of [...this.host.model.pages.values()]) {
            if (page.spaceId === spaceId) await dispatch({ kind: "ReleasePage", value: { pageId: page.id, keepsState: false } });
        }
        for (const profileId of deletion.erasing) {
            const requestId = crypto.randomUUID();
            const erased = new Promise<boolean>((resolve) => this.erasures.set(requestId, resolve));
            try {
                await dispatch({ kind: "DeleteProfileData", value: { requestId, profileId, ephemeral: false } });
            } catch (error) {
                this.erasures.delete(requestId);
                throw error;
            }
            if (!(await erased)) throw new Error("Crest couldn’t finish removing this Space’s browser data. Try again.");
        }
        await dispatch({ kind: "FinishDeletingSpace", value: { workspaceId: workspace.id, windowId, spaceId, operationId } });
    }

    private beginning(workspace: Workspace, spaceId: Guid, operationId: Guid, newPrimaryId: Guid | null): Intent {
        return {
            kind: "BeginDeletingSpace",
            value: { workspaceId: workspace.id, windowId: this.host.windowId(), spaceId, operationId, newPrimaryId },
        };
    }

    // MARK: - Shared

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
