// The review a Chrome Web Store install waits on, as the Mac's
// BrowserChromeWebStoreInstallView draws it: the package downloading, then
// the question the core asks once the engine verified it (the extension's
// name, version, permissions and whether its website access is withheld),
// the Spaces a copy also goes to, and how the install ended. The core runs
// the install; the review only shows what it publishes and answers its
// question (AnswerExtensionInstall) or cancels it (CancelExtensionInstall).

import { ExtensionInstallFailure, ExtensionInstallStage } from "../generated/crest_contracts.js";
import type { ExtensionInstallAsked, ExtensionInstallState, Guid } from "../generated/crest_contracts.js";
import { extensionIconUrl } from "./extensions.js";
import type { ExtensionStore } from "./extensions.js";
import type { Space } from "./model.js";
import { holdOverlay } from "./overlay.js";
import { element } from "./settings-form.js";
import { sfSymbol } from "./symbols.js";

/** How long Add Extension waits before it takes a click, so a click meant for the page never installs. */
const acceptDelay = 500;

export class InstallReview {
    // MARK: - Variables

    readonly installId: Guid = crypto.randomUUID();
    private readonly store: ExtensionStore;
    private readonly extensionId: string;
    private readonly space: Space;
    private readonly onClosed: () => void;
    private readonly release: () => void;
    private readonly layer: HTMLElement;
    private readonly card: HTMLElement;
    private asked: ExtensionInstallAsked | null = null;
    /** Whether the question was answered, so it is answered once. */
    private answered = false;
    private canAccept = false;
    private withholds = false;
    private accessExpanded = true;
    private selectingSpaces = false;
    private readonly selected: Set<Guid>;
    private destinations: Space[] = [];
    private downloadedFraction: number | null = null;
    private closed = false;

    // MARK: - Initializers

    constructor(store: ExtensionStore, extensionId: string, space: Space, copies: readonly Guid[], onClosed: () => void) {
        this.store = store;
        this.extensionId = extensionId;
        this.space = space;
        this.selected = new Set(copies);
        this.onClosed = onClosed;
        this.release = holdOverlay();
        this.layer = element("div", "extension-review-layer");
        this.card = element("div", "extension-review");
        this.card.setAttribute("role", "dialog");
        this.card.setAttribute("aria-modal", "true");
        this.layer.append(this.card);
        this.layer.addEventListener("pointerdown", (event) => {
            if (event.target === this.layer && !this.installing) this.dismiss();
        });
        window.addEventListener("keydown", this.onKey, true);
        document.body.append(this.layer);
        void store.destinations(extensionId, space).then(({ spaces }) => {
            this.destinations = spaces;
            this.draw();
        });
        this.draw();
    }

    // MARK: - Actions - Following the install

    private get state(): ExtensionInstallState | undefined {
        return this.store.install(this.installId);
    }

    private get stage(): (typeof ExtensionInstallStage.facts)[ExtensionInstallStage] | null {
        const state = this.state;
        return state ? ExtensionInstallStage.facts[state.stage] : null;
    }

    private get preparing(): boolean {
        return this.stage?.isPreparing ?? true;
    }

    private get installing(): boolean {
        return this.stage?.isInstalling ?? false;
    }

    private get completed(): boolean {
        return this.stage?.hasInstalled ?? false;
    }

    /** The core published a change to the install. */
    refresh(): void {
        const failure = this.state?.failure;
        if (failure && ExtensionInstallFailure.facts[failure].closesReview) {
            this.close(false);
            return;
        }
        this.draw();
    }

    /** The package's download reached `fraction`. */
    downloaded(fraction: number): void {
        this.downloadedFraction = fraction;
        this.draw();
    }

    /** The core asks whether to install the verified package. */
    ask(asked: ExtensionInstallAsked): void {
        if (this.asked?.promptId === asked.promptId) return;
        this.asked = asked;
        this.answered = false;
        this.canAccept = false;
        this.withholds = asked.question.withholdsSiteAccess;
        window.setTimeout(() => {
            this.canAccept = true;
            this.draw();
        }, acceptDelay);
        this.draw();
    }

    // MARK: - Actions - Answering

    private accept(): void {
        const asked = this.asked;
        if (!asked || !this.canAccept || this.answered) return;
        this.answered = true;
        const copies = this.destinations.filter((space) => this.selected.has(space.state.id)).map((space) => space.state.id);
        void this.store.send(
            { kind: "AnswerExtensionInstall", value: { promptId: asked.promptId, accepted: true, withholdsSiteAccess: this.withholds, copySpaceIds: copies } },
            false,
        );
        this.draw();
    }

    /** Cancel, Done, Escape or a click outside: an install still running is canceled. */
    private dismiss(): void {
        if (!this.stage?.hasEnded) void this.store.send({ kind: "CancelExtensionInstall", value: { installId: this.installId } }, false);
        this.close(this.completed);
    }

    /** Takes the review away, however the install ended. */
    close(_installed: boolean): void {
        if (this.closed) return;
        this.closed = true;
        window.removeEventListener("keydown", this.onKey, true);
        this.layer.remove();
        this.release();
        this.onClosed();
    }

    private readonly onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            if (this.selectingSpaces) {
                this.selectingSpaces = false;
                this.draw();
            } else if (!this.installing) {
                this.dismiss();
            }
        } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLInputElement)) {
            event.preventDefault();
            if (this.completed) this.dismiss();
            else if (!this.selectingSpaces) this.accept();
        }
        event.stopPropagation();
    };

    // MARK: - Actions - Drawing

    private draw(): void {
        if (this.closed) return;
        this.card.replaceChildren(...(this.selectingSpaces ? this.spacesPage() : this.reviewPage()));
    }

    private reviewPage(): HTMLElement[] {
        const nodes: HTMLElement[] = [];
        const question = this.asked?.question ?? null;
        const state = this.state;
        const name = question?.name || null;

        const header = element("div", "extension-review-header");
        header.append(iconView(question ? extensionIconUrl(question.icon) : this.store.icon(this.extensionId, this.space), 40));
        const titles = element("div", "extension-review-titles");
        titles.append(element("h2", "extension-review-title", this.completed ? "Extension Installed" : (name ?? "Install Extension")));
        if (question) titles.append(labelled("checkmark.seal.fill", "Verified Chrome Web Store package", "extension-review-verified"));
        header.append(titles);
        nodes.push(header);

        if (this.preparing) {
            const fraction = this.downloadedFraction;
            if (fraction !== null && fraction < 1) {
                const progress = element("div", "extension-review-progress");
                progress.append(element("span", "extension-review-secondary", "Downloading extension…"));
                const bar = element("progress", "");
                bar.max = 1;
                bar.value = fraction;
                progress.append(bar);
                nodes.push(progress);
            } else {
                const progress = element("div", "extension-review-progress inline");
                progress.append(element("span", "extension-review-spinner"), element("span", "extension-review-secondary", "Preparing extension…"));
                nodes.push(progress);
            }
        } else if (this.completed) {
            nodes.push(labelled("checkmark.circle.fill", `${name ?? "Extension"} is ready in ${this.space.state.settings.name}.`, "extension-review-done"));
            if (state && state.installedCount > 1) nodes.push(element("p", "extension-review-callout", `Installed in ${state.installedCount - 1} additional Spaces.`));
        } else if (question) {
            const body = element("div", "extension-review-body");
            if (this.installing) body.classList.add("disabled");
            if (question.summary) body.append(element("p", "extension-review-secondary", question.summary));
            body.append(
                labeledContent("Install In", `${this.space.state.settings.name} Space`),
                labeledContent("Version", question.version),
                element("p", "extension-review-caption", "Only install extensions you trust. Review the access below before installing."),
            );
            const disclosure = element("details", "extension-review-access");
            disclosure.open = this.accessExpanded;
            disclosure.addEventListener("toggle", () => (this.accessExpanded = disclosure.open));
            const summary = element("summary", "");
            summary.append(labelled("hand.raised.fill", "Review Access and Compatibility", ""));
            disclosure.append(summary);
            const access = element("div", "extension-review-access-list");
            access.append(element("h3", "", `Permissions and Website Access (${question.permissions.length})`));
            if (question.permissions.length === 0) {
                access.append(element("p", "extension-review-secondary", "No additional browser permissions requested."));
            } else {
                const list = element("ul", "");
                for (const permission of question.permissions) list.append(element("li", "", permission));
                access.append(list);
            }
            if (question.canWithholdSiteAccess) {
                const label = element("label", "extension-review-check");
                const box = element("input", "");
                box.type = "checkbox";
                box.checked = this.withholds;
                box.disabled = this.installing;
                box.addEventListener("change", () => (this.withholds = box.checked));
                label.append(box, document.createTextNode("Withhold website access until I grant it"));
                access.append(label);
            }
            disclosure.append(access);
            body.append(disclosure);
            nodes.push(body);
            const others = reviewButton("Install in other Spaces…", "plain", () => {
                this.selectingSpaces = true;
                this.draw();
            });
            others.disabled = this.installing || this.answered;
            nodes.push(others);
            if (this.selected.size > 0) nodes.push(element("p", "extension-review-caption", `Additional Spaces: ${this.selected.size}`));
        }

        if (state?.failure) {
            nodes.push(labelled("exclamationmark.triangle.fill", ExtensionInstallFailure.facts[state.failure].message.text, "extension-review-failure"));
            if (state.installedCount > 0) nodes.push(element("p", "extension-review-caption", `Installed in ${state.installedCount} Spaces before this error.`));
        }

        nodes.push(element("hr", "extension-review-divider"));
        const buttons = element("div", "extension-review-buttons");
        if (this.completed) {
            const done = reviewButton("Done", "prominent", () => this.dismiss());
            buttons.append(done);
            window.setTimeout(() => done.focus({ preventScroll: true }));
        } else {
            const cancel = reviewButton("Cancel", "plain", () => this.dismiss());
            cancel.disabled = this.installing;
            buttons.append(cancel);
            if (question && !state?.failure) {
                const add = reviewButton(this.installing || this.answered ? "" : "Add Extension", "prominent", () => this.accept());
                if (this.installing || this.answered) {
                    add.append(element("span", "extension-review-spinner"));
                    add.setAttribute("aria-label", "Adding extension");
                }
                add.disabled = !this.canAccept || this.installing || this.answered;
                buttons.append(add);
            }
        }
        nodes.push(buttons);
        return nodes;
    }

    /** The page that picks the Spaces a copy also goes to (BrowserExtensionInstallSpacesPage). */
    private spacesPage(): HTMLElement[] {
        const back = reviewButton("", "plain", () => {
            this.selectingSpaces = false;
            this.draw();
        });
        back.classList.add("extension-review-back");
        back.innerHTML = `${sfSymbol("chevron.left", 12)}<span>Back</span>`;
        const nodes: HTMLElement[] = [
            back,
            element("h2", "extension-review-title large", "Install in Other Spaces"),
            element("p", "", `This extension will be installed in ${this.space.state.settings.name}. Select any additional Spaces below.`),
            element("p", "extension-review-secondary", "Each Space gets an independent copy with the permissions you choose. Extension data stays separate."),
        ];
        const list = element("div", "extension-space-list");
        for (const space of this.destinations) list.append(spaceChoice(space, this.selected));
        if (this.destinations.length === 0) list.append(element("p", "extension-review-secondary", "No other Spaces can take a copy."));
        nodes.push(list);
        return nodes;
    }
}

// MARK: - Parts

/** A row that picks or leaves one Space, as BrowserExtensionSpaceSelectionList does. */
export function spaceChoice(space: Space, selection: Set<Guid>, change?: () => void): HTMLElement {
    const label = element("label", "extension-space-choice");
    const box = element("input", "");
    box.type = "checkbox";
    box.checked = selection.has(space.state.id);
    box.addEventListener("change", () => {
        if (box.checked) selection.add(space.state.id);
        else selection.delete(space.state.id);
        change?.();
    });
    const glyph = element("span", "extension-space-glyph");
    glyph.innerHTML = sfSymbol(space.state.settings.symbol || "circle.fill", 14);
    label.append(box, glyph, element("span", "", space.state.settings.name));
    return label;
}

/** An extension's icon, or the puzzle piece when it has none. */
export function iconView(icon: string | null, size: number): HTMLElement {
    const frame = element("span", "extension-icon");
    frame.style.width = frame.style.height = `${size}px`;
    if (icon) {
        const image = element("img", "");
        image.src = icon;
        image.alt = "";
        image.draggable = false;
        frame.append(image);
    } else {
        frame.innerHTML = sfSymbol("puzzlepiece.extension.fill", Math.round(size * 0.6));
    }
    return frame;
}

function labelled(symbol: string, text: string, className: string): HTMLElement {
    const node = element("div", `extension-label ${className}`.trim());
    const glyph = element("span", "extension-label-glyph");
    glyph.innerHTML = sfSymbol(symbol, 13);
    node.append(glyph, element("span", "", text));
    return node;
}

function labeledContent(title: string, value: string): HTMLElement {
    const node = element("div", "extension-review-field");
    node.append(element("span", "", title), element("span", "extension-review-value", value));
    return node;
}

function reviewButton(title: string, role: "plain" | "prominent", action: () => void): HTMLButtonElement {
    const node = element("button", `settings-button ${role}`, title);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
}
