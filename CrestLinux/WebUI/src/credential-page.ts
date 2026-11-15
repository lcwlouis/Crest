// What a page's credential bridge says, and what Crest does about it, as the
// Mac's BrowserCredentialFormMessage, BrowserCredentialFormEvent and
// BrowserCredentialPageState: each message is checked against its event's
// contract, the core decides what it means (CredentialCapture), and the page
// keeps the one fill it offers and the one save it holds. Passwords stay
// here, in the shell, for as long as the core's lifetimes allow.

import type {
    ContentFrame,
    CredentialCaptureAction,
    CredentialCaptureDecision,
    CredentialCaptureEvent,
    CredentialFillSource,
    CredentialFormFacts,
    CredentialOrigin,
    CredentialPasswordKind,
    Guid,
} from "../generated/crest_contracts.js";
import { query } from "./bridge.js";
import { credentialOrigin, sameOrigin } from "./credentials.js";

// MARK: - Types

/** Where a field sits in its frame's viewport, in CSS pixels (BrowserCredentialFieldRect). */
export interface FieldRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** A fill the page offers (BrowserCredentialFillRequest). */
export interface FillRequest {
    readonly id: Guid;
    readonly origin: CredentialOrigin;
    readonly topLevelOrigin: CredentialOrigin;
    readonly usernameHint: string | null;
    readonly passwordKind: CredentialPasswordKind;
    readonly isCrossOriginFrame: boolean;
    /** Seconds since 1970. */
    readonly requestedAt: number;
    /** The field the prompt is anchored under, in the main frame; null for a prompt at the page's top. */
    readonly fieldRect: FieldRect | null;
}

/** A sign-in the page submitted, which Crest may offer to save (BrowserCredentialSaveCandidate). */
export interface SaveCandidate {
    readonly id: Guid;
    readonly origin: CredentialOrigin;
    readonly topLevelOrigin: CredentialOrigin;
    readonly username: string;
    readonly password: string;
    readonly passwordKind: CredentialPasswordKind;
    readonly isCrossOriginFrame: boolean;
    /** Seconds since 1970. */
    readonly submittedAt: number;
}

/** Where a fill goes: the bridge's form, in the frame that posted it. */
export interface FillTarget {
    readonly formID: string;
    readonly frameId: string;
}

/** The fields a message carries, as its event's contract reads them (BrowserCredentialFormFields). */
interface FormFields {
    readonly formID: string | null;
    readonly username: string | null;
    readonly password: string | null;
    readonly passwordKind: CredentialPasswordKind | null;
    readonly isTrustedUserEvent: boolean;
    readonly hasVisiblePasswordField: boolean | null;
    readonly fieldRect: FieldRect | null;
    readonly containsUsername: boolean;
    readonly containsPassword: boolean;
    readonly containsPasswordKind: boolean;
}

// MARK: - Events (BrowserCredentialFormEvent)

/** One of the bridge's events, the core's capture event it stands for, and the contract its fields keep. */
class FormEvent {
    static readonly username = new FormEvent("username", "Username", false, false, (fields) =>
        fields.formID !== null && fields.username !== null && fields.isTrustedUserEvent && !fields.containsPassword && !fields.containsPasswordKind);
    static readonly focus = new FormEvent("focus", "Focus", true, false, (fields) =>
        fields.formID !== null &&
        fields.isTrustedUserEvent &&
        !(fields.containsUsername && fields.username === null) &&
        !fields.containsPassword &&
        fields.passwordKind !== null);
    static readonly submit = new FormEvent("submit", "Submit", false, false, (fields) =>
        fields.formID !== null &&
        fields.isTrustedUserEvent &&
        !(fields.containsUsername && fields.username === null) &&
        !(fields.containsPassword && fields.password === null) &&
        !(fields.containsPasswordKind && fields.passwordKind === null) &&
        fields.password !== null &&
        fields.passwordKind !== null);
    static readonly documentState = new FormEvent("documentState", "DocumentState", false, true, (fields) =>
        fields.hasVisiblePasswordField !== null && !fields.containsUsername && !fields.containsPassword && !fields.containsPasswordKind);
    // Geometry and nothing else: a scroll is no trusted gesture, and no
    // credential material is taken, so it cannot be a way in for anything but a rect.
    static readonly fieldGeometry = new FormEvent("fieldGeometry", null, false, false, (fields) =>
        fields.formID !== null && fields.fieldRect !== null && !fields.containsUsername && !fields.containsPassword && !fields.containsPasswordKind);
    static readonly all = [FormEvent.username, FormEvent.focus, FormEvent.submit, FormEvent.documentState, FormEvent.fieldGeometry];

    readonly name: string;
    readonly captureEvent: CredentialCaptureEvent | null;
    readonly closesFillWhenRefused: boolean;
    readonly weighsPendingCandidate: boolean;
    readonly accepts: (fields: FormFields) => boolean;

    private constructor(
        name: string,
        captureEvent: CredentialCaptureEvent | null,
        closesFillWhenRefused: boolean,
        weighsPendingCandidate: boolean,
        accepts: (fields: FormFields) => boolean,
    ) {
        this.name = name;
        this.captureEvent = captureEvent;
        this.closesFillWhenRefused = closesFillWhenRefused;
        this.weighsPendingCandidate = weighsPendingCandidate;
        this.accepts = accepts;
    }
}

// MARK: - Messages (BrowserCredentialFormMessage)

const contractVersion = 1;
const maximumFormIDLength = 256;
const maximumUsernameLength = 1_024;
const maximumPasswordLength = 16_384;
const coordinateLimit = 1_000_000;

/** A message the bridge posted, checked against its event's contract. */
export interface FormMessage extends FormFields {
    readonly event: FormEvent;
}

function nonemptyString(value: unknown, maximumLength: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && [...trimmed].length <= maximumLength ? trimmed : null;
}

function fieldRectOf(value: unknown): FieldRect | null {
    if (typeof value !== "object" || value === null) return null;
    const fields = value as Record<string, unknown>;
    const coordinates = [fields["x"], fields["y"], fields["width"], fields["height"]];
    if (!coordinates.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= coordinateLimit)) return null;
    const [x, y, width, height] = coordinates as number[];
    return width! > 0 && height! > 0 ? { x: x!, y: y!, width: width!, height: height! } : null;
}

/** The message `json` holds, or null for one that breaks the contract. */
export function formMessage(json: string): FormMessage | null {
    let body: unknown;
    try {
        body = JSON.parse(json);
    } catch {
        return null;
    }
    if (typeof body !== "object" || body === null) return null;
    const value = body as Record<string, unknown>;
    if (value["version"] !== contractVersion) return null;
    const event = FormEvent.all.find((candidate) => candidate.name === value["event"]);
    if (!event) return null;
    const kind = value["passwordKind"];
    const fields: FormFields = {
        formID: nonemptyString(value["formID"], maximumFormIDLength),
        username: nonemptyString(value["username"], maximumUsernameLength),
        password: nonemptyString(value["password"], maximumPasswordLength),
        passwordKind: kind === "current" ? "Current" : kind === "new" ? "New" : null,
        isTrustedUserEvent: value["trusted"] === true,
        hasVisiblePasswordField: typeof value["hasVisiblePasswordField"] === "boolean" ? value["hasVisiblePasswordField"] : null,
        fieldRect: fieldRectOf(value["fieldRect"]),
        containsUsername: "username" in value,
        containsPassword: "password" in value,
        containsPasswordKind: "passwordKind" in value,
    };
    return event.accepts(fields) ? { event, ...fields } : null;
}

/** The origin of the frame that posted, as its protocol, host and port name it. */
export function frameOrigin(frame: ContentFrame): CredentialOrigin | null {
    const host = frame.host.includes(":") && !frame.host.startsWith("[") ? `[${frame.host}]` : frame.host;
    if (!host) return null;
    const port = frame.port > 0 ? `:${frame.port}` : "";
    return credentialOrigin(`${frame.protocol.replace(/:$/, "")}://${host}${port}`);
}

function rectsDiffer(left: FieldRect | null, right: FieldRect | null): boolean {
    return !left || !right || left.x !== right.x || left.y !== right.y || left.width !== right.width || left.height !== right.height;
}

// MARK: - Page state (BrowserCredentialPageState)

/** A username a page took one step before its password, as the core may pair it. */
interface UsernameHint {
    readonly origin: CredentialOrigin;
    readonly topLevelOrigin: CredentialOrigin;
    readonly username: string;
    readonly capturedAt: number;
}

/** What one message told the page, with the core's decision about it. */
interface Observation {
    readonly message: FormMessage;
    readonly frameOrigin: CredentialOrigin;
    readonly topLevelOrigin: CredentialOrigin;
    readonly fillTarget: FillTarget | null;
    readonly decision: CredentialCaptureDecision;
    readonly now: number;
}

/** Each of the core's capture actions, taken on a page (CredentialCapturePerformer). */
const captureActions: Readonly<Record<CredentialCaptureAction, (page: CredentialPageState, observation: Observation) => void>> = {
    Ignore: () => undefined,
    RememberUsername: (page, observation) => page.rememberObservedUsername(observation),
    DismissFill: (page) => page.dismissFillRequest(),
    OfferFill: (page, observation) => page.offerFill(observation),
    CaptureCandidate: (page, observation) => page.captureCandidate(observation),
    OfferSave: (page) => page.offerSave(),
    KeepPending: () => undefined,
    DiscardPending: (page) => page.discardPending(),
};

function now(): number {
    return Date.now() / 1000;
}

/** One page's fill and save, as the core decides them from what its bridge says. */
export class CredentialPageState {
    readonly pageId: Guid;
    fillRequest: FillRequest | null = null;
    saveCandidate: SaveCandidate | null = null;

    private readonly changed: () => void;
    private fillTarget: FillTarget | null = null;
    private usernameHint: UsernameHint | null = null;
    private usernameTimer: number | null = null;
    private pendingCandidate: SaveCandidate | null = null;
    private candidateTimer: number | null = null;
    /** Messages take turns, as the Mac's main actor takes them, since each asks the core. */
    private turn: Promise<void> = Promise.resolve();

    constructor(pageId: Guid, changed: () => void) {
        this.pageId = pageId;
        this.changed = changed;
    }

    // MARK: - Receiving

    /** Hears one message from the frame `frame` of a page at `topLevelAddress`. */
    receive(message: FormMessage, frame: ContentFrame, topLevelAddress: string | null): void {
        const origin = frameOrigin(frame);
        const topLevelOrigin = topLevelAddress ? credentialOrigin(topLevelAddress) : null;
        if (!origin || !topLevelOrigin) return;
        // A fill goes to the very document that posted, never to one the frame navigated to since.
        const fillTarget = message.formID ? { formID: message.formID, frameId: frame.id } : null;
        this.turn = this.turn
            .then(() => this.take(message, origin, topLevelOrigin, frame.isMainFrame, fillTarget))
            .catch((error: unknown) => console.error(error));
    }

    private async take(
        message: FormMessage,
        frameOrigin: CredentialOrigin,
        topLevelOrigin: CredentialOrigin,
        isMainFrame: boolean,
        fillTarget: FillTarget | null,
    ): Promise<void> {
        const event = message.event.captureEvent;
        if (!event) {
            this.followField(message, frameOrigin, isMainFrame);
            return;
        }
        const at = now();
        const facts: CredentialFormFacts = {
            event,
            frameOrigin,
            topLevelOrigin,
            isMainFrame,
            hasFormId: message.formID !== null,
            hasUsername: message.username !== null,
            hasPassword: message.password !== null,
            passwordKind: message.passwordKind,
            hasVisiblePasswordField: message.hasVisiblePasswordField,
            hasFillTarget: fillTarget !== null,
        };
        const decision = await this.captureDecision(facts, this.usernameHint, message.event.weighsPendingCandidate ? this.pendingCandidate : null, at);
        if (!decision) {
            if (message.event.closesFillWhenRefused) this.dismissFillRequest();
            return;
        }
        if (decision.clearsUsernameHint) this.clearUsernameHint();
        captureActions[decision.action](this, { message, frameOrigin, topLevelOrigin, fillTarget, decision, now: at });
    }

    /** Moves the prompt with the field it is anchored under, as the page scrolls. */
    private followField(message: FormMessage, origin: CredentialOrigin, isMainFrame: boolean): void {
        const request = this.fillRequest;
        if (
            !isMainFrame ||
            !request ||
            !request.fieldRect ||
            !message.formID ||
            message.formID !== this.fillTarget?.formID ||
            !sameOrigin(request.origin, origin) ||
            !message.fieldRect ||
            !rectsDiffer(message.fieldRect, request.fieldRect)
        ) {
            return;
        }
        this.fillRequest = { ...request, fieldRect: message.fieldRect };
        this.changed();
    }

    // MARK: - Filling

    /** Where the fill `requestId` goes, when it is still the one offered and the core allows it. */
    async fillTargetFor(requestId: Guid, source: CredentialFillSource, origin: CredentialOrigin | null): Promise<FillTarget | null> {
        const request = this.fillRequest;
        if (!request || request.id !== requestId || !this.fillTarget) return null;
        if (origin && !sameOrigin(origin, request.origin)) return null;
        if (!(await this.fillAllowed(source, request.passwordKind))) return null;
        return this.fillRequest?.id === requestId ? this.fillTarget : null;
    }

    /** The saved password filled: its username is remembered as the core says, and the fill ends. */
    async completeFill(username: string, requestId: Guid): Promise<void> {
        const request = this.fillRequest;
        if (!request || request.id !== requestId) return;
        const facts: CredentialFormFacts = {
            event: "Filled",
            frameOrigin: request.origin,
            topLevelOrigin: request.topLevelOrigin,
            isMainFrame: request.fieldRect !== null,
            hasFormId: this.fillTarget !== null,
            hasUsername: true,
            hasPassword: false,
            passwordKind: request.passwordKind,
            hasVisiblePasswordField: null,
            hasFillTarget: true,
        };
        const decision = await this.captureDecision(facts, null, null, now());
        if (decision?.action === "RememberUsername") {
            this.rememberUsername(username, request.origin, request.topLevelOrigin, decision.usernameHintLifetime);
        }
        this.dismissFillRequest();
    }

    completeGeneratedPasswordFill(requestId: Guid): void {
        if (this.fillRequest?.id === requestId) this.dismissFillRequest();
    }

    dismissFillRequest(): void {
        this.fillTarget = null;
        if (!this.fillRequest) return;
        this.fillRequest = null;
        this.changed();
    }

    dismissSaveCandidate(): void {
        this.pendingCandidate = null;
        if (this.candidateTimer !== null) clearTimeout(this.candidateTimer);
        this.candidateTimer = null;
        if (!this.saveCandidate) return;
        this.saveCandidate = null;
        this.changed();
    }

    // MARK: - Navigation

    /** The page's address changed: a username taken for another site goes. */
    didChangeTopLevelAddress(address: string | null): void {
        const hint = this.usernameHint;
        const origin = address ? credentialOrigin(address) : null;
        if (hint && origin && !sameOrigin(origin, hint.topLevelOrigin)) this.clearUsernameHint();
    }

    didStartNavigation(): void {
        this.dismissFillRequest();
    }

    reset(): void {
        this.dismissFillRequest();
        this.dismissSaveCandidate();
        this.clearUsernameHint();
    }

    // MARK: - Capture actions

    rememberObservedUsername(observation: Observation): void {
        const username = observation.message.username;
        if (username) this.rememberUsername(username, observation.frameOrigin, observation.topLevelOrigin, observation.decision.usernameHintLifetime);
    }

    offerFill(observation: Observation): void {
        const { message, decision } = observation;
        if (!message.passwordKind || !message.formID || !observation.fillTarget) return;
        this.fillTarget = observation.fillTarget;
        this.fillRequest = {
            id: crypto.randomUUID(),
            origin: observation.frameOrigin,
            topLevelOrigin: observation.topLevelOrigin,
            usernameHint: this.username(decision, message.username),
            passwordKind: message.passwordKind,
            isCrossOriginFrame: decision.isCrossOriginFrame,
            requestedAt: observation.now,
            fieldRect: decision.anchorsToField ? message.fieldRect : null,
        };
        this.changed();
    }

    captureCandidate(observation: Observation): void {
        const { message, decision } = observation;
        const username = this.username(decision, message.username);
        if (username === null || !message.password || !message.passwordKind) return;
        this.dismissSaveCandidate();
        const candidate: SaveCandidate = {
            id: crypto.randomUUID(),
            origin: observation.frameOrigin,
            topLevelOrigin: observation.topLevelOrigin,
            username,
            password: message.password,
            passwordKind: message.passwordKind,
            isCrossOriginFrame: decision.isCrossOriginFrame,
            submittedAt: observation.now,
        };
        this.dismissFillRequest();
        this.clearUsernameHint();
        this.pendingCandidate = candidate;
        this.candidateTimer = window.setTimeout(() => {
            this.candidateTimer = null;
            if (this.pendingCandidate?.id === candidate.id) this.pendingCandidate = null;
            if (this.saveCandidate?.id === candidate.id) {
                this.saveCandidate = null;
                this.changed();
            }
        }, decision.candidateLifetime * 1000);
    }

    offerSave(): void {
        const candidate = this.pendingCandidate;
        if (!candidate) return;
        this.pendingCandidate = null;
        this.saveCandidate = candidate;
        this.changed();
    }

    discardPending(): void {
        this.pendingCandidate = null;
    }

    // MARK: - The core's answers

    private async captureDecision(
        facts: CredentialFormFacts,
        hint: UsernameHint | null,
        pending: SaveCandidate | null,
        at: number,
    ): Promise<CredentialCaptureDecision | null> {
        try {
            const decision = await query("CredentialCapture", {
                facts,
                hint: hint ? { origin: hint.origin, topLevelOrigin: hint.topLevelOrigin, capturedAt: hint.capturedAt } : null,
                pending: pending ? { origin: pending.origin, submittedAt: pending.submittedAt } : null,
                now: at,
            });
            return decision.candidateLifetime > 0 && decision.usernameHintLifetime > 0 ? decision : null;
        } catch {
            return null;
        }
    }

    private async fillAllowed(source: CredentialFillSource, passwordKind: CredentialPasswordKind): Promise<boolean> {
        try {
            return (await query("CredentialFill", { source, passwordKind })).isAllowed;
        } catch {
            return false;
        }
    }

    private username(decision: CredentialCaptureDecision, explicit: string | null): string | null {
        if (decision.usernameSource === "Explicit") return explicit;
        if (decision.usernameSource === "Hint") return this.usernameHint?.username ?? null;
        return null;
    }

    private rememberUsername(username: string, origin: CredentialOrigin, topLevelOrigin: CredentialOrigin, lifetime: number): void {
        const hint = { origin, topLevelOrigin, username, capturedAt: now() };
        this.usernameHint = hint;
        if (this.usernameTimer !== null) clearTimeout(this.usernameTimer);
        this.usernameTimer = window.setTimeout(() => {
            this.usernameTimer = null;
            if (this.usernameHint === hint) this.usernameHint = null;
        }, lifetime * 1000);
    }

    private clearUsernameHint(): void {
        if (this.usernameTimer !== null) clearTimeout(this.usernameTimer);
        this.usernameTimer = null;
        this.usernameHint = null;
    }
}
