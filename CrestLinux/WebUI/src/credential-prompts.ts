// Crest's passwords on the pages a window shows, as the Mac's page surface
// runs them (BrowserCredentialSession, BrowserCredentialChrome): each page
// takes the credential bridge once its engine made it; what the bridge says
// about the page this window shows goes to that page's state; and the prompt
// the state calls for floats over the page, anchored under the focused field
// when the core says so (BrowserCredentialPromptPlacement). Filling runs the
// bridge in the frame that asked, saving goes through the Space's vaults,
// and a strong password is drawn here and saved before it is filled.
//
// TODO(linux): a page's site icon in the prompt's header, which Linux's
// pages do not hand the WebUI yet; the Space's key mark shows instead.
// TODO(linux): passkeys (BrowserPasskeyCoordinator), saving what a site's
// HTTP sign-in sheet took (prompt-float.ts), and the prompts in a Quick
// Window, which the Mac all has.

import type { Change, ContentMessagePosted, EnginePresentation, Guid, PageState } from "../generated/crest_contracts.js";
import { pageRequest, query } from "./bridge.js";
import { credentialBridgeSource, credentialHandlerName } from "./credential-bridge.js";
import { credentialCard } from "./credential-float.js";
import type { CredentialPromptBody, CredentialPromptState } from "./credential-float.js";
import { CredentialPageState, formMessage } from "./credential-page.js";
import type { FillRequest, FillTarget, SaveCandidate } from "./credential-page.js";
import { CredentialStore, originDescription } from "./credentials.js";
import type { CredentialDescriptor, CredentialSavePlan } from "./credentials.js";
import type { FloatEvent } from "./float.js";
import type { Model, Space } from "./model.js";
import { shownCard } from "./page-cards.js";
import { measure } from "./page-layers.js";
import { FloatRank } from "./surfaces.js";
import type { FloatSurface, FloatSurfaces } from "./surfaces.js";

// MARK: - Types

export interface CredentialPromptsContext {
    readonly model: Model;
    /** The page the window shows. */
    readonly page: () => PageState | undefined;
    /** The zoom the window set on a page. */
    readonly zoom: (pageId: Guid) => number;
}

/** The pointer shell's measures (BrowserCredentialPromptMetrics.pointer). */
const fillPromptWidth = 360;
const anchoredMinimumWidth = 264;
const savePromptMaximumWidth = 560;
const chromeInset = 12;
const fieldAnchorGap = 5;
/** Room around the card for its shadow, which the surface leaves. */
const shadowMargin = 16;

/** The save prompt's phases (BrowserCredentialSavePromptPhase). */
type SavePhase =
    | { readonly kind: "preparing" }
    | { readonly kind: "ready"; readonly plan: Exclude<CredentialSavePlan, { kind: "AlreadyStored" }> }
    | { readonly kind: "saving"; readonly plan: CredentialSavePlan }
    | { readonly kind: "saved" }
    | { readonly kind: "failedPreparation" }
    | { readonly kind: "failedCommit"; readonly plan: CredentialSavePlan };

/** What the suggestions hold for one fill request (BrowserCredentialSuggestionModel). */
interface Suggestions {
    readonly requestId: Guid;
    phase: "loading" | "loaded" | "failed";
    descriptors: CredentialDescriptor[];
    fillError: string | null;
}

/** The strong password's phases (BrowserStrongPasswordOperationPhase). */
interface StrongPassword {
    readonly requestId: Guid;
    phase: "idle" | "working" | "failedBeforeSave" | "savedButFillFailed";
}

// MARK: - Strong passwords (BrowserStrongPasswordGenerator)

function randomIndex(count: number): number {
    // Rejection sampling keeps every index equally likely.
    const limit = Math.floor(0x1_0000_0000 / count) * count;
    const draw = new Uint32Array(1);
    for (;;) {
        crypto.getRandomValues(draw);
        if (draw[0]! < limit) return draw[0]! % count;
    }
}

/** A password composed as the core's recipe says: one character of each group, the rest from all, shuffled. */
function strongPassword(recipe: { readonly length: number; readonly groups: readonly string[] }): string {
    const groups = recipe.groups.map((group) => [...group]);
    if (groups.length === 0 || groups.some((group) => group.length === 0) || recipe.length < groups.length) {
        throw new Error("The core's strong password recipe can't make a password.");
    }
    const all = groups.flat();
    const password = groups.map((group) => group[randomIndex(group.length)]!);
    while (password.length < recipe.length) password.push(all[randomIndex(all.length)]!);
    for (let index = password.length - 1; index > 0; index--) {
        const other = randomIndex(index + 1);
        [password[index], password[other]] = [password[other]!, password[index]!];
    }
    return password.join("");
}

// MARK: - Prompts

export class CredentialPrompts implements FloatSurface {
    readonly rank = FloatRank.credential;
    readonly exclusive = false;

    private readonly context: CredentialPromptsContext;
    private readonly surfaces: FloatSurfaces;
    private readonly states = new Map<Guid, CredentialPageState>();
    /** The pages that took the bridge, while their engine keeps them. */
    private readonly installed = new Set<Guid>();
    private readonly evaluations = new Map<Guid, (json: string | null) => void>();
    private suggestions: Suggestions | null = null;
    private strong: StrongPassword | null = null;
    private save: { readonly candidateId: Guid; phase: SavePhase } | null = null;

    constructor(context: CredentialPromptsContext, surfaces: FloatSurfaces) {
        this.context = context;
        this.surfaces = surfaces;
        surfaces.add(this);
        new ResizeObserver(() => this.place()).observe(document.getElementById("page")!);
    }

    // MARK: - Following the core

    /** Gives each page the engine made the bridge, and lets go of pages that went. */
    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            if (change.kind === "PageRemoved") {
                this.states.get(change.value.pageId)?.reset();
                this.states.delete(change.value.pageId);
                this.installed.delete(change.value.pageId);
            }
        }
        for (const page of this.context.model.pages.values()) {
            if (page.phase !== "Live") {
                // A page made again takes the bridge again.
                if (this.installed.delete(page.id)) this.states.get(page.id)?.reset();
                continue;
            }
            if (this.installed.has(page.id)) continue;
            this.installed.add(page.id);
            void pageRequest("AddContentScript", { pageId: page.id, source: credentialBridgeSource, mainFrameOnly: false })
                .then((taken) => {
                    if (!taken) this.installed.delete(page.id);
                })
                .catch((error: unknown) => {
                    console.error(error);
                    this.installed.delete(page.id);
                });
        }
        for (const [pageId, state] of this.states) {
            if (!this.isEnabled(this.context.model.pages.get(pageId))) state.reset();
        }
        this.place();
    }

    /** Hears what the page's bridge says, and what its engine does. */
    present(presentation: EnginePresentation): void {
        switch (presentation.kind) {
            case "ContentMessagePosted":
                this.received(presentation.value);
                break;
            case "ContentScriptEvaluated": {
                const answer = this.evaluations.get(presentation.value.evaluationId);
                this.evaluations.delete(presentation.value.evaluationId);
                answer?.(presentation.value.json);
                break;
            }
            case "PageNavigationStarted":
                this.states.get(presentation.value.pageId)?.didStartNavigation();
                break;
            case "PageNavigationCommitted":
                this.states.get(presentation.value.pageId)?.didChangeTopLevelAddress(presentation.value.url);
                break;
            default:
                break;
        }
    }

    private received(posted: ContentMessagePosted): void {
        if (posted.handler !== credentialHandlerName) return;
        // Every window hears the page; the one that shows it answers.
        const page = this.context.page();
        if (!page || page.id !== posted.pageId || !this.isEnabled(page)) return;
        const message = formMessage(posted.body);
        if (!message) return;
        this.state(page.id).receive(message, posted.frame, page.live.url);
    }

    private state(pageId: Guid): CredentialPageState {
        let state = this.states.get(pageId);
        if (!state) {
            state = new CredentialPageState(pageId, () => this.place());
            this.states.set(pageId, state);
        }
        return state;
    }

    private space(page: PageState | undefined): Space | undefined {
        return page ? this.context.model.workspaces.get(page.workspaceId)?.spaces.get(page.spaceId) : undefined;
    }

    private isEnabled(page: PageState | undefined): boolean {
        return this.space(page)?.state.settings.credentialPreferences.isEnabled === true;
    }

    // MARK: - Surface

    restore(): void {
        this.place();
    }

    handle(event: FloatEvent): void {
        const page = this.context.page();
        const state = page ? this.states.get(page.id) : undefined;
        if (!page || !state) return;
        switch (event.kind) {
            case "credentialClose":
                if (state.saveCandidate?.id === event.promptId) state.dismissSaveCandidate();
                else if (state.fillRequest?.id === event.promptId) state.dismissFillRequest();
                this.surfaces.returnKeyboard();
                break;
            case "credentialFill":
                void this.fill(page, state, event.promptId, event.credentialId);
                break;
            case "credentialStrongPassword":
                void this.fillStrongPassword(page, state, event.promptId);
                break;
            case "credentialPrimary":
                void this.commitSave(page, state, event.promptId);
                break;
            default:
                break;
        }
    }

    /** Shows the prompt the shown page calls for, or none (BrowserCredentialChromePresentation). */
    private place(): void {
        const page = this.context.page();
        const state = page ? this.states.get(page.id) : undefined;
        const space = this.space(page);
        if (!page || !state || !space) {
            this.save = null;
            this.suggestions = null;
            this.strong = null;
            this.surfaces.post(this, null);
            return;
        }
        const spaceName = space.state.settings.name;
        const candidate = state.saveCandidate;
        if (candidate) {
            this.placeSave(page, state, candidate, spaceName);
            return;
        }
        this.save = null;
        const request = state.fillRequest;
        if (!request) {
            this.suggestions = null;
            this.strong = null;
            this.surfaces.post(this, null);
            return;
        }
        const card = shownCard().getBoundingClientRect();
        const zoom = this.context.zoom(page.id);
        const field = request.fieldRect
            ? { x: request.fieldRect.x * zoom, y: request.fieldRect.y * zoom, width: request.fieldRect.width * zoom, height: request.fieldRect.height * zoom }
            : null;
        const available = card.width - 2 * chromeInset;
        const width = field
            ? Math.min(Math.min(Math.max(field.width, anchoredMinimumWidth), fillPromptWidth), Math.max(available, 0) || fillPromptWidth)
            : Math.min(fillPromptWidth, Math.max(available, 0));
        const header =
            request.passwordKind === "New"
                ? { symbol: "key.horizontal.fill" as const, title: `Strong Password for ${spaceName}` }
                : { symbol: "key.fill" as const, title: `Passwords in ${spaceName}` };
        let body: CredentialPromptBody;
        let error: string | null = null;
        let notice: string | null = null;
        if (request.passwordKind === "New") {
            if (this.strong?.requestId !== request.id) this.strong = { requestId: request.id, phase: "idle" };
            body = {
                kind: "strongPassword",
                explanation: `Crest saves a unique 20-character password in ${spaceName} first, then fills it here and in the confirmation field.`,
                working: this.strong.phase === "working",
            };
            if (this.strong.phase === "failedBeforeSave") error = "Crest couldn’t save a strong password. Nothing was filled.";
            if (this.strong.phase === "savedButFillFailed") error = "The password is saved in this Space, but the form changed before Crest could fill it.";
            if (request.isCrossOriginFrame) notice = `Embedded password form from ${originDescription(request.topLevelOrigin)}`;
        } else {
            const suggestions = this.loadSuggestions(page, request);
            body = {
                kind: "suggestions",
                loading: suggestions.phase === "loading",
                rows: suggestions.descriptors.map((descriptor) => {
                    const displayName = descriptor.displayName?.trim();
                    const title = displayName || descriptor.username;
                    return { id: descriptor.id, title, detail: title !== descriptor.username ? descriptor.username : null };
                }),
            };
            if (suggestions.phase === "failed") error = "Crest couldn’t read this Space’s passwords.";
            else if (suggestions.fillError) error = suggestions.fillError;
            if (request.isCrossOriginFrame) notice = `Embedded sign-in from ${originDescription(request.topLevelOrigin)}`;
        }
        const prompt: CredentialPromptState = {
            kind: "credential",
            promptId: request.id,
            ...header,
            subtitle: originDescription(request.origin),
            notice,
            body,
            error,
            width,
        };
        this.post(prompt, card, field);
    }

    private placeSave(page: PageState, state: CredentialPageState, candidate: SaveCandidate, spaceName: string): void {
        this.suggestions = null;
        this.strong = null;
        if (this.save?.candidateId !== candidate.id) {
            this.save = { candidateId: candidate.id, phase: { kind: "preparing" } };
            void this.prepareSave(page, state, candidate);
        }
        const phase = this.save.phase;
        const commitTitle = (plan: CredentialSavePlan): string => (plan.kind === "Update" ? "Update password?" : "Save password?");
        const actionTitle = (plan: CredentialSavePlan): string => (plan.kind === "Update" ? `Update in ${spaceName}` : `Save in ${spaceName}`);
        let title: string;
        let primary: string | null = null;
        let dismiss = "Not Now";
        let busy = false;
        let error: string | null = null;
        switch (phase.kind) {
            case "preparing":
                title = "Checking password…";
                busy = true;
                break;
            case "ready":
                title = commitTitle(phase.plan);
                primary = actionTitle(phase.plan);
                break;
            case "saving":
                title = commitTitle(phase.plan);
                busy = true;
                break;
            case "saved":
                title = `Saved in ${spaceName}`;
                dismiss = "Done";
                break;
            case "failedPreparation":
                title = "Couldn’t check password";
                primary = "Try Again";
                error = "Crest couldn’t check this Space’s saved passwords.";
                break;
            case "failedCommit":
                title = commitTitle(phase.plan);
                primary = "Try Again";
                error = `Crest couldn’t save this password to the ${spaceName} Space.`;
                break;
        }
        const card = shownCard().getBoundingClientRect();
        const prompt: CredentialPromptState = {
            kind: "credential",
            promptId: candidate.id,
            symbol: candidate.passwordKind === "New" ? "key.horizontal.fill" : "key.fill",
            title,
            subtitle: `${candidate.username} · ${originDescription(candidate.origin)}`,
            notice: candidate.isCrossOriginFrame
                ? `The credential belongs to the embedded ${originDescription(candidate.origin)} frame, not ${originDescription(candidate.topLevelOrigin)}.`
                : null,
            body: { kind: "save", destination: `Stored only in the ${spaceName} Space`, primary, dismiss, busy },
            error,
            width: Math.max(0, Math.min(savePromptMaximumWidth, card.width - 2 * chromeInset)),
        };
        this.post(prompt, card, null);
    }

    /** Places `prompt` under `field`, or above it where it doesn't fit below; at the page's top without one. */
    private post(prompt: CredentialPromptState, card: DOMRect, field: { x: number; y: number; width: number; height: number } | null): void {
        const size = measure(credentialCard(prompt, () => undefined));
        let x: number;
        let y: number;
        if (field) {
            const below = field.y + field.height + fieldAnchorGap;
            const above = field.y - fieldAnchorGap - size.height;
            const lowest = card.height - chromeInset - size.height;
            const isAbove = !(below <= lowest) && above >= chromeInset;
            const clamp = (value: number, lower: number, upper: number): number => (upper > lower ? Math.min(Math.max(value, lower), upper) : lower);
            x = clamp(field.x, chromeInset, card.width - chromeInset - size.width);
            y = clamp(isAbove ? above : below, chromeInset, lowest);
        } else {
            x = (card.width - size.width) / 2;
            y = chromeInset;
        }
        this.surfaces.post(this, {
            bounds: {
                x: card.left + x - shadowMargin,
                y: card.top + y - shadowMargin,
                width: size.width + 2 * shadowMargin,
                height: size.height + 2 * shadowMargin,
            },
            focus: false,
            state: prompt,
            band: "middle",
        });
    }

    // MARK: - Suggestions

    private loadSuggestions(page: PageState, request: FillRequest): Suggestions {
        if (this.suggestions?.requestId === request.id) return this.suggestions;
        const suggestions: Suggestions = { requestId: request.id, phase: "loading", descriptors: [], fillError: null };
        this.suggestions = suggestions;
        const workspace = this.context.model.workspaces.get(page.workspaceId);
        if (!workspace) {
            suggestions.phase = "failed";
            return suggestions;
        }
        void CredentialStore.shared.suggestions(workspace, page.spaceId, request.origin).then(
            (descriptors) => {
                // The account the page already named comes first.
                const hint = request.usernameHint?.toLocaleLowerCase();
                const index = hint ? descriptors.findIndex((descriptor) => descriptor.username.toLocaleLowerCase() === hint) : -1;
                if (index > 0) descriptors.unshift(...descriptors.splice(index, 1));
                suggestions.descriptors = descriptors;
                suggestions.phase = "loaded";
                if (this.suggestions === suggestions) this.place();
            },
            (error: unknown) => {
                console.error(error);
                suggestions.phase = "failed";
                if (this.suggestions === suggestions) this.place();
            },
        );
        return suggestions;
    }

    private async fill(page: PageState, state: CredentialPageState, requestId: Guid, credentialId: Guid): Promise<void> {
        const suggestions = this.suggestions;
        const workspace = this.context.model.workspaces.get(page.workspaceId);
        if (!suggestions || suggestions.requestId !== requestId || !workspace) return;
        suggestions.fillError = null;
        try {
            const credential = await CredentialStore.shared.credential(workspace, page.spaceId, credentialId);
            if (!credential) {
                suggestions.fillError = "That password is no longer available.";
                this.place();
                return;
            }
            const target = await state.fillTargetFor(requestId, "Saved", credential.descriptor.origin);
            if (!target) throw new Error("The fill is no longer offered.");
            const filled = await this.evaluate(page.id, target, "return globalThis.__crestCredentialBridge?.fill(formID, username, password) === true;", {
                formID: target.formID,
                username: credential.descriptor.username,
                password: credential.password,
            });
            if (!filled) throw new Error("The form changed.");
            void CredentialStore.shared.markUsed(credential).catch((error: unknown) => console.error(error));
            await state.completeFill(credential.descriptor.username, requestId);
            this.surfaces.returnKeyboard();
        } catch (error) {
            console.error(error);
            suggestions.fillError = "The form changed before Crest could fill it.";
            this.place();
        }
    }

    // MARK: - Strong passwords

    private async fillStrongPassword(page: PageState, state: CredentialPageState, requestId: Guid): Promise<void> {
        const request = state.fillRequest;
        const strong = this.strong;
        const workspace = this.context.model.workspaces.get(page.workspaceId);
        if (!request || request.id !== requestId || !strong || strong.requestId !== requestId || strong.phase === "working" || !workspace) return;
        strong.phase = "working";
        this.place();
        let password: string;
        try {
            password = strongPassword(await query("StrongPassword", { length: null }));
            await CredentialStore.shared.commitSave(workspace, page.spaceId, {
                origin: request.origin,
                topLevelOrigin: request.topLevelOrigin,
                username: request.usernameHint ?? "",
                password,
                submittedAt: request.requestedAt,
            });
        } catch (error) {
            console.error(error);
            strong.phase = "failedBeforeSave";
            this.place();
            return;
        }
        try {
            const target = await state.fillTargetFor(requestId, "Generated", null);
            if (!target) throw new Error("The fill is no longer offered.");
            const filled = await this.evaluate(page.id, target, "return globalThis.__crestCredentialBridge?.fillGenerated(formID, password) === true;", {
                formID: target.formID,
                password,
            });
            if (!filled) throw new Error("The form changed.");
            strong.phase = "idle";
            state.completeGeneratedPasswordFill(requestId);
            this.surfaces.returnKeyboard();
        } catch (error) {
            console.error(error);
            strong.phase = "savedButFillFailed";
            this.place();
        }
    }

    // MARK: - Saving

    private async prepareSave(page: PageState, state: CredentialPageState, candidate: SaveCandidate): Promise<void> {
        const save = this.save;
        const workspace = this.context.model.workspaces.get(page.workspaceId);
        if (!save || save.candidateId !== candidate.id) return;
        save.phase = { kind: "preparing" };
        this.place();
        try {
            if (!workspace) throw new Error("The workspace is gone.");
            const plan = await CredentialStore.shared.savePlan(workspace, page.spaceId, candidate);
            if (this.save !== save) return;
            if (plan.kind === "AlreadyStored") {
                // The Space already keeps this password: nothing to ask.
                state.dismissSaveCandidate();
                return;
            }
            save.phase = { kind: "ready", plan };
        } catch (error) {
            console.error(error);
            if (this.save !== save) return;
            save.phase = { kind: "failedPreparation" };
        }
        this.place();
    }

    private async commitSave(page: PageState, state: CredentialPageState, candidateId: Guid): Promise<void> {
        const save = this.save;
        const candidate = state.saveCandidate;
        const workspace = this.context.model.workspaces.get(page.workspaceId);
        if (!save || save.candidateId !== candidateId || !candidate || candidate.id !== candidateId || !workspace) return;
        const phase = save.phase;
        if (phase.kind === "failedPreparation" || phase.kind === "failedCommit") {
            // Trying again checks the Space's passwords first.
            void this.prepareSave(page, state, candidate);
            return;
        }
        if (phase.kind !== "ready") return;
        save.phase = { kind: "saving", plan: phase.plan };
        this.place();
        try {
            await CredentialStore.shared.commitSave(workspace, page.spaceId, candidate);
            if (this.save !== save) return;
            save.phase = { kind: "saved" };
            // TODO(linux): the Mac's offer of a copy to the system's Passwords app,
            // which Linux has no counterpart for.
            state.dismissSaveCandidate();
            this.surfaces.returnKeyboard();
        } catch (error) {
            console.error(error);
            if (this.save !== save) return;
            save.phase = { kind: "failedCommit", plan: phase.plan };
            this.place();
        }
    }

    // MARK: - Running the bridge

    /**
     * Runs `body` in the document `target` names, with `values` bound as
     * constants named for their keys, as WebKit's callAsyncJavaScript binds
     * them, and answers whether it returned true.
     */
    private async evaluate(pageId: Guid, target: FillTarget, body: string, values: Record<string, string>): Promise<boolean> {
        let source = `const __crestArguments = ${JSON.stringify(values)};\n`;
        for (const key of Object.keys(values).sort()) source += `const ${key} = __crestArguments[${JSON.stringify(key)}];\n`;
        source += body;
        const evaluationId = crypto.randomUUID();
        const answered = new Promise<string | null>((resolve) => this.evaluations.set(evaluationId, resolve));
        const taken = await pageRequest("EvaluateContentScript", { pageId, evaluationId, source, frameId: target.frameId }).catch(() => false);
        if (!taken) {
            this.evaluations.delete(evaluationId);
            return false;
        }
        return (await answered) === "true";
    }
}
