// Setup's pages that show and choose, as the Mac draws them: the welcome
// (BrowserOnboardingWelcomePage), the look (BrowserOnboardingLookPage), the
// browsers to bring tabs from (BrowserOnboardingImportPage and its
// BrowserInstalledImportSourceGrid), and the close
// (BrowserOnboardingCompletionPage).

import type { SpaceBranding } from "../generated/crest_contracts.js";
import { ImportSource, SetupLook, SpaceAccent, SpaceHouse } from "../generated/crest_contracts.js";
import { identityIcon } from "./crest.js";
import type { InstalledImportSource } from "./import-sources.js";
import type { Onboarding } from "./onboarding.js";
import { failureMessage } from "./onboarding.js";
import {
    button,
    continueButton,
    crestMark,
    el,
    failureLabel,
    footer,
    headline,
    previewBranding,
    previewSymbol,
    unavailable,
    windowPreview,
} from "./onboarding-stage.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Shared

/** A Space as a preview shows it: its look, symbol and name. */
export interface SpaceIdentity {
    readonly branding: SpaceBranding;
    readonly symbol: string;
    readonly name: string;
}

/** The page card's big icon, as the previews draw the Space's identity inside it. */
function pageIcon(identity: SpaceIdentity, size: number): HTMLElement {
    const holder = el("div", "onboarding-page-icon");
    holder.append(identityIcon(identity.branding, identity.symbol, size));
    return holder;
}

/** A spinner beside what is under way. */
function progress(): HTMLElement {
    const spinner = el("span", "onboarding-spinner");
    spinner.setAttribute("aria-hidden", "true");
    return spinner;
}

// MARK: - Welcome

export function welcomePage(setup: Onboarding): HTMLElement {
    const page = el("div", "onboarding-welcome");
    const column = el("div", "onboarding-welcome-column");
    const title = el("h1", "onboarding-display", "Welcome to Crest");
    column.append(crestMark(84), title, el("p", "onboarding-tagline", "Internet under your colors."));

    // Linux has no iCloud to wait on: the welcome offers setup once the core
    // opened it, or Crest where it has nothing to set up
    // (BrowserOnboardingWelcomeAction).
    const flow = setup.flow;
    const opensCrest = flow?.opensCrestFromWelcome === true;
    const action = continueButton(
        opensCrest ? "Open Crest" : "Continue",
        () => (opensCrest ? void setup.openCrest() : setup.continueSetup()),
        flow === null,
    );
    const workspace = setup.host.model.workspace;
    const detail =
        setup.host.model.setupCompleted === true
            ? "Your existing Crest setup is ready."
            : workspace && !workspace.isDisposableSeed
              ? "Your existing Spaces are ready to customize."
              : "No existing setup was found.";
    const call = el("div", "onboarding-welcome-action");
    call.append(action, el("span", "onboarding-detail", detail));
    column.append(call);

    const winter = SpaceHouse.facts.Winter.look;
    const preview = windowPreview({
        branding: winter,
        symbol: "house.fill",
        name: "Personal",
        page: pageIcon({ branding: winter, symbol: "house.fill", name: "Personal" }, 160),
    });
    preview.classList.add("onboarding-welcome-preview");
    page.append(column, preview);
    return page;
}

// MARK: - Look

export function lookPage(setup: Onboarding): HTMLElement {
    const page = el("div", "onboarding-column-page");
    const cards = el("div", "onboarding-looks");
    for (const look of SetupLook.all) {
        const selected = look === setup.look;
        const card = el("div", "onboarding-look");
        const choice = el("button", selected ? "onboarding-look-card selected" : "onboarding-look-card");
        choice.type = "button";
        const title = SetupLook.facts[look].title.text;
        choice.setAttribute("aria-label", title);
        choice.setAttribute("aria-pressed", String(selected));
        choice.dataset["focus"] = `look-${look}`;
        choice.disabled = setup.isLocked;
        choice.append(
            windowPreview({
                branding: previewBranding(look),
                symbol: previewSymbol,
                name: "Personal",
                spaceIcons: look === "Simple" ? "dots" : "icons",
                companionLook: look,
            }),
        );
        choice.addEventListener("click", () => setup.chooseLook(look));
        card.append(choice, el("span", "onboarding-look-title", title));
        cards.append(card);
    }
    page.append(headline("Pick your look"), cards, footer(setup.back(), [continueButton("Continue", () => setup.continueFromLook())]));
    return page;
}

// MARK: - Import

export function importPage(setup: Onboarding): HTMLElement {
    const page = el("div", "onboarding-column-page");
    const sources = setup.installedSources;
    const locked = setup.isLocked;
    const choices = el("div", "onboarding-choices");
    choices.dataset["scroll"] = "import";
    if (sources.length === 0 && setup.hasScanned) {
        choices.append(unavailable("square.stack.3d.up.slash", "No Supported Browsers Found", "You can still set up Spaces by hand."));
    } else if (sources.length > 0) {
        const grid = el("div", "onboarding-source-grid");
        for (const source of sources) grid.append(sourceCard(setup, source, locked));
        choices.append(grid);
    }
    choices.append(scanForMore(setup, locked));

    const trailing: HTMLElement[] = [];
    if (setup.isReading) {
        const reading = el("span", "onboarding-reading");
        reading.append(progress(), el("span", "", "Building your review…"));
        trailing.push(
            reading,
            button("Cancel", "secondary", () => setup.cancelImportRead()),
        );
    } else {
        const failure = failureMessage(setup.flow);
        if (failure) trailing.push(failureLabel(failure));
        const skip = button("Skip", "tertiary", () => setup.beginManualSetup());
        const go = continueButton("Continue", () => void setup.continueImport(), !sources.some((source) => setup.isSelected(source)));
        skip.disabled = locked;
        go.disabled ||= locked;
        trailing.push(skip, go);
    }
    page.append(headline("Bring your tabs"), choices, footer(setup.back(), trailing, locked));
    return page;
}

/** One browser to bring tabs from, which the person selects (BrowserInstalledImportSourceCard). */
function sourceCard(setup: Onboarding, source: InstalledImportSource, locked: boolean): HTMLElement {
    const selected = setup.isSelected(source);
    const card = el("button", selected ? "onboarding-source selected" : "onboarding-source");
    card.type = "button";
    card.disabled = locked;
    card.dataset["focus"] = `source-${source.application}`;
    card.setAttribute("aria-label", `Import from ${source.title}`);
    card.setAttribute("aria-pressed", String(selected));
    card.title = source.detectedPayload
        ? "Review its Spaces and tabs"
        : "Crest reads its data when you continue, which asks for its data folder";
    // TODO(linux): the browser's own app icon, which the Mac reads from the
    // app; Linux draws its initial in the browser's accent until it reads
    // the icon theme.
    const icon = el("span", "onboarding-source-icon", source.title.slice(0, 1));
    const swatch = SpaceAccent.facts[ImportSource.facts[source.application].accent].swatch;
    icon.style.background = `rgb(${Math.round(swatch.red * 255)} ${Math.round(swatch.green * 255)} ${Math.round(swatch.blue * 255)})`;
    card.append(
        icon,
        el("span", "onboarding-source-title", source.title),
        el("span", "onboarding-source-detail", setup.accessLabel(source) ?? ""),
    );
    if (selected) {
        const check = el("span", "onboarding-source-check");
        check.innerHTML = sfSymbol("checkmark", 11);
        card.append(check);
    }
    card.addEventListener("click", () => setup.toggle(source));
    return card;
}

/** Scan for more, then what it found (BrowserOnboardingScanForMore). */
function scanForMore(setup: Onboarding, locked: boolean): HTMLElement {
    const holder = el("div", "onboarding-scan");
    if (!setup.hasScanned) {
        const scan = button("Scan for more", "secondary", () => void setup.scanForMore(), "magnifyingglass");
        scan.disabled = locked;
        scan.title = "Looks through other browsers’ data on this computer";
        holder.append(scan);
        return holder;
    }
    // Linux finds no browser setup does not list yet, so the scan never finds one.
    holder.append(el("p", "onboarding-detail", "Crest couldn’t find another browser. Not every browser can be found."));
    const request = el("button", "onboarding-link", "Request a browser");
    request.type = "button";
    request.addEventListener("click", () => setup.requestBrowser());
    holder.append(request);
    return holder;
}

// MARK: - Complete

/** What setup did, as the Mac's BrowserOnboardingSummary.completed words it. */
function completionSummary(setup: Onboarding): string[] {
    const summary = setup.flow?.summary;
    if (!summary) return [];
    const tabs = Math.max(summary.tabCount, 0);
    const spaces = Math.max(summary.spaceCount, 0);
    const passwords = Math.max(summary.passwordCount, 0);
    let did: string;
    if (summary.isImport) {
        did =
            passwords === 0
                ? `Imported ${tabs} reviewed tabs across ${spaces} Spaces.`
                : `Imported ${tabs} reviewed tabs and ${passwords} passwords across ${spaces} Spaces.`;
    } else {
        did = spaces === 0 ? `Updated your Spaces and added ${tabs} tabs.` : `Created ${spaces} Spaces and added ${tabs} tabs.`;
    }
    const unsaved = Math.max(summary.unsavedPasswordCount, 0);
    return unsaved > 0 ? [did, `${unsaved} passwords couldn’t be saved.`] : [did];
}

export function completePage(setup: Onboarding): HTMLElement {
    const page = el("div", "onboarding-column-page onboarding-complete");
    const drafts = setup.draftSpaces;
    const identities: SpaceIdentity[] =
        drafts.length > 0
            ? drafts.map((space) => ({ branding: space.customization.branding, symbol: space.customization.symbol, name: space.shownName }))
            : setup.destinationSpaces.map((space) => ({
                  branding: space.settings.look,
                  symbol: space.settings.symbol,
                  name: space.settings.name,
              }));
    const windows = el("div", "onboarding-complete-windows");
    for (const identity of identities.slice(0, 3)) {
        windows.append(windowPreview({ ...identity, page: pageIcon(identity, 96) }));
    }
    const parts = completionSummary(setup);
    // TODO(linux): say "Getting Started opens next." where the core opens the
    // guide, once Linux draws it; until then Crest opens on its Space.
    const closing = el("div", "onboarding-closing");
    closing.append(
        headline("Ready"),
        continueButton("Open Crest", () => void setup.openCrest()),
        el("p", "onboarding-detail", parts.join(" ")),
    );
    page.append(el("span", "onboarding-spacer"), windows, closing, el("span", "onboarding-spacer"));
    if (setup.flow?.backStep) page.append(footer(setup.back(), []));
    return page;
}
