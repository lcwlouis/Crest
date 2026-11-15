// The Spaces of a workspace as the Mac's BrowserStore reads them from the
// core's read model (BrowserStore+Groups): which ones a window offers, the
// groups they form (a primary and the Sub-Spaces that joined its session),
// and the orders the Space menus propose to the core. The core keeps every
// group together whatever order it is sent (ReorderSpaces), and answers
// whether each change may happen (CanSend); this only reads what it published.

import type { Guid } from "../generated/crest_contracts.js";
import type { Space, Workspace } from "./model.js";

export class SpaceGroups {
    private readonly workspace: Workspace;

    constructor(workspace: Workspace) {
        this.workspace = workspace;
    }

    // MARK: - Reading

    /** Whether the workspace is deleting the Space. */
    isDeleting(spaceId: Guid): boolean {
        return this.workspace.deletions.some((deletion) => deletion.spaceId === spaceId);
    }

    /** Every Space in the workspace's order, those being deleted too. */
    get all(): Space[] {
        return this.workspace.order
            .map((id) => this.workspace.spaces.get(id))
            .filter((space): space is Space => space !== undefined);
    }

    /** The Spaces a window offers: every one the workspace is not deleting (availableSpaces). */
    get available(): Space[] {
        return this.all.filter((space) => !this.isDeleting(space.state.id));
    }

    /** The primary of the group `space` belongs to: the Space whose session it joined, or itself. */
    primary(space: Space): Space {
        const primaryId = space.state.membership?.primaryId;
        return (primaryId ? this.workspace.spaces.get(primaryId) : undefined) ?? space;
    }

    /** The Spaces of `space`'s group that stay, the primary first, then its Sub-Spaces in order. */
    members(space: Space): Space[] {
        const primaryId = this.primary(space).state.id;
        return this.available.filter((other) => other.state.id === primaryId || other.state.membership?.primaryId === primaryId);
    }

    /** Whether `space` joined another Space's session. */
    isSubSpace(space: Space): boolean {
        return (space.state.membership?.primaryId ?? null) !== null;
    }

    /** Whether `space` leads Sub-Spaces that stay. */
    leadsGroup(space: Space): boolean {
        return this.members(space).length > 1 && this.primary(space) === space;
    }

    /** Whether `space` may become a Sub-Space of another group: never a primary, which owns its session. */
    canJoinGroup(space: Space): boolean {
        return !this.leadsGroup(space) && (this.isSubSpace(space) || (space.state.membership?.sharedProfileId ?? null) === null);
    }

    /** The groups `space` may join, each by its primary. */
    joinableGroups(space: Space): Space[] {
        const own = this.primary(space).state.id;
        return this.available.filter(
            (other) => !this.isSubSpace(other) && other.state.id !== own && other.state.id !== space.state.id,
        );
    }

    /** The available Spaces grouped, each group its primary then its Sub-Spaces (spaceGroups). */
    get groups(): Space[][] {
        const groups: Space[][] = [];
        for (const space of this.available) {
            const last = groups.at(-1);
            if (this.isSubSpace(space) && last && last[0]!.state.id === space.state.membership?.primaryId) last.push(space);
            else groups.push([space]);
        }
        return groups;
    }

    // MARK: - Orders

    /**
     * The order with `spaceId` moved to where `targetId` stands, as the Mac's
     * Space picker moves one (BrowserStore.move(_:to:)), or null when it
     * stays.
     */
    movedTo(spaceId: Guid, targetId: Guid): Guid[] | null {
        const order = this.all.map((space) => space.state.id);
        const from = order.indexOf(spaceId);
        const to = order.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return null;
        order.splice(from, 1);
        order.splice(to, 0, spaceId);
        return order;
    }

    /**
     * The order with `spaceId` one place up or down (BrowserSpaceOrderActions):
     * a primary moves past a whole neighbouring group, a Sub-Space only among
     * its group's Sub-Spaces. Null when it cannot move that way.
     */
    movedBy(spaceId: Guid, step: number): Guid[] | null {
        if (this.isDeleting(spaceId)) return null;
        const groups = this.groups.map((group) => group.map((space) => space.state.id));
        const group = groups.findIndex((ids) => ids.includes(spaceId));
        if (group < 0) return null;
        const member = groups[group]!.indexOf(spaceId);
        if (member > 0) {
            const target = member + step;
            if (target <= 0 || target >= groups[group]!.length) return null;
            const ids = groups[group]!;
            [ids[member], ids[target]] = [ids[target]!, ids[member]!];
        } else {
            const target = group + step;
            if (target < 0 || target >= groups.length) return null;
            [groups[group], groups[target]] = [groups[target]!, groups[group]!];
        }
        // The core orders every Space, those being deleted too.
        return [...groups.flat(), ...this.all.map((space) => space.state.id).filter((id) => this.isDeleting(id))];
    }
}
