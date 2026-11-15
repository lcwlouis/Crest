// Setup's review of one browser's import, as the Mac's
// BrowserOnboardingReviewPage draws it: one source Space at a time, its
// sidebar as the browser showed it on the left (BrowserSourceImportPreview),
// what it brings in the middle (BrowserOnboardingReviewChecklist), and its
// sidebar as Crest will show it on the right (BrowserCrestImportPreview),
// with a stepper through the Spaces beside them. Every choice is an intent;
// the core's review answers what each Space brings, and its ImportPreview
// what Crest would hold.

import type { Guid, ImportLeftOut, ImportSource, SpaceBranding, SpaceState, TabPlacement, TabState } from "../generated/crest_contracts.js";
import {
    ImportSource as ImportSources,
    SpaceHouse,
    TabPlacement as TabPlacements,
    textsOfRejection,
} from "../generated/crest_contracts.js";
import { bannerSVG, foregroundTone, identityIcon } from "./crest.js";
import { Menu } from "./menu.js";
import type { Onboarding, ReviewAnalysis, ReviewSpace } from "./onboarding.js";
import { failureMessage } from "./onboarding.js";
import { button, continueButton, el, failureLabel, footer, popover, unavailable } from "./onboarding-stage.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Page

export function reviewPage(setup: Onboarding): HTMLElement {
    const page = el("div", "onboarding-column-page onboarding-review");
    const setupReview = setup.review;
    const review = setup.shownReview();
    if (!setupReview || !review) {
        page.append(unavailable("checklist.unchecked", "Nothing to Review", "Choose a browser to build an import review."));
        return page;
    }
    const spaces = setup.reviewSpaces;
    const committing = setup.isCommittingImport;

    const header = el("div", "onboarding-review-header");
    const titles = el("div", "onboarding-review-titles");
    const heading = el("h1", "onboarding-review-title", `Review ${setupReview.title}`);
    titles.append(heading, el("span", "onboarding-detail", progressLabel(setup, review)));
    header.append(titles);

    const body = el("div", "onboarding-review-body");
    body.classList.toggle("disabled", committing);
    body.append(spacePage(setup, review, setupReview.source, setupReview.leftOut), stepper(setup, spaces, review.id));

    const trailing: HTMLElement[] = [];
    const failure = failureMessage(setup.flow);
    if (failure) trailing.push(failureLabel(failure));
    else trailing.push(el("span", "onboarding-detail", reviewSummary(setup)));
    const isLast = review.id === spaces[spaces.length - 1]?.id;
    const title = committing
        ? "Importing…"
        : isLast
          ? setup.flow?.queue?.hasMoreAfterCurrent
              ? "Import & Continue"
              : "Import"
          : "Next Space";
    trailing.push(continueButton(title, () => setup.advanceReview(review), committing || (isLast && !setupReview.hasIncludedSpaces)));
    page.append(header, body, footer(setup.back(), trailing, committing));
    return page;
}

/** "Space 2 of 5", with the browser it is among others (reviewProgressLabel). */
function progressLabel(setup: Onboarding, review: ReviewSpace): string {
    const spaces = setup.reviewSpaces;
    const index = Math.max(
        spaces.findIndex((space) => space.id === review.id),
        0,
    );
    const spaceProgress = `Space ${index + 1} of ${spaces.length}`;
    const queue = setup.flow?.queue;
    if (!queue || queue.sources.length <= 1 || queue.current === null) return spaceProgress;
    return `Browser ${queue.index + 1} of ${queue.sources.length} · ${spaceProgress}`;
}

/** What the import brings in all (SetupImportReview.summary). */
function reviewSummary(setup: Onboarding): string {
    const review = setup.review;
    if (!review) return "";
    const parts = [`${Math.max(review.includedTabCount, 0)} tabs selected`];
    if (review.includedPasswordCount > 0) parts.push(`${review.includedPasswordCount} passwords`);
    if (review.overflowTabIds.length > 0) parts.push(`${review.overflowTabIds.length} pinned tabs move to a saved folder`);
    return parts.join(" · ");
}

/** The Spaces under review, each a step, those that come in together held in one capsule. */
function stepper(setup: Onboarding, spaces: readonly ReviewSpace[], selectedId: Guid): HTMLElement {
    const rail = el("div", "onboarding-stepper");
    rail.setAttribute("aria-label", "Space review progress");
    const groups: ReviewSpace[][] = [];
    for (const item of spaces) {
        const group = groups[groups.length - 1];
        const last = group?.[group.length - 1];
        if (group && last && last.isIncluded && item.isIncluded && last.groupId === item.groupId) group.push(item);
        else groups.push([item]);
    }
    for (const group of groups) {
        const holder = el("div", group.length > 1 ? "onboarding-stepper-group joined" : "onboarding-stepper-group");
        for (const item of group) {
            const step = el("button", item.id === selectedId ? "onboarding-step current" : "onboarding-step");
            step.type = "button";
            step.setAttribute("aria-label", item.source.settings.name);
            step.setAttribute("aria-current", String(item.id === selectedId));
            step.addEventListener("click", () => setup.showReviewSpace(item.id));
            holder.append(step);
        }
        rail.append(holder);
    }
    return rail;
}

// MARK: - Space

/** One source Space's columns (BrowserOnboardingReviewSpacePage). */
function spacePage(setup: Onboarding, review: ReviewSpace, application: ImportSource, leftOut: readonly ImportLeftOut[]): HTMLElement {
    const analysis = setup.analysis();
    const title = setup.review?.title ?? ImportSources.facts[application].title;
    const columns = el("div", "onboarding-review-columns");

    const from = el("div", "onboarding-review-column");
    from.append(el("span", "onboarding-column-label", `From ${title}`), sourcePreview(setup, review, application, analysis, title));
    from.append(el("span", "onboarding-detail", "Click anything to leave it out."));

    const middle = el("div", "onboarding-review-middle");
    middle.append(checklist(setup, review, application, analysis));
    if (leftOut.length > 0) middle.append(leftOutButton(leftOut));

    const into = el("div", "onboarding-review-column");
    const label = el("div", "onboarding-column-heading");
    const customize = button("Customize", "tertiary", () => setup.openCustomization(review.id), "paintpalette");
    customize.disabled = !review.isIncluded;
    label.append(el("span", "onboarding-column-label", "Into Crest"), el("span", "onboarding-spacer"), customize);
    into.append(label, crestPreview(setup, review, title, analysis.matchedTabIds(review.id)));

    columns.append(from, middle, into);
    return columns;
}

// MARK: - Checklist

/** A row of the checklist: its checkbox and what it says. */
function row(
    title: string,
    on: boolean,
    change: (on: boolean) => void,
    content: HTMLElement[],
    enabled = true,
    canToggle = true,
): HTMLElement {
    const line = el("label", enabled ? "onboarding-check-row" : "onboarding-check-row disabled");
    const box = el("input", "onboarding-checkbox");
    box.type = "checkbox";
    box.checked = on;
    box.disabled = !enabled || !canToggle;
    box.setAttribute("aria-label", title);
    box.addEventListener("change", () => change(box.checked));
    const body = el("div", "onboarding-check-body");
    body.append(...content);
    line.append(box, body);
    return line;
}

/** What the Space brings, each part one can leave out (BrowserOnboardingReviewChecklist). */
function checklist(setup: Onboarding, review: ReviewSpace, application: ImportSource, analysis: ReviewAnalysis): HTMLElement {
    const list = el("div", "onboarding-checklist");
    list.setAttribute("aria-label", `What ${review.source.settings.name} brings`);
    const sourceSpaceId = review.id;
    const send = setup.send.bind(setup);
    const outOfRoom = !review.isIncluded && review.record.destinationId === null && (setup.review?.newSpaceCapacity ?? 1) === 0;

    const nameLine = el("div", "onboarding-check-line");
    nameLine.append(
        el("span", "onboarding-check-title", review.source.settings.name),
        el("span", "onboarding-spacer"),
        destinationMenu(setup, review),
    );
    const spaceContent = [nameLine];
    const group = groupLabel(setup, review);
    if (group) {
        const groupLine = el("div", "onboarding-check-line");
        const separate = el("button", "onboarding-chip-button", "Separate");
        separate.type = "button";
        separate.addEventListener("click", (event) => {
            event.preventDefault();
            void send({ kind: "SeparateImportSpace", value: { sourceSpaceId } });
        });
        groupLine.append(el("span", "onboarding-detail", group), el("span", "onboarding-spacer"), separate);
        spaceContent.push(groupLine);
    }
    list.append(
        row(
            "Bring this Space",
            review.isIncluded,
            (included) => void send({ kind: "IncludeImportSpace", value: { sourceSpaceId, included } }),
            spaceContent,
            true,
            !outOfRoom,
        ),
    );

    const included = review.record.includedTabIds;
    const overflow = review.record.includedTabIds.filter((id) => analysis.overflowTabIds.has(id)).length;
    const tabs = [el("span", "onboarding-check-title", `${included.length} tabs`)];
    if (overflow > 0) tabs.push(el("span", "onboarding-detail warning", `${overflow} pinned tabs move to a saved folder`));
    list.append(
        row(
            "Bring its tabs",
            included.length > 0,
            (on) =>
                void send({
                    kind: "IncludeImportTabs",
                    value: { sourceSpaceId, tabIds: review.source.tabs.map((tab) => tab.id), included: on },
                }),
            tabs,
            review.isIncluded,
        ),
    );

    if (ImportSources.facts[application].suppliesPasswords) {
        // TODO(linux): passwords come in once Linux reads and keeps them
        // through libsecret; until then the row says why it is off.
        list.append(
            row(
                `Bring passwords for ${review.source.settings.name}`,
                false,
                () => undefined,
                [el("span", "onboarding-check-title", "Passwords"), el("span", "onboarding-detail", "Not available on Linux yet")],
                false,
            ),
        );
    }

    if (outOfRoom) list.append(el("p", "onboarding-detail warning", "No room for another Space"));
    return list;
}

/** Whether the Space comes in grouped with others, and how (groupLabel). */
function groupLabel(setup: Onboarding, review: ReviewSpace): string | null {
    if (!review.comesInNew) return null;
    const existing = review.record.joinsGroupOf;
    if (existing) {
        const space = setup.destinationSpaces.find((held) => held.id === existing);
        if (space) return `Sub-Space of ${space.settings.name}`;
    }
    const group = setup.reviewGroup(review);
    const lead = group[0];
    if (!lead || group.length <= 1) return null;
    if (lead.id !== review.id) return `Sub-Space of ${lead.source.settings.name}`;
    return group.length === 2 ? "With a Sub-Space" : `With ${group.length - 1} Sub-Spaces`;
}

/** Where the Space goes: a new Space, or one the person has (BrowserOnboardingReviewDestinationMenu). */
function destinationMenu(setup: Onboarding, review: ReviewSpace): HTMLElement {
    const destination = review.record.destinationId;
    const spaces = setup.destinationSpaces;
    const chosen = spaces.find((space) => space.id === destination);
    const control = el("button", "onboarding-destination");
    control.type = "button";
    control.disabled = !review.isIncluded;
    control.setAttribute("aria-label", "Where this Space goes");
    if (chosen) control.append(identityIcon(chosen.settings.look, chosen.settings.symbol, 16), el("span", "", chosen.settings.name));
    else control.append(el("span", "", "New Space"));
    control.insertAdjacentHTML("beforeend", sfSymbol("chevron.up.chevron.down", 11));
    const choose = (destinationSpaceId: Guid | null): void =>
        void setup.send({ kind: "ChooseImportDestination", value: { sourceSpaceId: review.id, destinationSpaceId } });
    control.addEventListener("click", (event) => {
        event.preventDefault();
        Menu.open(
            [
                { title: "New Space", icon: { kind: "symbol", name: "plus" }, checked: destination === null, action: () => choose(null) },
                ...spaces.map((space) => ({
                    title: space.settings.name,
                    icon: { kind: "space" as const, settings: space.settings },
                    checked: space.id === destination,
                    action: () => choose(space.id),
                })),
            ],
            { anchor: control.getBoundingClientRect() },
        );
    });
    return control;
}

/** What the import leaves out, and why (BrowserOnboardingReviewLeftOutMenu). */
function leftOutButton(leftOut: readonly ImportLeftOut[]): HTMLElement {
    const control = el("button", "onboarding-left-out");
    control.type = "button";
    control.title = "Shows what the import leaves out and why";
    control.innerHTML = sfSymbol("info.circle", 13);
    control.append(el("span", "", `${leftOut.length} left out`));
    control.addEventListener("click", () => {
        const list = el("div", "onboarding-left-out-list");
        for (const item of leftOut) {
            const entry = el("div", "onboarding-left-out-item");
            entry.append(el("strong", "", item.name), el("span", "", textsOfRejection(item.reason).message?.text ?? item.reason.kind));
            list.append(entry);
        }
        popover(control, list);
    });
    return control;
}

// MARK: - From the browser

/** The source Space's tabs by where they sit (BrowserSourceImportPreviewSections). */
function sections(review: ReviewSpace): { pinned: TabState[]; saved: TabState[]; current: TabState[] } {
    const pinned: TabState[] = [];
    const saved: TabState[] = [];
    const current: TabState[] = [];
    for (const tab of review.source.tabs) {
        const facts = TabPlacements.facts[review.placement(tab)];
        if (!facts.isDurable) current.push(tab);
        else if (!facts.holdsFolders) pinned.push(tab);
        else saved.push(tab);
    }
    return { pinned, saved, current };
}

/** The source browser's sidebar for the Space, each tab one click from left out (BrowserSourceImportPreview). */
function sourcePreview(
    setup: Onboarding,
    review: ReviewSpace,
    application: ImportSource,
    analysis: ReviewAnalysis,
    title: string,
): HTMLElement {
    const frame = el("div", "onboarding-sidebar-frame source");
    const facts = ImportSources.facts[application];
    const { pinned, saved, current } = sections(review);
    const sourceSpaceId = review.id;
    const included = review.includedTabIds;
    const setIncluded = (tabIds: readonly Guid[], on: boolean): void =>
        void setup.send({ kind: "IncludeImportTabs", value: { sourceSpaceId, tabIds: [...tabIds], included: on } });
    const destination = setup.destinationSpaces.find((space) => space.id === review.record.destinationId)?.settings.name ?? null;

    frame.append(el("div", "onboarding-sidebar-chrome", title));
    if (pinned.length > 0) {
        frame.append(sectionHeader(facts.pinnedSectionTitle.text, pinned, included, setIncluded));
        const grid = el("div", "onboarding-pinned-grid");
        for (const tab of pinned) {
            const tile = el("button", "onboarding-pinned-tile");
            tile.type = "button";
            tile.title = tab.title;
            tile.classList.toggle("left-out", !included.has(tab.id));
            tile.classList.toggle("duplicate", analysis.duplicateTabIds.has(tab.id));
            tile.append(tabGlyph());
            tile.addEventListener("click", () => setIncluded([tab.id], !included.has(tab.id)));
            grid.append(tile);
        }
        frame.append(grid);
    }
    const spaceHeader = el("div", "onboarding-sidebar-space");
    spaceHeader.append(el("span", "", review.source.settings.name));
    frame.append(spaceHeader);
    if (facts.listsNewTab && current.length === 0) {
        const newTab = el("div", "onboarding-sidebar-row dim");
        newTab.innerHTML = sfSymbol("plus", 14);
        newTab.append(el("span", "", "New Tab"));
        frame.append(newTab);
    }
    const list = el("div", "onboarding-sidebar-list");
    list.dataset["scroll"] = `source-${review.id}`;
    const tabRow = (tab: TabState): HTMLElement => sourceTabRow(setup, review, tab, analysis, included, destination, setIncluded);
    if (saved.length > 0) {
        list.append(sectionHeader(facts.savedSectionTitle.text, saved, included, setIncluded));
        for (const folder of review.source.folders) {
            const inside = saved.filter((tab) => tab.folderId === folder.id);
            if (inside.length === 0) continue;
            const folderRow = el("div", "onboarding-sidebar-row onboarding-folder");
            folderRow.innerHTML = sfSymbol("folder", 14);
            folderRow.append(el("span", "", folder.title));
            list.append(folderRow, ...inside.map(tabRow));
        }
        const folderIds = new Set(review.source.folders.map((folder) => folder.id));
        list.append(...saved.filter((tab) => tab.folderId === null || !folderIds.has(tab.folderId)).map(tabRow));
    }
    if (current.length > 0) {
        list.append(sectionHeader("OPEN TABS", current, included, setIncluded), ...current.map(tabRow));
    }
    frame.append(list);
    return frame;
}

/** A section's title, with Include all or Leave all (BrowserSourceImportSectionHeader). */
function sectionHeader(
    title: string,
    tabs: readonly TabState[],
    included: ReadonlySet<Guid>,
    setIncluded: (tabIds: readonly Guid[], on: boolean) => void,
): HTMLElement {
    const header = el("div", "onboarding-sidebar-section");
    const all = tabs.every((tab) => included.has(tab.id));
    const toggle = el("button", "onboarding-link small", all ? "Leave all" : "Include all");
    toggle.type = "button";
    toggle.addEventListener("click", () =>
        setIncluded(
            tabs.map((tab) => tab.id),
            !all,
        ),
    );
    header.append(el("span", "", title), el("span", "onboarding-spacer"), toggle);
    return header;
}

/** The globe a tab wears in a review, where the browser it came from kept its image. */
function tabGlyph(): HTMLElement {
    const glyph = el("span", "onboarding-tab-glyph");
    glyph.innerHTML = sfSymbol("globe", 14);
    glyph.setAttribute("aria-hidden", "true");
    return glyph;
}

/** A tab of the source Space, which one click leaves out or brings back (BrowserSourceImportTabRow). */
function sourceTabRow(
    setup: Onboarding,
    review: ReviewSpace,
    tab: TabState,
    analysis: ReviewAnalysis,
    included: ReadonlySet<Guid>,
    destination: string | null,
    setIncluded: (tabIds: readonly Guid[], on: boolean) => void,
): HTMLElement {
    const isIncluded = included.has(tab.id);
    const overflows = analysis.overflowTabIds.has(tab.id) && isIncluded;
    const duplicate = analysis.duplicateTabIds.has(tab.id);
    const line = el("div", "onboarding-sidebar-row tab");
    line.classList.toggle("duplicate", duplicate);
    line.classList.toggle("overflows", overflows);
    const toggle = el("button", "onboarding-tab-toggle");
    toggle.type = "button";
    toggle.classList.toggle("left-out", !isIncluded && !duplicate);
    toggle.setAttribute("aria-label", tab.title);
    toggle.setAttribute(
        "aria-description",
        overflows
            ? "Included, pinned capacity full, moves to Imported Pinned Tabs"
            : !isIncluded && duplicate
              ? `Already in ${destination ?? "destination"}, not included`
              : isIncluded
                ? "Included"
                : "Not included",
    );
    toggle.append(tabGlyph(), el("span", "onboarding-tab-title", tab.title));
    if (overflows)
        toggle.insertAdjacentHTML("beforeend", `<span class="status danger">${sfSymbol("exclamationmark.circle.fill", 13)}</span>`);
    else if (!isIncluded)
        toggle.insertAdjacentHTML(
            "beforeend",
            `<span class="status${duplicate ? " match" : ""}">${sfSymbol(duplicate ? "equal.circle.fill" : "minus.circle.fill", 13)}</span>`,
        );
    toggle.addEventListener("click", () => setIncluded([tab.id], !isIncluded));

    const more = el("button", "onboarding-tab-more");
    more.type = "button";
    more.innerHTML = sfSymbol("ellipsis", 14);
    more.setAttribute("aria-label", `Tab placement for ${tab.title}`);
    more.addEventListener("click", () => {
        const place = (placement: TabPlacement): void =>
            void setup.send({ kind: "PlaceImportTab", value: { sourceSpaceId: review.id, tabId: tab.id, placement } });
        Menu.open(
            TabPlacements.all.map((placement) => ({
                title: TabPlacements.facts[placement].title.text,
                icon: { kind: "symbol" as const, name: TabPlacements.facts[placement].symbol },
                checked: review.placement(tab) === placement,
                action: () => place(placement),
            })),
            { anchor: more.getBoundingClientRect() },
        );
    });
    line.append(toggle, more);
    return line;
}

// MARK: - Into Crest

/** A sidebar's field in `branding`, the frame the previews draw their rows over (BrowserImportSidebarFrame). */
function sidebarFrame(branding: SpaceBranding): HTMLElement {
    const frame = el("div", "onboarding-sidebar-frame");
    frame.classList.add(foregroundTone(branding, true) === "light" ? "reads-light" : "reads-dark");
    const field = el("div", "onboarding-sidebar-field");
    field.innerHTML = bannerSVG(branding, 380, 560);
    frame.append(field);
    return frame;
}

/** The Space as Crest will hold it, from the core's preview (BrowserCrestImportPreview). */
function crestPreview(setup: Onboarding, review: ReviewSpace, sourceName: string, matched: ReadonlySet<Guid>): HTMLElement {
    const neutral = SpaceHouse.facts.Winter.look;
    if (!review.isIncluded) {
        const frame = sidebarFrame(neutral);
        frame.append(unavailable("rectangle.stack.badge.minus", "Space Skipped", "Turn on Import Space to include it."));
        return frame;
    }
    if (!setup.isPreviewReady) {
        const frame = sidebarFrame(neutral);
        frame.append(el("span", "onboarding-spinner centered"));
        return frame;
    }
    const space = setup.previewSpace(review);
    if (!space) {
        const frame = sidebarFrame(neutral);
        frame.append(
            unavailable("rectangle.stack.badge.minus", "Preview Unavailable", `Crest could not build this ${sourceName} Space preview.`),
        );
        return frame;
    }
    const frame = sidebarFrame(space.settings.look);
    frame.setAttribute("aria-label", `Crest ${space.settings.name} sidebar after import`);
    frame.append(crestContent(space, matched));
    return frame;
}

/** The rows of the Crest sidebar the import leaves the Space with (BrowserCrestImportContent). */
function crestContent(space: SpaceState, matched: ReadonlySet<Guid>): HTMLElement {
    const content = el("div", "onboarding-sidebar-content");
    const pinned = space.tabs.filter((tab) => TabPlacements.facts[tab.placement].isGrid);
    const saved = space.tabs.filter((tab) => tab.placement === "Saved");
    const current = space.tabs.filter((tab) => !TabPlacements.facts[tab.placement].isDurable);
    if (pinned.length > 0) {
        const grid = el("div", "onboarding-pinned-grid");
        for (const tab of pinned) {
            const tile = el("span", matched.has(tab.id) ? "onboarding-pinned-tile matched" : "onboarding-pinned-tile");
            tile.title = tab.displayTitle;
            tile.append(tabGlyph());
            grid.append(tile);
        }
        content.append(grid);
    }
    const header = el("div", "onboarding-sidebar-space");
    header.append(identityIcon(space.settings.look, space.settings.symbol, 20), el("span", "", space.settings.name));
    content.append(header);
    const list = el("div", "onboarding-sidebar-list");
    list.dataset["scroll"] = `crest-${space.id}`;
    const tabRow = (tab: TabState): HTMLElement => {
        const line = el("div", matched.has(tab.id) ? "onboarding-sidebar-row tab matched" : "onboarding-sidebar-row tab");
        line.append(tabGlyph(), el("span", "onboarding-tab-title", tab.displayTitle));
        return line;
    };
    if (saved.length > 0) {
        for (const folder of space.folders) {
            const inside = saved.filter((tab) => tab.folderId === folder.id);
            if (inside.length === 0) continue;
            const folderRow = el("div", "onboarding-sidebar-row onboarding-folder");
            folderRow.innerHTML = sfSymbol("folder", 14);
            folderRow.append(el("span", "", folder.title));
            list.append(folderRow, ...inside.map(tabRow));
        }
        const folderIds = new Set(space.folders.map((folder) => folder.id));
        list.append(...saved.filter((tab) => tab.folderId === null || !folderIds.has(tab.folderId)).map(tabRow));
    }
    if (current.length > 0) {
        const section = el("div", "onboarding-sidebar-section");
        section.append(el("span", "", "OPEN TABS"));
        list.append(section, ...current.map(tabRow));
    }
    content.append(list);
    return content;
}
