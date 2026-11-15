// Setup on Linux, the Mac's onboarding window (BrowserOnboardingWindow) drawn
// over the launch's first window before it opens: the welcome, the look, the
// browsers to bring tabs from, the review of each, making Spaces by hand, and
// the close. The core owns setup (SetupFlowState, SetupDraft): this sends its
// intents and draws what it publishes, and does the parts only the shell can,
// as the Mac's BrowserOnboardingFlow does: finding the other browsers here,
// asking for a data folder, reading a browser's files away from the UI thread,
// and committing the reviewed import.
//
// Left out on Linux, each with a TODO(linux) where it would go: passwords,
// which wait on libsecret (the review's Passwords row says so); extensions,
// which Linux does not install from another browser yet; the Getting Started
// tab, which Linux does not draw yet (the guide Space is shown instead); the
// customization style the look picks for Settings, which Linux does not
// offer; and iCloud, which Linux has none of, so the welcome never waits.

import type {
    Change,
    Guid,
    ImportSource,
    Intent,
    SetupDraftSpace,
    SetupEntry,
    SetupFlowState,
    SetupImportReview,
    SetupLook,
    SetupReviewSpace,
    SetupStep,
    SpaceBranding,
    SpaceCustomization,
    SpaceState,
} from "../generated/crest_contracts.js";
import { ImportSource as ImportSources, SetupPhase, SpaceHouse } from "../generated/crest_contracts.js";
import { dispatch, openWindow, query, queryAway } from "./bridge.js";
import { ImportAccess, InstalledImportSource } from "./import-sources.js";
import type { ImportPayload } from "./import-sources.js";
import type { Model } from "./model.js";
import { completePage, importPage, lookPage, welcomePage } from "./onboarding-pages.js";
import { manualSetupPage, customizationPage } from "./onboarding-make.js";
import { reviewPage } from "./onboarding-review.js";
import { backdropFade, el, previewBranding, StageBackdrop, stageHeader } from "./onboarding-stage.js";
import type { BackAction } from "./onboarding-stage.js";
import { explanation } from "./space-actions.js";

// MARK: - Types

export interface OnboardingHost {
    readonly model: Model;
}

/** Where to ask for a browser setup cannot find yet (BrowserAboutLinks.browserRequest). */
const browserRequest = "https://github.com/pauljoda/Crest/issues/new?template=feature_request.yml&title=Import%20from%20";

/** How long the welcome shows each house before the next (CrestMotion.onboardingWelcomeHold). */
const welcomeHold = 7000;

/** A source Space under review, as the Mac's BrowserImportSpaceReview reads its record. */
export class ReviewSpace {
    readonly record: SetupReviewSpace;

    constructor(record: SetupReviewSpace) {
        this.record = record;
    }

    get id(): Guid {
        return this.record.source.id;
    }

    get source(): SpaceState {
        return this.record.source;
    }

    get isIncluded(): boolean {
        return this.record.included;
    }

    get includedTabIds(): ReadonlySet<Guid> {
        return new Set(this.record.includedTabIds);
    }

    /** The group the Space comes in with: the one it joins, its source's own, or itself. */
    get groupId(): Guid {
        return this.record.joinsGroupOf ?? this.record.source.membership?.primaryId ?? this.record.source.id;
    }

    /** Whether it comes in as a new Space. */
    get comesInNew(): boolean {
        return this.isIncluded && this.record.destinationId === null;
    }

    /** Where `tab` goes: the last placement chosen for it, else its own. */
    placement(tab: SpaceState["tabs"][number]): SpaceState["tabs"][number]["placement"] {
        let placement = tab.placement;
        for (const choice of this.record.placements) if (choice.tabId === tab.id) placement = choice.placement;
        return placement;
    }
}

/** What the review's tabs share across its Spaces (BrowserImportReviewAnalysis). */
export interface ReviewAnalysis {
    readonly duplicateTabIds: ReadonlySet<Guid>;
    readonly overflowTabIds: ReadonlySet<Guid>;
    matchedTabIds(sourceSpaceId: Guid): ReadonlySet<Guid>;
}

// MARK: - Onboarding

export class Onboarding {
    // MARK: - Variables

    readonly host: OnboardingHost;
    readonly node = el("div", "onboarding");
    private readonly backdrop = new StageBackdrop();
    private readonly stage = el("div", "onboarding-stage");

    workspaceId: Guid = "";
    windowId: Guid = "";
    private entry: SetupEntry = "FirstRun";
    private finished: ((guideSpaceId: Guid | null) => void) | null = null;

    installedSources: InstalledImportSource[] = [];
    hasScanned = false;
    private isChoosingDataAccess = false;
    isReading = false;
    isCompletingSetup = false;
    completionFailure: string | null = null;
    manualError: string | null = null;
    private generation = 0;

    selectedManualSpaceId: Guid | null = null;
    customizationSpaceId: Guid | null = null;
    private welcomeHouse = 0;
    private welcomeTimer: number | null = null;

    private previewKey = "";
    private previewSpaces: readonly SpaceState[] | null = null;
    private shown = "";

    // MARK: - Initializers

    constructor(host: OnboardingHost) {
        this.host = host;
        this.node.setAttribute("role", "dialog");
        this.node.setAttribute("aria-label", "Set up Crest");
        this.node.append(this.backdrop.node, this.stage);
        this.node.addEventListener("keydown", (event) => this.handleKey(event));
    }

    // MARK: - Variables - Flow

    get isOpen(): boolean {
        return this.finished !== null;
    }

    get flow(): SetupFlowState | null {
        return this.host.model.setupFlow;
    }

    get step(): SetupStep {
        return this.flow?.step ?? "Welcome";
    }

    get look(): SetupLook {
        return this.flow?.look ?? "Heraldic";
    }

    get review(): SetupImportReview | null {
        return this.flow?.review ?? null;
    }

    get isCommittingImport(): boolean {
        return this.flow?.phase === "Committing";
    }

    /** Whether setup is busy, so its choices hold still. */
    get isLocked(): boolean {
        return this.isReading || this.isChoosingDataAccess || this.isCommittingImport || this.isCompletingSetup;
    }

    get reviewSpaces(): ReviewSpace[] {
        return (this.review?.spaces ?? []).map((record) => new ReviewSpace(record));
    }

    /** The Space under review the page shows: the one the core shows, else the first. */
    shownReview(): ReviewSpace | undefined {
        const spaces = this.reviewSpaces;
        return spaces.find((space) => space.id === this.review?.shownSpaceId) ?? spaces[0];
    }

    analysis(): ReviewAnalysis {
        const review = this.review;
        const matched = new Map((review?.spaces ?? []).map((space) => [space.source.id, new Set(space.matchedTabIds)]));
        return {
            duplicateTabIds: new Set((review?.spaces ?? []).flatMap((space) => space.duplicateTabIds)),
            overflowTabIds: new Set(review?.overflowTabIds ?? []),
            matchedTabIds: (id) => matched.get(id) ?? new Set(),
        };
    }

    /** The Spaces the person already has, in order. */
    get destinationSpaces(): SpaceState[] {
        const workspace = this.host.model.workspace;
        if (!workspace) return [];
        return workspace.order.map((id) => workspace.spaces.get(id)?.state).filter((space): space is SpaceState => space !== undefined);
    }

    get draftSpaces(): readonly SetupDraftSpace[] {
        return this.host.model.setupDraft?.spaces ?? [];
    }

    selectedDraft(): SetupDraftSpace | undefined {
        return this.draftSpaces.find((space) => space.spaceId === this.selectedManualSpaceId);
    }

    /** The included Spaces that come in together with `review`. */
    reviewGroup(review: ReviewSpace): ReviewSpace[] {
        if (!review.isIncluded) return [];
        return this.reviewSpaces.filter((space) => space.isIncluded && space.groupId === review.groupId);
    }

    /** `review`'s Space as Crest would hold it after the import, from the core's preview. */
    previewSpace(review: ReviewSpace): SpaceState | undefined {
        const id = review.record.destinationId ?? review.id;
        return this.previewSpaces?.find((space) => space.id === id);
    }

    get isPreviewReady(): boolean {
        return this.previewKey === this.reviewKey() && this.previewSpaces !== null;
    }

    // MARK: - Actions - Lifecycle

    /**
     * Opens setup at `entry` over the page and answers once the person opens
     * Crest, with the Space whose guide opens next, or closes setup.
     */
    run(workspaceId: Guid, windowId: Guid, entry: SetupEntry): Promise<Guid | null> {
        this.workspaceId = workspaceId;
        this.windowId = windowId;
        this.entry = entry;
        document.body.append(this.node);
        document.body.classList.add("onboarding-open");
        const done = new Promise<Guid | null>((resolve) => (this.finished = resolve));
        void this.start();
        return done;
    }

    private async start(): Promise<void> {
        await this.send({ kind: "StartSetup", value: { workspaceId: this.workspaceId, entry: this.entry } });
        this.render();
        await this.discoverInstalledSources();
        this.repairManualSelection();
        this.render();
        this.node.querySelector<HTMLElement>(".onboarding-button.primary")?.focus();
    }

    /** Ends setup on this page and hands the window back. */
    private end(guideSpaceId: Guid | null): void {
        this.invalidateOperations();
        if (this.welcomeTimer !== null) clearInterval(this.welcomeTimer);
        this.welcomeTimer = null;
        this.node.remove();
        document.body.classList.remove("onboarding-open");
        const finished = this.finished;
        this.finished = null;
        finished?.(guideSpaceId);
    }

    /** Closes setup without finishing it, as closing the Mac's onboarding window does. */
    close(): void {
        if (this.flow?.phase === "Reading") void this.send({ kind: "CancelImportRead", value: {} });
        this.end(null);
    }

    /** Follows the core's changes. */
    follow(changes: readonly Change[]): void {
        if (!this.isOpen) return;
        if (changes.some((change) => change.kind === "SetupFlowChanged")) this.followReview();
        this.render();
    }

    // MARK: - Actions - Steps

    show(step: SetupStep): void {
        if (this.isLocked) return;
        void this.send({ kind: "ShowSetupStep", value: { step } }).then(() => {
            if (step === "ManualSetup") this.repairManualSelection();
            this.render(true);
        });
    }

    continueSetup(): void {
        const next = this.flow?.nextStep;
        if (next) this.show(next);
    }

    /** Back a step, or Close where the entry started here. */
    back(): BackAction {
        const step = this.flow?.backStep;
        if (!step) return { closes: true, action: () => this.close() };
        return { closes: false, action: () => this.show(step) };
    }

    chooseLook(look: SetupLook): void {
        if (this.isLocked) return;
        void this.send({ kind: "ChooseSetupLook", value: { look } });
    }

    /**
     * The look's Continue. The Mac also adopts the customization style that
     * matches the look for Settings.
     * TODO(linux): adopt the matching customization style once Linux's
     * Settings offers one.
     */
    continueFromLook(): void {
        this.continueSetup();
    }

    beginManualSetup(): void {
        if (this.isCommittingImport) return;
        this.abandonImportPreparation();
        this.show("ManualSetup");
    }

    /** Opens Crest from the welcome or the close: setup finishes, as the Mac's BrowserSetupFinish does. */
    async openCrest(): Promise<void> {
        if (this.isLocked) return;
        const generation = this.generation;
        this.isCompletingSetup = true;
        this.completionFailure = null;
        this.render(true);
        let guideSpaceId: Guid | null = null;
        try {
            const changes = await dispatch({ kind: "FinishSetup", value: { windowId: this.windowId } });
            for (const change of changes) if (change.kind === "SetupFinished") guideSpaceId = change.value.guideSpaceId;
        } catch (error) {
            // TODO(linux): a locked guide Space asks to be unlocked on the Mac
            // (GuideSpaceLocked); Linux reports it until it draws that unlock.
            if (generation !== this.generation) return;
            this.isCompletingSetup = false;
            this.completionFailure = explanation(error);
            this.render(true);
            return;
        }
        if (generation !== this.generation) return;
        this.isCompletingSetup = false;
        this.end(guideSpaceId);
    }

    /** Request a browser: the form opens in a Quick Window, as a link from Crest's own pages does. */
    requestBrowser(): void {
        const space = this.destinationSpaces[0];
        if (space) openWindow("quick", null, { space: space.id, url: browserRequest }, true);
    }

    // MARK: - Actions - Sources

    private async discoverInstalledSources(): Promise<void> {
        this.installedSources = await InstalledImportSource.installed();
        await this.offerInstalledSources();
    }

    private async offerInstalledSources(): Promise<void> {
        if (!this.flow) return;
        // TODO(linux): other browsers built on Chromium that setup does not
        // list (OtherChromium), which the Mac's Scan for more finds by app.
        await this.send({ kind: "OfferImportSources", value: { installed: this.installedSources.map((source) => source.application) } });
    }

    /** Scan for more: reads every listed browser's folders again. */
    async scanForMore(): Promise<void> {
        if (this.isLocked) return;
        this.installedSources = await InstalledImportSource.installed();
        this.hasScanned = true;
        await this.offerInstalledSources();
        this.render(true);
    }

    isSelected(source: InstalledImportSource): boolean {
        return this.flow?.selected.includes(source.application) ?? false;
    }

    toggle(source: InstalledImportSource): void {
        if (this.isLocked) return;
        void this.send({ kind: "ToggleImportSource", value: { source: source.application } });
    }

    offeredSource(application: ImportSource): InstalledImportSource | undefined {
        return this.installedSources.find((source) => source.application === application);
    }

    /** What a browser's card says about its data, as the Mac's importAccessLabel does. */
    accessLabel(source: InstalledImportSource): string | null {
        const payload = source.detectedPayload;
        if (source.hasReadableDetectedData && payload) {
            const count = payload.profiles.length;
            return count > 1 ? `${count} profiles found · Review them` : "Browser data found · Review it";
        }
        if (ImportAccess.folder(source.application) !== null) return "Access saved · Ready to review";
        return null;
    }

    // MARK: - Actions - Reading

    async continueImport(): Promise<void> {
        if (this.isLocked) return;
        await this.send({ kind: "ContinueImport", value: {} });
        void this.readCurrentSource();
    }

    cancelImportRead(): void {
        this.generation++;
        this.isReading = false;
        this.isChoosingDataAccess = false;
        void this.send({ kind: "CancelImportRead", value: {} });
        this.render(true);
    }

    private async readCurrentSource(): Promise<void> {
        const flow = this.flow;
        if (!flow || flow.phase !== "Reading" || !flow.source) return;
        const application = flow.source;
        const source = this.offeredSource(application);
        if (!source) {
            await this.send({ kind: "FailImport", value: { source: application, reason: "SourceUnavailable", detail: null } });
            return;
        }
        const detected = source.detectedPayload;
        if (source.hasReadableDetectedData && detected) {
            this.readImport(detected);
            return;
        }
        const generation = this.generation;
        const remembered = await ImportAccess.read(application);
        if (generation !== this.generation) return;
        if (remembered && remembered.profiles.length > 0) {
            this.readImport({ application, profiles: remembered.profiles });
            return;
        }
        if (remembered) ImportAccess.clear(application);
        await this.chooseDataAccess(source);
    }

    /** Asks the person for the browser's data folder, as the Mac's BrowserImportFilePicker does. */
    private async chooseDataAccess(source: InstalledImportSource): Promise<void> {
        const application = source.application;
        this.isChoosingDataAccess = true;
        this.render(true);
        const generation = this.generation;
        const chosen = await ImportAccess.choose(application, source.folder).catch((error: unknown) => {
            console.error(error);
            return null;
        });
        if (generation !== this.generation) return;
        this.isChoosingDataAccess = false;
        if (this.flow?.phase !== "Reading" || this.flow.source !== application) return;
        if (!chosen) {
            await this.send({ kind: "CancelImportRead", value: {} });
            return;
        }
        if (chosen.data.profiles.length === 0) {
            await this.send({ kind: "FailImport", value: { source: application, reason: "DataFolder", detail: null } });
            return;
        }
        ImportAccess.remember(chosen.folder, application);
        this.readImport({ application, profiles: chosen.data.profiles });
    }

    /** Reads the browser's files away from the UI thread and hands the core what they hold to review. */
    private readImport(payload: ImportPayload): void {
        this.isChoosingDataAccess = false;
        this.isReading = true;
        this.render(true);
        const generation = this.generation;
        void queryAway("ReadImport", { source: payload.application, profiles: payload.profiles }).then(
            async (imported) => {
                if (generation !== this.generation) return;
                this.isReading = false;
                try {
                    await dispatch({
                        kind: "ReviewImport",
                        value: {
                            source: payload.application,
                            spaces: imported.spaces,
                            // TODO(linux): passwords wait on reading them through libsecret.
                            passwords: [],
                            // TODO(linux): extensions wait on Linux installing them from another browser.
                            extensions: [],
                            leftOut: imported.leftOut,
                            title: this.offeredSource(payload.application)?.title ?? null,
                        },
                    });
                } catch (error) {
                    await this.send({
                        kind: "FailImport",
                        value: { source: payload.application, reason: "Read", detail: explanation(error) },
                    });
                }
                this.render(true);
            },
            async (error: unknown) => {
                if (generation !== this.generation) return;
                this.isReading = false;
                await this.send({ kind: "FailImport", value: { source: payload.application, reason: "Read", detail: explanation(error) } });
                this.render(true);
            },
        );
    }

    // MARK: - Actions - Review

    showReviewSpace(sourceSpaceId: Guid): void {
        if (sourceSpaceId === this.review?.shownSpaceId) return;
        void this.send({ kind: "ShowImportSpace", value: { sourceSpaceId } });
    }

    /** Next Space, or the import on the last. */
    advanceReview(from: ReviewSpace): void {
        const spaces = this.reviewSpaces;
        const index = spaces.findIndex((space) => space.id === from.id);
        const next = spaces[index + 1];
        if (index >= 0 && next) this.showReviewSpace(next.id);
        else void this.commitReviewedImport();
    }

    customizeImport(sourceSpaceId: Guid, customization: SpaceCustomization): void {
        void this.send({ kind: "CustomizeImportSpace", value: { sourceSpaceId, customization } });
    }

    /** Imports the reviewed Spaces, then reads the next browser the person chose. */
    private async commitReviewedImport(): Promise<void> {
        const review = this.review;
        if (!review || this.isCommittingImport) return;
        try {
            await dispatch({ kind: "BeginImportCommit", value: {} });
        } catch (error) {
            await this.send({ kind: "FailImport", value: { source: review.source, reason: "Import", detail: explanation(error) } });
            return;
        }
        const generation = this.generation;
        try {
            await dispatch({ kind: "ImportReviewedSpaces", value: { workspaceId: this.workspaceId, windowId: this.windowId } });
        } catch (error) {
            if (generation !== this.generation) return;
            await this.send({ kind: "FailImport", value: { source: review.source, reason: "Import", detail: explanation(error) } });
            return;
        }
        if (generation !== this.generation) return;
        // TODO(linux): passwords the review brings are saved here once Linux
        // keeps them (libsecret); none come in until then.
        await this.send({ kind: "FinishImportCommit", value: { passwordCount: 0, unsavedPasswordCount: 0 } });
        await this.readCurrentSource();
    }

    /** Asks the core what the reviewed import would leave the workspace with, once for each set of choices. */
    private followReview(): void {
        const key = this.reviewKey();
        if (key === this.previewKey) return;
        this.previewKey = key;
        this.previewSpaces = null;
        if (!this.review) return;
        void query("ImportPreview", {
            import: { kind: "ImportReviewedSpaces", value: { workspaceId: this.workspaceId, windowId: this.windowId } },
        }).then(
            (imported) => {
                if (this.previewKey !== key) return;
                this.previewSpaces = imported.session.spaces;
                this.render(true);
            },
            (error: unknown) => {
                console.error(error);
                if (this.previewKey !== key) return;
                this.previewSpaces = [];
                this.render(true);
            },
        );
    }

    private reviewKey(): string {
        return this.review ? JSON.stringify(this.review.spaces) : "";
    }

    // MARK: - Actions - Manual setup

    addSetupSpace(): void {
        void this.sendReporting({ kind: "AddSetupSpace", value: {} }).then((sent) => {
            if (!sent) return;
            const added = this.draftSpaces[this.draftSpaces.length - 1];
            if (added) this.selectedManualSpaceId = added.spaceId;
            this.render(true);
        });
    }

    removeSetupSpace(spaceId: Guid): void {
        void this.sendReporting({ kind: "RemoveSetupSpace", value: { spaceId } }).then(() => {
            this.repairManualSelection();
            this.render(true);
        });
    }

    selectSetupSpace(spaceId: Guid): void {
        this.selectedManualSpaceId = spaceId;
        this.render(true);
    }

    customizeSetupSpace(spaceId: Guid, customization: SpaceCustomization): void {
        void this.sendReporting({ kind: "CustomizeSetupSpace", value: { spaceId, customization } });
    }

    private repairManualSelection(): void {
        if (this.selectedDraft()) return;
        this.selectedManualSpaceId = this.draftSpaces[0]?.spaceId ?? null;
    }

    openCustomization(sourceSpaceId: Guid): void {
        this.customizationSpaceId = sourceSpaceId;
        this.render(true);
    }

    closeCustomization(): void {
        this.customizationSpaceId = null;
        this.render(true);
    }

    // MARK: - Actions - Drawing

    /** The field behind the stage, for the step shown (BrowserOnboardingWindowContent.stageBranding). */
    private stageBranding(): SpaceBranding {
        switch (this.step) {
            case "Welcome": {
                const house = SpaceHouse.all[this.welcomeHouse % SpaceHouse.all.length]!;
                return SpaceHouse.facts[house].look;
            }
            case "ManualSetup":
                return this.selectedDraft()?.customization.branding ?? previewBranding(this.look);
            case "Review": {
                const review = this.shownReview();
                return (review && this.previewSpace(review)?.settings.look) ?? previewBranding(this.look);
            }
            case "Complete":
                return this.draftSpaces[0]?.customization.branding ?? previewBranding(this.look);
            default:
                return previewBranding(this.look);
        }
    }

    /** Draws the step, unless nothing it shows changed; `force` draws it anyway. */
    render(force = false): void {
        if (!this.isOpen) return;
        const flow = this.flow;
        const key = JSON.stringify([flow, this.host.model.setupDraft, this.installedSources.length, this.welcomeHouse]);
        if (!force && key === this.shown) return;
        this.shown = key;
        this.followWelcome();
        this.backdrop.show(this.stageBranding(), this.step === "Welcome" ? backdropFade.drift : backdropFade.change);

        // What has the focus and where each list scrolled stay where they were.
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset["focus"] : undefined;
        const selection =
            document.activeElement instanceof HTMLInputElement
                ? ([document.activeElement.selectionStart, document.activeElement.selectionEnd] as const)
                : null;
        const scrolled = new Map<string, number>();
        for (const node of this.stage.querySelectorAll<HTMLElement>("[data-scroll]")) scrolled.set(node.dataset["scroll"]!, node.scrollTop);

        const page = el("div", "onboarding-page");
        page.dataset["step"] = this.step;
        const review =
            this.customizationSpaceId && this.review
                ? this.reviewSpaces.find((space) => space.id === this.customizationSpaceId)
                : undefined;
        if (this.customizationSpaceId && !review) this.customizationSpaceId = null;
        page.append(review ? customizationPage(this, review) : this.page());
        const content: HTMLElement[] = [stageHeader(this.step), page];
        if (this.completionFailure) content.push(el("p", "onboarding-completion-failure", this.completionFailure));
        this.stage.replaceChildren(...content);
        this.stage.classList.toggle("busy", this.isCompletingSetup);

        for (const node of this.stage.querySelectorAll<HTMLElement>("[data-scroll]")) {
            const top = scrolled.get(node.dataset["scroll"]!);
            if (top !== undefined) node.scrollTop = top;
        }
        if (focused) {
            const node = this.stage.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`);
            node?.focus();
            if (node instanceof HTMLInputElement && selection) node.setSelectionRange(selection[0], selection[1]);
        }
    }

    private page(): HTMLElement {
        switch (this.step) {
            case "Welcome":
                return welcomePage(this);
            case "Look":
                return lookPage(this);
            case "ImportBrowser":
                return importPage(this);
            case "Review":
                return reviewPage(this);
            case "ManualSetup":
                return manualSetupPage(this);
            case "Complete":
                return completePage(this);
            default:
                // The feature steps draw nothing, as on the Mac.
                return el("div", "onboarding-empty");
        }
    }

    /** The welcome shows one house after another while it is up. */
    private followWelcome(): void {
        const cycles = this.step === "Welcome" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (cycles && this.welcomeTimer === null) {
            this.welcomeTimer = window.setInterval(() => {
                this.welcomeHouse++;
                this.backdrop.show(this.stageBranding(), backdropFade.drift);
            }, welcomeHold);
        } else if (!cycles && this.welcomeTimer !== null) {
            clearInterval(this.welcomeTimer);
            this.welcomeTimer = null;
        }
    }

    /** Return takes the page's primary button, as the Mac's default action does. */
    private handleKey(event: KeyboardEvent): void {
        if (event.key !== "Enter" || event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof HTMLButtonElement || target instanceof HTMLTextAreaElement) return;
        if (target instanceof HTMLInputElement) {
            target.blur();
            event.preventDefault();
            return;
        }
        const primary = this.stage.querySelector<HTMLButtonElement>(".onboarding-button.continue:not(:disabled)");
        if (!primary) return;
        event.preventDefault();
        primary.click();
    }

    // MARK: - Mutators

    /** Sends `intent`, as the Mac's flow does, leaving a refusal to what the core publishes. */
    async send(intent: Intent): Promise<void> {
        try {
            await dispatch(intent);
        } catch (error) {
            console.error(error);
        }
    }

    /** Sends a manual setup intent, keeping why the core refused it to show (BrowserManualSetupModel). */
    private async sendReporting(intent: Intent): Promise<boolean> {
        try {
            await dispatch(intent);
            this.manualError = null;
            return true;
        } catch (error) {
            this.manualError = explanation(error);
            this.render(true);
            return false;
        }
    }

    private invalidateOperations(): void {
        this.generation++;
        this.isCompletingSetup = false;
        this.completionFailure = null;
        this.isReading = false;
        this.isChoosingDataAccess = false;
    }

    private abandonImportPreparation(): void {
        if (this.isReading || this.isChoosingDataAccess) {
            this.generation++;
            this.isReading = false;
            this.isChoosingDataAccess = false;
        }
        if (this.flow?.phase === "Reading") void this.send({ kind: "CancelImportRead", value: {} });
    }
}

/** Why setup stopped, as the Mac's SetupFailure.message words it. */
export function failureMessage(flow: SetupFlowState | null): string | null {
    const failure = flow?.failure;
    if (!failure) return null;
    if (failure.detail) return failure.detail;
    if (failure.reason !== "DataFolder" || !failure.source) return "That browser is no longer available on this computer.";
    const title = ImportSources.facts[failure.source].title;
    return `Crest could not read ${title} data there. Try Allow Access again, or choose the ${title} data folder if it moved.`;
}

/** Whether the phase keeps setup busy. */
export function isBusy(flow: SetupFlowState | null): boolean {
    return flow ? SetupPhase.facts[flow.phase].isBusy : false;
}
