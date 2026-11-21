// The blank window on Linux, as the Mac's temporary window: New Blank Window
// opens a window over a workspace that borrows the Space this window shows
// (BorrowSpace), with that Space's profile and settings and tabs, history and
// archive of its own, which the core never saves. Closing the window closes
// the workspace, and the core closes the workspace once its owner no longer
// lends the Space, which closes the window too.

import type { Guid } from "../generated/crest_contracts.js";
import { closeWindow, dispatch, openWindow, Refused } from "./bridge.js";
import type { Model, Space } from "./model.js";

/** The Space this page's window borrows, as its address says, or none. */
export const blankWindowSpaceId: Guid | null = new URLSearchParams(location.search).get("blank")?.toLowerCase() ?? null;

/** Opens a blank window over the Space `space`, in front. */
export function openBlankWindow(space: Space): void {
    const id = crypto.randomUUID();
    openWindow("browser", id, { window: id, blank: space.state.id }, true);
}

/**
 * Borrows the Space this window opened for from the workspace that holds it,
 * and draws the borrowed workspace the core opens for it.
 */
export async function openBlankWorkspace(model: Model, spaceId: Guid): Promise<Guid> {
    const owner = [...model.workspaces.values()].find((workspace) => workspace.kind !== "Borrowed" && workspace.spaces.has(spaceId));
    const space = owner?.spaces.get(spaceId);
    if (!owner || !space) throw new Error("The Space this blank window borrows is gone.");
    let changes;
    try {
        changes = await dispatch({
            kind: "BorrowSpace",
            value: { workspaceId: owner.id, spaceId, profileId: space.state.profileId },
        });
    } catch (error) {
        // A Space that may not lend itself, such as a locked one, opens no
        // window, as on the Mac.
        if (error instanceof Refused) closeWindow();
        throw error;
    }
    let workspaceId: Guid | null = null;
    for (const change of changes) if (change.kind === "WorkspaceOpened" && change.value.kind === "Borrowed") workspaceId = change.value.workspaceId;
    if (!workspaceId) throw new Error("The core opened no borrowed workspace.");
    model.drawWorkspace(workspaceId);
    return workspaceId;
}

/** Closes the borrowed workspace as its window closes. */
export async function closeBlankWorkspace(workspaceId: Guid): Promise<void> {
    await dispatch({ kind: "CloseWorkspace", value: { workspaceId } });
}
