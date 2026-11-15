// The questions the core asks the person about a page, as the Mac's
// BrowserPage+Prompts and BrowserDownloadPrompts show them: a site's request
// for a capability (PermissionAsked), a page's script dialog
// (ScriptDialogAsked), a server's sign-in (AuthenticationAsked), and a
// download to approve (DownloadApprovalAsked). Each waits for its page: only
// the shown page's questions show, the others wait until their tab is shown,
// and each leaves once answered, once the core settles it (PromptSettled), or
// with its page. The words are the Mac's; the floating page draws them.

import { DownloadRiskReason, DownloadWarning, SitePermission, WebScheme } from "../generated/crest_contracts.js";
import type {
    AuthenticationAsked,
    AuthenticationMethod,
    AuthenticationScheme,
    Change,
    DownloadApprovalAsked,
    Guid,
    Intent,
    JavaScriptDialogKind,
    PageState,
    PermissionAsked,
    ScriptDialogAsked,
    ScriptDialogQuestion,
    SiteOrigin,
} from "../generated/crest_contracts.js";
import { dispatch, query } from "./bridge.js";
import type { FloatEvent } from "./float.js";
import type { Model } from "./model.js";
import type { DialogButton, DialogField, PromptFloatState } from "./prompt-float.js";
import { FloatRank } from "./surfaces.js";
import type { FloatSurface, FloatSurfaces } from "./surfaces.js";

// MARK: - Types

type DialogState = Extract<PromptFloatState, { kind: "dialog" }>;

/** What a dialog shows, before it is tied to its question. */
interface DialogPieces {
    readonly warning: boolean;
    readonly title: string;
    readonly paragraphs: readonly string[];
    readonly fields: readonly DialogField[];
    readonly buttons: readonly DialogButton[];
}

/** A question that covers the page until the person answers it. */
interface ModalQuestion {
    readonly promptId: Guid;
    /** The page it is about, or null for one about the window, such as a download's. */
    readonly pageId: Guid | null;
    dialog(spaceName: (spaceId: Guid | null) => string | null): DialogPieces;
    /** The answer the button at `button` gives, with what the fields hold. */
    answer(button: number, fields: readonly string[]): Intent;
}

/** What names Crest where a question has no server to name, as the Mac's ProductIdentity. */
const productName = "Crest";

const ok: DialogButton = { label: "OK", isDefault: true, isCancel: false };
const cancel: DialogButton = { label: "Cancel", isDefault: false, isCancel: true };

/** The origin as a person reads it: the port only when it is not the scheme's default. */
function displayName(origin: SiteOrigin): string {
    const scheme = WebScheme.all.find((member) => WebScheme.facts[member].name === origin.scheme);
    const port = scheme && WebScheme.facts[scheme].defaultPort === origin.port ? "" : `:${origin.port}`;
    return `${origin.scheme}://${origin.host}${port}`;
}

/**
 * The page's server as a dialog names it, which the core formats: its host,
 * with the port only when it is not the scheme's default.
 */
async function sourceLabel(address: string): Promise<string> {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return productName;
    }
    if (!url.hostname) return productName;
    if (!url.port) return url.hostname;
    try {
        const answer = await query("AuthenticationSource", {
            host: url.hostname,
            port: Number(url.port),
            scheme: url.protocol.replace(/:$/, "") || null,
        });
        return answer.label ?? productName;
    } catch {
        return productName;
    }
}

// MARK: - Script dialogs

/** Each kind of script dialog: what it shows and what its buttons answer, as BrowserDialogPresenter's. */
const scriptDialogs: Readonly<
    Record<
        JavaScriptDialogKind,
        {
            pieces(question: ScriptDialogQuestion, source: string): DialogPieces;
            /** Whether the button at `button` accepts, and the text it answers. */
            answer(button: number, fields: readonly string[]): { accepted: boolean; text: string | null };
        }
    >
> = {
    Alert: {
        pieces: (question, source) => ({
            warning: false,
            title: `${source} says`,
            paragraphs: [question.message],
            fields: [],
            buttons: [{ ...ok, isCancel: true }],
        }),
        answer: () => ({ accepted: true, text: null }),
    },
    Confirm: {
        pieces: (question, source) => ({
            warning: false,
            title: `${source} says`,
            paragraphs: [question.message],
            fields: [],
            buttons: [cancel, ok],
        }),
        answer: (button) => ({ accepted: button === 1, text: null }),
    },
    Prompt: {
        pieces: (question, source) => ({
            warning: false,
            title: `${source} says`,
            paragraphs: [question.message],
            fields: [{ label: "", value: question.defaultText, secret: false }],
            buttons: [cancel, ok],
        }),
        answer: (button, fields) => (button === 1 ? { accepted: true, text: fields[0] ?? "" } : { accepted: false, text: null }),
    },
    // Pages no longer choose the wording of a beforeunload prompt, so the
    // message names the site rather than repeating page-supplied text.
    BeforeUnload: {
        pieces: (_question, source) => ({
            warning: true,
            title: "Leave this page?",
            paragraphs: [`Changes you made on ${source} may not be saved.`],
            fields: [],
            buttons: [
                { label: "Stay on Page", isDefault: false, isCancel: true },
                { label: "Leave Page", isDefault: true, isCancel: false },
            ],
        }),
        answer: (button) => ({ accepted: button === 1, text: null }),
    },
};

class ScriptDialog implements ModalQuestion {
    readonly promptId: Guid;
    readonly pageId: Guid;
    private readonly asked: ScriptDialogAsked;
    private readonly source: string;

    constructor(asked: ScriptDialogAsked, source: string) {
        this.promptId = asked.promptId;
        this.pageId = asked.pageId;
        this.asked = asked;
        this.source = source;
    }

    static async make(asked: ScriptDialogAsked): Promise<ScriptDialog> {
        return new ScriptDialog(asked, await sourceLabel(asked.question.sourceUrl));
    }

    dialog(): DialogPieces {
        return scriptDialogs[this.asked.question.kind].pieces(this.asked.question, this.source);
    }

    answer(button: number, fields: readonly string[]): Intent {
        const { accepted, text } = scriptDialogs[this.asked.question.kind].answer(button, fields);
        return { kind: "AnswerScriptDialog", value: { promptId: this.promptId, accepted, text } };
    }
}

// MARK: - Sign-in

/** The core's method for each scheme a server's challenge names. */
const challengeMethods: Readonly<Record<AuthenticationScheme, AuthenticationMethod>> = {
    Basic: "HttpBasic",
    Digest: "HttpDigest",
};

/**
 * A server's request for a user name and password, as the Mac's
 * presentHTTPAuthentication asks it.
 * TODO(linux): answer from and save to the Space's saved sign-ins once Linux
 * has a credential store; until then the dialog offers no saving.
 */
class SignIn implements ModalQuestion {
    readonly promptId: Guid;
    readonly pageId: Guid;
    private readonly asked: AuthenticationAsked;
    private readonly source: string;
    private readonly secure: boolean;
    private readonly spaceId: Guid | null;

    constructor(asked: AuthenticationAsked, source: string, secure: boolean, spaceId: Guid | null) {
        this.promptId = asked.promptId;
        this.pageId = asked.pageId;
        this.asked = asked;
        this.source = source;
        this.secure = secure;
        this.spaceId = spaceId;
    }

    /**
     * The sign-in to show, or null when the core's rules answer the challenge
     * without asking: a proxy's, or one the server refused too often.
     */
    static async make(asked: AuthenticationAsked, spaceId: Guid | null): Promise<SignIn | null> {
        const question = asked.question;
        let url: URL;
        try {
            url = new URL(question.url);
        } catch {
            return null;
        }
        if (!question.host) return null;
        const { handling } = await query("ChallengeHandling", {
            method: challengeMethods[question.scheme],
            isProxy: question.isProxy,
            previousFailureCount: question.previousFailures,
        });
        if (handling !== "PromptForCredentials") return null;
        const scheme = url.protocol.replace(/:$/, "");
        const { label } = await query("AuthenticationSource", { host: question.host, port: question.port, scheme: scheme || null });
        const secure = WebScheme.all.some((member) => WebScheme.facts[member].name === scheme && WebScheme.facts[member].isSecure);
        return new SignIn(asked, label ?? productName, secure, spaceId);
    }

    dialog(spaceName: (spaceId: Guid | null) => string | null): DialogPieces {
        const question = this.asked.question;
        const space = spaceName(this.spaceId) ?? "";
        const paragraphs: string[] = [];
        if (question.realm) paragraphs.push(`Realm: ${question.realm}`);
        paragraphs.push(
            this.secure
                ? `This sign-in belongs only to the ${space} Space.`
                : `This sign-in belongs only to the ${space} Space and cannot be saved because the connection is not protected by HTTPS.`,
        );
        if (question.previousFailures > 0) paragraphs.push("The previous credentials were not accepted.");
        if (!this.secure) paragraphs.push("Warning: this connection is not protected by HTTPS.");
        return {
            warning: !this.secure,
            title: `Sign in to ${this.source}`,
            paragraphs,
            fields: [
                { label: "Username", value: "", secret: false },
                { label: "Password", value: "", secret: true },
            ],
            buttons: [cancel, { label: "Sign In", isDefault: true, isCancel: false }],
        };
    }

    answer(button: number, fields: readonly string[]): Intent {
        const credential = button === 1 ? { username: fields[0] ?? "", password: fields[1] ?? "" } : null;
        return { kind: "AnswerAuthentication", value: { promptId: this.promptId, credential } };
    }
}

// MARK: - Download approval

/**
 * Whether to go on with a download the core judged dangerous, or to keep one
 * its engine warned about, as the Mac's approveDownload asks it.
 */
class DownloadApproval implements ModalQuestion {
    readonly promptId: Guid;
    readonly pageId = null;
    private readonly asked: DownloadApprovalAsked;

    constructor(asked: DownloadApprovalAsked) {
        this.promptId = asked.promptId;
        this.asked = asked;
    }

    /** A download the engine warned about is already running: the question is whether to keep it. */
    private get keeps(): boolean {
        return this.asked.warning !== null;
    }

    dialog(spaceName: (spaceId: Guid | null) => string | null): DialogPieces {
        const asked = this.asked;
        const paragraphs = asked.reasons.map((reason) => DownloadRiskReason.facts[reason].message.text);
        if (asked.warning) paragraphs.push(DownloadWarning.facts[asked.warning].approvalMessage.text);
        const space = spaceName(asked.spaceId);
        const where = [asked.sourceHost ? `Source: ${asked.sourceHost}` : null, space ? `Space: ${space}` : null];
        const placed = where.filter((part): part is string => part !== null).join(" · ");
        if (placed) paragraphs.push(placed);
        if (!this.keeps) paragraphs.push("Open it only if you trust its source.");
        return {
            warning: true,
            title: this.keeps ? `Keep “${asked.filename}”?` : `Download “${asked.filename}”?`,
            paragraphs,
            fields: [],
            // Keeping a file the engine warned about is never the default.
            buttons: this.keeps
                ? [
                      { label: "Keep Download", isDefault: false, isCancel: false },
                      { label: "Cancel", isDefault: true, isCancel: true },
                  ]
                : [cancel, { label: "Download", isDefault: true, isCancel: false }],
        };
    }

    answer(button: number): Intent {
        const approved = this.keeps ? button === 0 : button === 1;
        return { kind: "AnswerDownloadApproval", value: { promptId: this.promptId, approved } };
    }
}

// MARK: - Prompts

/** A modal question in the order it was asked; `question` is null while it is being prepared. */
interface Waiting {
    readonly promptId: Guid;
    readonly pageId: Guid | null;
    question: ModalQuestion | null;
}

/** The permission card and the margin its shadow draws in. */
const permissionWidth = 280;
const permissionMargin = 8;
const permissionInset = 6;
/** The card's height until the floating page measures it. */
const permissionEstimate = 150;

export interface PromptsContext {
    readonly model: Model;
    /** The page the window shows. */
    readonly page: () => PageState | undefined;
}

export class Prompts {
    private readonly context: PromptsContext;
    private readonly surfaces: FloatSurfaces;
    private readonly modal: FloatSurface;
    private readonly permission: FloatSurface;
    private readonly permissions: PermissionAsked[] = [];
    private readonly modals: Waiting[] = [];
    private readonly heights = new Map<Guid, number>();
    /** The question last placed of each kind, which took the keyboard as it came. */
    private placedModal: Guid | null = null;
    private placedPermission: Guid | null = null;

    constructor(context: PromptsContext, surfaces: FloatSurfaces) {
        this.context = context;
        this.surfaces = surfaces;
        this.modal = {
            rank: FloatRank.modal,
            exclusive: true,
            restore: () => this.placeModal(true),
            handle: (event) => this.handle(event),
        };
        this.permission = {
            rank: FloatRank.permission,
            exclusive: true,
            restore: () => this.placePermission(true),
            handle: () => {},
        };
        surfaces.add(this.modal);
        surfaces.add(this.permission);
        new ResizeObserver(() => this.refresh()).observe(document.getElementById("page")!);
    }

    /** Follows the core's questions in a batch of changes, and the page the window shows. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            switch (change.kind) {
                case "PermissionAsked":
                    this.permissions.push(change.value);
                    break;
                case "ScriptDialogAsked":
                    this.prepare(change.value.promptId, change.value.pageId, ScriptDialog.make(change.value));
                    break;
                case "AuthenticationAsked": {
                    const asked = change.value;
                    const spaceId = this.context.model.pages.get(asked.pageId)?.spaceId ?? null;
                    this.prepare(asked.promptId, asked.pageId, SignIn.make(asked, spaceId), (prepared) => {
                        // The core's rules answer this challenge without asking.
                        if (!prepared) this.send({ kind: "AnswerAuthentication", value: { promptId: asked.promptId, credential: null } });
                    });
                    break;
                }
                case "DownloadApprovalAsked":
                    this.modals.push({ promptId: change.value.promptId, pageId: null, question: new DownloadApproval(change.value) });
                    break;
                case "PromptSettled":
                    this.drop((promptId) => promptId === change.value.promptId);
                    break;
                case "PageRemoved":
                    this.drop((_promptId, pageId) => pageId === change.value.pageId);
                    break;
                default:
                    break;
            }
        }
        this.refresh();
    }

    /** Shows the shown page's questions, or none. */
    refresh(): void {
        this.placeModal(false);
        this.placePermission(false);
    }

    private prepare(
        promptId: Guid,
        pageId: Guid,
        making: Promise<ModalQuestion | null>,
        prepared?: (question: ModalQuestion | null) => void,
    ): void {
        const waiting: Waiting = { promptId, pageId, question: null };
        this.modals.push(waiting);
        making
            .catch((error: unknown) => {
                console.error(error);
                return null;
            })
            .then((question) => {
                const index = this.modals.indexOf(waiting);
                // The core settled it, or its page went, while it was prepared.
                if (index < 0) return;
                if (question) waiting.question = question;
                else this.modals.splice(index, 1);
                prepared?.(question);
                this.refresh();
            });
    }

    private drop(matches: (promptId: Guid, pageId: Guid | null) => boolean): void {
        for (let index = this.modals.length - 1; index >= 0; index--) {
            const waiting = this.modals[index]!;
            if (matches(waiting.promptId, waiting.pageId)) this.modals.splice(index, 1);
        }
        for (let index = this.permissions.length - 1; index >= 0; index--) {
            const asked = this.permissions[index]!;
            if (matches(asked.promptId, asked.pageId)) {
                this.permissions.splice(index, 1);
                this.heights.delete(asked.promptId);
            }
        }
    }

    /** The first question the shown page, or the window, waits on; null while it is prepared. */
    private currentModal(): Waiting | undefined {
        const pageId = this.context.page()?.id ?? null;
        return this.modals.find((waiting) => waiting.pageId === null || waiting.pageId === pageId);
    }

    private currentPermission(): PermissionAsked | undefined {
        const pageId = this.context.page()?.id;
        return pageId ? this.permissions.find((asked) => asked.pageId === pageId) : undefined;
    }

    private spaceName(spaceId: Guid | null): string | null {
        if (!spaceId) return null;
        for (const workspace of this.context.model.workspaces.values()) {
            const space = workspace.spaces.get(spaceId);
            if (space) return space.state.settings.name;
        }
        return null;
    }

    /** A dialog covers the page's card, dimming it, and takes the keyboard. */
    private placeModal(restoring: boolean): void {
        const question = this.currentModal()?.question;
        if (!question) {
            this.placedModal = null;
            this.surfaces.post(this.modal, null);
            return;
        }
        const focus = restoring || this.placedModal !== question.promptId;
        this.placedModal = question.promptId;
        const card = document.getElementById("page")!.getBoundingClientRect();
        const state: DialogState = { kind: "dialog", promptId: question.promptId, ...question.dialog((id) => this.spaceName(id)) };
        this.surfaces.post(this.modal, {
            bounds: { x: card.left, y: card.top, width: card.width, height: card.height },
            focus,
            state,
            band: "card",
        });
    }

    /**
     * A site's request shows as a card at the page's top corner, by the
     * address field, as the Mac's shows from the site control. It takes the
     * keyboard as it comes, as the Mac's popover does.
     */
    private placePermission(restoring: boolean): void {
        const asked = this.currentPermission();
        if (!asked) {
            this.placedPermission = null;
            this.surfaces.post(this.permission, null);
            return;
        }
        const page = this.context.model.pages.get(asked.pageId);
        const question = asked.question;
        const facts = SitePermission.facts[question.permission];
        const space = this.spaceName(page?.spaceId ?? null) ?? "";
        const state: PromptFloatState = {
            kind: "permission",
            promptId: asked.promptId,
            symbol: facts.symbol,
            site: displayName(question.origin),
            request: facts.requestTitle.text,
            inside: displayName(question.origin) !== displayName(question.topLevelOrigin) ? `Inside ${displayName(question.topLevelOrigin)}` : null,
            remember: `Remember in ${space}`,
        };
        const focus = restoring || this.placedPermission !== asked.promptId;
        this.placedPermission = asked.promptId;
        const card = document.getElementById("page")!.getBoundingClientRect();
        const height = (this.heights.get(asked.promptId) ?? permissionEstimate) + 2 * permissionMargin;
        this.surfaces.post(this.permission, {
            bounds: { x: card.left + permissionInset, y: card.top + permissionInset, width: permissionWidth + 2 * permissionMargin, height },
            focus,
            state,
            band: "top",
        });
    }

    private handle(event: FloatEvent): void {
        switch (event.kind) {
            case "dialogAnswer": {
                const index = this.modals.findIndex((waiting) => waiting.promptId === event.promptId);
                const question = this.modals[index]?.question;
                if (!question) return;
                this.modals.splice(index, 1);
                this.send(question.answer(event.button, event.fields));
                this.refresh();
                break;
            }
            case "permissionAnswer": {
                const index = this.permissions.findIndex((asked) => asked.promptId === event.promptId);
                if (index < 0) return;
                this.permissions.splice(index, 1);
                this.heights.delete(event.promptId);
                this.send({
                    kind: "AnswerPermission",
                    value: { promptId: event.promptId, grants: event.grants, remembers: event.remembers },
                });
                this.refresh();
                break;
            }
            case "permissionDismiss": {
                // Dismissing ends every request the page waits on, each
                // denied this once, and saves nothing.
                const pageId = this.permissions.find((asked) => asked.promptId === event.promptId)?.pageId;
                if (!pageId) return;
                for (const asked of this.permissions.filter((waiting) => waiting.pageId === pageId)) {
                    this.permissions.splice(this.permissions.indexOf(asked), 1);
                    this.heights.delete(asked.promptId);
                    this.send({ kind: "AnswerPermission", value: { promptId: asked.promptId, grants: false, remembers: false } });
                }
                this.refresh();
                break;
            }
            case "permissionSize":
                if (this.heights.get(event.promptId) === event.height) return;
                this.heights.set(event.promptId, event.height);
                this.placePermission(false);
                break;
            default:
                break;
        }
    }

    /**
     * Sends an answer. A question the core no longer waits on refuses it,
     * which changes nothing.
     */
    private send(intent: Intent): void {
        void dispatch(intent).catch((error: unknown) => console.error(error));
    }
}
