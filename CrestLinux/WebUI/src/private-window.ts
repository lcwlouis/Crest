// The private window on Linux, as the Mac's: one window over a private
// workspace the core keeps in memory only (OpenWorkspace with the Private
// kind), whose Spaces browse in off-the-record engine profiles. New Private
// Window brings it forward when it is open. Closing it ends private
// browsing: the core starts the workspace over with one fresh private Space
// (ResetPrivateBrowsing) and the engine destroys the profiles it used.

import { sfSymbol } from "./symbols.js";
import type { Guid } from "../generated/crest_contracts.js";
import { dispatch, openWindow, releasePrivateProfiles } from "./bridge.js";
import type { Model } from "./model.js";

// TODO(linux): the Mac draws the private window dark whatever the system's
// appearance; the Linux tokens follow the system's only.

/** Whether this page draws the private window, as its address says. */
export const drawsPrivateWindow = new URLSearchParams(location.search).has("private");

/** The private workspace the core holds open, or none. */
function privateWorkspaceId(model: Model): Guid | null {
    for (const workspace of model.workspaces.values()) if (workspace.kind === "Private") return workspace.id;
    return null;
}

/**
 * Opens the private window, or brings it forward when it is open: the window
 * the core keeps over the private workspace, or a new one.
 */
export function openPrivateWindow(model: Model): void {
    const workspaceId = privateWorkspaceId(model);
    const open = workspaceId ? [...model.windows.values()].find((window) => window.workspaceId === workspaceId) : undefined;
    const id = open?.id ?? crypto.randomUUID();
    openWindow("browser", id, { window: id, private: "1" }, true);
}

/**
 * The private workspace this window draws, which the core opens once a
 * private window first asks for it and keeps while Crest runs.
 */
export async function openPrivateWorkspace(model: Model): Promise<Guid> {
    let workspaceId = privateWorkspaceId(model);
    if (!workspaceId) {
        await dispatch({ kind: "OpenWorkspace", value: { kind: "Private", seed: null } });
        workspaceId = privateWorkspaceId(model);
    }
    if (!workspaceId) throw new Error("The core opened no private workspace.");
    model.drawWorkspace(workspaceId);
    return workspaceId;
}

/**
 * Ends private browsing as the private window closes: the core forgets what
 * the workspace held, and the engine lets the profiles its Spaces used go.
 */
export async function endPrivateBrowsing(model: Model, windowId: Guid): Promise<void> {
    const workspace = model.workspace;
    if (workspace?.kind !== "Private") return;
    const profiles = [...workspace.spaces.values()].map((space) => space.state.profileId);
    try {
        await dispatch({ kind: "ResetPrivateBrowsing", value: { workspaceId: workspace.id, windowId } });
    } finally {
        releasePrivateProfiles(profiles);
    }
}

/** BrowserStartPagePrivateBrowsingNotice: what a private session tells the reader it is not keeping. */
export function privateBrowsingNotice(): HTMLElement {
    const notice = document.createElement("div");
    notice.className = "start-private-notice";
    const title = document.createElement("div");
    title.className = "start-private-title";
    title.innerHTML = sfSymbol("eyeglasses", 16);
    title.append("Private Browsing");
    const message = document.createElement("p");
    message.className = "start-private-message";
    message.textContent = "Crest does not save this session or use Crest Passwords. Website data stays in memory only.";
    notice.append(title, message);
    return notice;
}
