// Dragging in the sidebar, as the Mac's BrowserSidebarReorderState,
// BrowserSidebarReorderAim and BrowserSidebarDropCommit do it: a row, a
// folder, a split or a pin lifts once the pointer moves 4 points, follows the
// pointer as a floating preview that takes the shape of where it would land
// (a row, a pinned tile or a page card), and the rows it passes step aside to
// open the gap it would land in. Released, the lift lands where it was aimed:
// in a list at the gap, inside a collapsed folder, in a new folder around an
// open tab, on another Space in the switcher, or among the page cards as a
// split; released outside the window, a tab opens in a window of its own.
//
// The core owns every move and every rule. The lift asks it once, as it
// begins, what it carries (SelectionPreview) and where it may land
// (DropTargets); whether it may land in a list or on a Space is asked the
// first time it reaches one (CanSend); the drop is one of the core's
// SidebarDrop intents, and a refusal shows in the core's own words.
//
// Pointer events, not HTML drag and drop: the lift is drawn by the page, as
// the Mac draws its own, and the WebUI is raised over the pages while it is
// held so the pointer keeps reaching it over the page cards.
//
// The rows are measured once as the lift begins and stay where they were
// drawn until it lands; each moves aside by a transform, as the Mac's
// projected layout moves them, so a change the core publishes meanwhile
// waits for the drop to draw.

import type { DropTargetList, Guid, Intent, Rejection, TabPlacement, TabSelection } from "../generated/crest_contracts.js";
import { TabPlacement as Placement, textsOfRejection } from "../generated/crest_contracts.js";
import { dispatch, query, Refused } from "./bridge.js";
import { pinColumnRequest } from "./device-appearance.js";
import type { Model, Space } from "./model.js";
import { listKey } from "./model.js";
import { Notices, postNotice } from "./notices.js";
import { holdOverlay } from "./overlay.js";

// MARK: - Types

/** What the window offers a drag beyond the sidebar. */
export interface SidebarDragHost {
    readonly model: Model;
    readonly windowId: () => Guid;
    /** Draws the sidebar again, once a lift has let go of it. */
    readonly redraw: () => void;
    /** Whether another gesture holds the sidebar, so no lift may begin. */
    readonly isLocked: () => boolean;
    /** The page cards a tab can join as a split (page-cards.ts). */
    readonly cards: () => DropCards;
    /** Opens the tab `tabId` of `spaceId` in a window of its own (windows.ts). */
    readonly tearOff: (spaceId: Guid, tabId: Guid) => void;
}

/** The page cards, as a lift over them sees them. */
export interface DropCards {
    /** The cards on show, in order: the split's, or the one page's. */
    frames(): DOMRect[];
    /** Opens room for a card at `index` among them, or closes it for null. */
    previewDrop(index: number | null): void;
}

interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

type RowKind = "tab" | "folder" | "split";

/** A run of rows a lift can be inserted into (BrowserSidebarReorderSection.tabs). */
interface Section {
    readonly placement: TabPlacement;
    readonly folderId: Guid | null;
}

/** A row measured as the lift began (BrowserSidebarReorderRow). */
interface Row {
    readonly key: string;
    readonly kind: RowKind;
    readonly id: Guid;
    readonly section: Section;
    /** The split row a member's card stands in. */
    readonly parentKey: string | null;
    readonly frame: Rect;
    readonly element: HTMLElement;
    readonly scrolls: boolean;
}

type ZoneTarget =
    | { readonly kind: "section"; readonly section: Section }
    | { readonly kind: "folder"; readonly folderId: Guid }
    | { readonly kind: "currentTab"; readonly tabId: Guid }
    | { readonly kind: "space"; readonly spaceId: Guid }
    | { readonly kind: "content" };

/** A measured region that takes a lift (BrowserSidebarReorderZone). */
interface Zone {
    readonly target: ZoneTarget;
    readonly frame: Rect;
    readonly element: HTMLElement;
    readonly scrolls: boolean;
}

/** Where a lift lands when released (BrowserSidebarReorderTarget.Kind). */
type Target =
    | { readonly kind: "insert"; readonly section: Section; readonly beforeKey: string | null; readonly index: number }
    | { readonly kind: "intoFolder"; readonly folderId: Guid }
    | { readonly kind: "aroundTab"; readonly tabId: Guid }
    | { readonly kind: "space"; readonly spaceId: Guid }
    | { readonly kind: "split"; readonly index: number };

/** The shape a lifted tab takes (BrowserTabDragPreviewShape). */
type Shape = "row" | "pin" | "card";

/** The gap a lift opens in a list (BrowserSidebarReorderLayout.Gap). */
interface Gap {
    readonly section: Section;
    readonly frame: Rect;
    readonly scrolls: boolean;
    readonly containingFolders: ReadonlySet<Guid>;
}

/** What the core says of one drop (BrowserSidebarDropVerdict). */
interface Verdict {
    readonly offered: boolean;
    readonly refusal: Rejection | null;
}

/** The rows, zones and pieces of the sidebar as the lift found them. */
interface Geometry {
    readonly rows: Row[];
    readonly byKey: Map<string, Row>;
    readonly zones: Zone[];
    /** Everything in the column that moves aside: rows, headers, the seam. */
    readonly leaves: { readonly element: HTMLElement; readonly frame: Rect; readonly scrolls: boolean }[];
    readonly tiles: Row[];
    readonly grid: { readonly element: HTMLElement; readonly frame: Rect; readonly emptyHeight: number };
    readonly scroller: HTMLElement | null;
    readonly scrollTop: number;
    readonly viewport: Rect | null;
    readonly sidebarRight: number;
}

interface Lift {
    readonly item: Row;
    readonly spaceId: Guid;
    readonly source: HTMLElement;
    readonly size: { readonly width: number; readonly height: number };
    /** Where the pointer holds the lift, as a share of its size, so it stays under the pointer as it changes shape. */
    readonly anchor: { readonly x: number; readonly y: number };
    readonly startX: number;
    readonly geometry: Geometry;
    /** Rows the lift carries or hides. */
    readonly hidden: ReadonlySet<string>;
    selection: TabSelection | null;
    targets: DropTargetList | null;
    readonly refusals: Map<string, Rejection | null>;
    target: Target | null;
    message: string | null;
    lastShape: Shape | null;
    gap: Gap | null;
    gridDelta: number;
    verticalDirection: number;
    outside: boolean;
    /** Whether the lift was let go and only waits for its drop to land. */
    ending: boolean;
}

// MARK: - Constants

/** BrowserPlatformSidebarReorderLiftGesture.liftDistance. */
const liftDistance = 4;
/** BrowserSidebarReorderZone.slop: how far past a run the pointer may stray and still append to it. */
const slop = 160;
/** BrowserSidebarReorderZone.folderNestBand: the middle share of a row that files into it. */
const nestBand = 0.5;
/** BrowserSidebarReorderState.sidebarExitBuffer: past the sidebar by this much, a tab offers a split. */
const exitBuffer = 24;
/** BrowserSidebarReorderState.activationSuppression. */
const activationSuppression = 250;
/** BrowserTabDragPreviewLayout's sizes. */
const pinSize = { width: 52, height: 52 };
const cardSize = { width: 240, height: 160 };
/** The run an empty list still offers to aim at. */
const emptyRunHeight = 8;
/** How near a scrolling list's edge the lift scrolls it, and how fast at most, per frame. */
const autoscrollEdge = 32;
const autoscrollStep = 14;
/** BrowserStore.newFolderTitle. */
const newFolderTitle = "New Folder";

// MARK: - Geometry

function rectOf(element: Element): Rect {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function contains(rect: Rect, x: number, y: number): boolean {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function maxY(rect: Rect): number {
    return rect.y + rect.height;
}

function sectionKey(section: Section): string {
    return `${section.placement}|${section.folderId ?? ""}`;
}

function sameSection(a: Section | null | undefined, b: Section | null | undefined): boolean {
    return !!a && !!b && a.placement === b.placement && a.folderId === b.folderId;
}

function isGrid(section: Section): boolean {
    return Placement.facts[section.placement].isGrid;
}

function cssPixels(token: string, fallback: number): number {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) || fallback;
}

/** The middle of a row a nesting target claims, leaving its edges to the run around it. */
function nestingFrame(frame: Rect): Rect {
    const inset = (frame.height * (1 - nestBand)) / 2;
    return { x: frame.x, y: frame.y + inset, width: frame.width, height: frame.height - inset * 2 };
}

/** What the person is told of a refused drop: the rule's words, or Rejection.unplaceable. */
function placementExplanation(rejection: Rejection): string {
    return textsOfRejection(rejection).message?.text ?? "These items cannot be placed here. Choose another destination.";
}

// MARK: - Drag

export class SidebarDrag {
    private readonly host: SidebarDragHost;
    private readonly root: HTMLElement;
    private readonly page: HTMLElement;
    /** A press that may become a lift once it moves far enough. */
    private press: { readonly pointerId: number; readonly x: number; readonly y: number; readonly row: HTMLElement } | null = null;
    private lift: Lift | null = null;
    private pointer = { x: 0, y: 0 };
    private preview: HTMLElement | null = null;
    private releaseOverlay: (() => void) | null = null;
    private autoscrollFrame = 0;
    private suppressUntil = 0;
    /** The row a drop just landed, kept faint until the preview reaches it. */
    private landingKey: string | null = null;
    private generation = 0;
    /** When the preview of the last drop reaches where it lands. */
    private landingUntil = 0;

    constructor(host: SidebarDragHost, root: HTMLElement, page: HTMLElement) {
        this.host = host;
        this.root = root;
        this.page = page;
        page.addEventListener("pointerdown", (event) => this.pressed(event));
        root.addEventListener("pointermove", (event) => this.moved(event));
        root.addEventListener("pointerup", (event) => this.released(event));
        root.addEventListener("pointercancel", () => this.cancel());
        root.addEventListener("lostpointercapture", () => this.cancel());
        // A row lets go of its click for a moment after a drop, as on the Mac.
        root.addEventListener(
            "click",
            (event) => {
                if (performance.now() >= this.suppressUntil) return;
                event.preventDefault();
                event.stopPropagation();
            },
            true,
        );
        window.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || !this.lift) return;
            event.preventDefault();
            event.stopPropagation();
            this.cancel();
        }, true);
    }

    /** Whether a lift is in flight. */
    get isLifting(): boolean {
        return this.lift !== null;
    }

    /** Whether the sidebar waits to draw until the lift lands. */
    get holdsDrawing(): boolean {
        return this.lift !== null;
    }

    /** Marks what the sidebar just drew that the drop is still landing on. */
    decorate(): void {
        if (!this.landingKey) return;
        const [kind, id] = this.landingKey.split(":");
        this.page.querySelector(`[data-row="${kind}"][data-id="${id}"]`)?.classList.add("drag-landing");
    }

    // MARK: - Actions - Pressing

    private pressed(event: PointerEvent): void {
        if (event.button !== 0 || this.lift || this.host.isLocked()) return;
        const target = event.target as HTMLElement;
        // The close button, the rename field and Clear keep the press.
        if (target.closest("input, .close, .clear, .space-actions")) return;
        const row = target.closest<HTMLElement>("[data-row]");
        if (!row || !this.page.contains(row) || row.closest(".preview")) return;
        // A folder lifts from its header; a press on its rows lifts the row.
        if (row.dataset.row === "folder" && !target.closest(".folder-header")) return;
        this.press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, row };
    }

    private moved(event: PointerEvent): void {
        this.pointer = { x: event.clientX, y: event.clientY };
        const press = this.press;
        if (press && !this.lift && event.pointerId === press.pointerId) {
            if ((event.buttons & 1) === 0) {
                this.press = null;
                return;
            }
            if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < liftDistance) return;
            this.press = null;
            this.begin(press.row, press.x, press.y, event.pointerId);
        }
        if (!this.lift || this.lift.ending) return;
        const delta = event.clientY - this.lastY;
        if (Math.abs(delta) > 0.5) this.lift.verticalDirection = delta > 0 ? 1 : -1;
        this.lastY = event.clientY;
        this.lift.outside = event.clientX < 0 || event.clientY < 0 || event.clientX > innerWidth || event.clientY > innerHeight;
        this.resolve();
    }

    private lastY = 0;

    private released(event: PointerEvent): void {
        if (this.press?.pointerId === event.pointerId) this.press = null;
        const lift = this.lift;
        if (!lift || lift.ending) return;
        this.pointer = { x: event.clientX, y: event.clientY };
        lift.outside = event.clientX < 0 || event.clientY < 0 || event.clientX > innerWidth || event.clientY > innerHeight;
        if (lift.outside) {
            this.tearOff(lift);
            return;
        }
        this.resolve();
        void this.drop(lift);
    }

    // MARK: - Actions - Lifting

    /** Lifts `element`, pressed at (`x`, `y`), measuring the sidebar as it stands. */
    private begin(element: HTMLElement, x: number, y: number, pointerId: number): void {
        const window = this.host.model.windows.get(this.host.windowId());
        const space = window ? this.host.model.workspace?.spaces.get(window.shownSpaceId) : undefined;
        if (!space) return;
        const geometry = this.measure();
        const item = geometry.rows.find((row) => row.element === element);
        if (!item) return;
        const hidden = new Set<string>([item.key]);
        for (const row of geometry.rows) if (element.contains(row.element)) hidden.add(row.key);
        const frame = item.frame;
        this.lastY = y;
        const lift: Lift = {
            item,
            spaceId: space.state.id,
            source: element,
            size: { width: frame.width, height: frame.height },
            anchor: {
                x: frame.width > 0 ? (x - frame.x) / frame.width : 0.5,
                y: frame.height > 0 ? (y - frame.y) / frame.height : 0.5,
            },
            startX: x,
            geometry,
            hidden,
            selection: null,
            targets: null,
            refusals: new Map(),
            target: null,
            message: null,
            lastShape: null,
            gap: null,
            gridDelta: 0,
            verticalDirection: 0,
            outside: false,
            ending: false,
        };
        // The lift starts over its own slot, so nothing moves until the pointer does.
        const own = this.rowsIn(lift, item.section);
        const index = own.filter((row) => row.frame.y < frame.y || (row.frame.y === frame.y && row.frame.x < frame.x)).filter((row) => !hidden.has(row.key)).length;
        const before = own.filter((row) => !hidden.has(row.key))[index];
        // A split's member stays in its split until the pointer leaves it.
        lift.target = item.parentKey ? null : { kind: "insert", section: item.section, beforeKey: before?.key ?? null, index };
        this.lift = lift;
        this.generation++;
        this.landingKey = null;
        this.root.setPointerCapture(pointerId);
        this.releaseOverlay = holdOverlay();
        this.root.classList.add("lifting");
        document.body.classList.add("sidebar-lifting");
        element.classList.add("drag-source");
        this.preview = this.drawPreview(lift, space);
        this.refreshLayout();
        this.applyLayout();
        this.place();
        this.autoscroll();
        void this.plan(lift, space);
    }

    /**
     * Asks the core what the lift carries and where it may land, as the
     * Mac's BrowserSidebarLiftPlan does once as the lift begins.
     */
    private async plan(lift: Lift, space: Space): Promise<void> {
        const workspaceId = this.host.model.workspace!.id;
        const picks = lift.item.kind === "folder"
            ? { tabIds: [], folderIds: [lift.item.id] }
            : { tabIds: lift.item.kind === "split" ? this.members(lift.item) : [lift.item.id], folderIds: [] };
        try {
            const selected = await query("SelectionPreview", { workspaceId, spaceId: space.state.id, ...picks });
            if (this.lift !== lift) return;
            lift.selection = selected.selection;
            const targets = await query("DropTargets", {
                workspaceId,
                windowId: this.host.windowId(),
                spaceId: space.state.id,
                selection: selected.selection,
            });
            if (this.lift !== lift) return;
            lift.targets = targets;
            this.resolve();
        } catch (error) {
            console.error(error);
        }
    }

    /** Measures every row, run and piece of the sidebar as it is drawn now. */
    private measure(): Geometry {
        const scroller = this.page.querySelector<HTMLElement>(".tabs");
        const scrolls = (element: Element): boolean => !!scroller && scroller.contains(element);
        const rows: Row[] = [];
        for (const element of this.page.querySelectorAll<HTMLElement>("[data-row]")) {
            const list = element.parentElement?.closest<HTMLElement>("[data-placement]");
            const kind = element.dataset.row as RowKind;
            const id = element.dataset.id;
            if (!list || !id) continue;
            const parent = element.parentElement?.closest<HTMLElement>('[data-row="split"]');
            rows.push({
                key: `${kind}:${id}`,
                kind,
                id,
                section: { placement: list.dataset.placement as TabPlacement, folderId: list.dataset.folder || null },
                parentKey: parent?.dataset.id ? `split:${parent.dataset.id}` : null,
                frame: rectOf(element),
                element,
                scrolls: scrolls(element),
            });
        }
        const sidebarRight = this.root.getBoundingClientRect().right;
        const zones: Zone[] = [];
        for (const element of this.page.querySelectorAll<HTMLElement>("[data-placement]")) {
            const frame = rectOf(element);
            const section = { placement: element.dataset.placement as TabPlacement, folderId: element.dataset.folder || null };
            const minimum = section.placement === "Pinned" ? cssPixels("--tab-section-end-band", 12) : emptyRunHeight;
            zones.push({
                target: { kind: "section", section },
                frame: { ...frame, height: Math.max(frame.height, minimum) },
                element,
                scrolls: scrolls(element),
            });
        }
        const space = this.shownSpace();
        for (const row of rows) {
            if (row.kind === "folder" && space?.folders.get(row.id)?.isCollapsed) {
                const header = row.element.querySelector<HTMLElement>(".folder-header") ?? row.element;
                zones.push({ target: { kind: "folder", folderId: row.id }, frame: nestingFrame(rectOf(header)), element: header, scrolls: row.scrolls });
            } else if (row.kind === "tab" && row.section.placement === "Current" && row.section.folderId === null && !row.parentKey) {
                zones.push({ target: { kind: "currentTab", tabId: row.id }, frame: nestingFrame(row.frame), element: row.element, scrolls: row.scrolls });
            }
        }
        for (const segment of this.root.querySelectorAll<HTMLElement>("[data-space]")) {
            zones.push({ target: { kind: "space", spaceId: segment.dataset.space! }, frame: rectOf(segment), element: segment, scrolls: false });
        }
        const content = document.getElementById("page");
        if (content) zones.push({ target: { kind: "content" }, frame: rectOf(content), element: content, scrolls: false });
        const leaves = [...this.page.querySelectorAll<HTMLElement>(".row, .seam, .space-header-bar")]
            .filter((element) => !element.parentElement?.closest(".row"))
            .map((element) => ({ element, frame: rectOf(element), scrolls: scrolls(element) }));
        const gridElement = this.page.querySelector<HTMLElement>(".pinned")!;
        const tiles = rows.filter((row) => row.section.placement === "Pinned");
        return {
            rows,
            byKey: new Map(rows.map((row) => [row.key, row])),
            zones,
            leaves,
            tiles,
            grid: {
                element: gridElement,
                frame: rectOf(gridElement),
                emptyHeight: tiles.length === 0 ? cssPixels("--tab-section-end-band", 12) : 0,
            },
            scroller,
            scrollTop: scroller?.scrollTop ?? 0,
            viewport: scroller ? rectOf(scroller) : null,
            sidebarRight,
        };
    }

    // MARK: - Actions - Aiming

    /** How far the list scrolled since the lift measured it. */
    private scrollDelta(lift: Lift): number {
        const { scroller, scrollTop } = lift.geometry;
        return scroller ? scroller.scrollTop - scrollTop : 0;
    }

    /** A measured frame where it is on screen now. */
    private live(lift: Lift, frame: Rect, scrolls: boolean): Rect {
        return scrolls ? { ...frame, y: frame.y - this.scrollDelta(lift) } : frame;
    }

    /** Works out where the lift would land now, and shows it. */
    private resolve(): void {
        const lift = this.lift;
        if (!lift) return;
        const previous = lift.target;
        lift.target = lift.outside ? null : this.aim(lift, previous);
        this.validate(lift);
        if (!sameTarget(previous, lift.target)) {
            this.refreshLayout();
            this.applyLayout();
        }
        this.place();
    }

    /** BrowserSidebarReorderAim.target. */
    private aim(lift: Lift, previous: Target | null): Target | null {
        const zones = this.visibleZones(lift).filter((zone) => this.allowsNesting(lift, zone));
        const pointer = this.pointer;
        const probe = this.probe(lift);
        const direct = this.aimed(lift, pointer, zones);
        if (direct?.target.kind === "space") return this.landing(lift, direct);
        // The open gap holds its place while the rows around it move.
        const gap = this.gapFrame(lift);
        if (gap && contains(gap, probe.x, probe.y)) return previous;
        const pinnedGap = this.pinned(lift).gap;
        if (pinnedGap && contains(pinnedGap, pointer.x, pointer.y)) return previous;
        const nesting = direct && (direct.target.kind === "folder" || direct.target.kind === "currentTab") ? direct : null;
        const zone = nesting ?? this.aimed(lift, probe, zones);
        return zone ? this.landing(lift, zone) : null;
    }

    /** Tall blocks cross their neighbours with their moving edge, not the grabbed header. */
    private probe(lift: Lift): { x: number; y: number } {
        const rowHeight = cssPixels("--tab-row-height", 40);
        if (lift.size.height <= rowHeight * 1.5 || lift.verticalDirection === 0) return this.pointer;
        const top = this.pointer.y - lift.anchor.y * lift.size.height;
        return { x: this.pointer.x, y: lift.verticalDirection > 0 ? top + lift.size.height : top };
    }

    /** The zones as the lift has moved them, clipped to what the sidebar shows. */
    private visibleZones(lift: Lift): Zone[] {
        const { geometry } = lift;
        const viewport = geometry.viewport;
        const zones: Zone[] = [];
        for (const zone of geometry.zones) {
            if (zone.target.kind !== "space" && zone.target.kind !== "content" && lift.source.contains(zone.element) && zone.element !== lift.source) continue;
            if (zone.element === lift.source && zone.target.kind !== "section") continue;
            let frame: Rect | null;
            const target = zone.target;
            if (target.kind === "section" && isGrid(target.section)) {
                const pinned = this.pinned(lift);
                frame = { ...geometry.grid.frame, height: Math.max(pinned.height, geometry.grid.frame.height, geometry.grid.emptyHeight) };
            } else if (target.kind === "section") {
                frame = this.project(lift, zone.frame, this.holdsGap(lift, target.section, zone.frame));
            } else if (target.kind === "folder" || target.kind === "currentTab") {
                frame = this.project(lift, zone.frame, false);
            } else {
                frame = zone.frame;
            }
            frame = this.live(lift, frame, zone.scrolls);
            if (zone.scrolls && viewport) {
                const top = Math.max(frame.y, viewport.y);
                const bottom = Math.min(maxY(frame), maxY(viewport));
                if (bottom <= top) continue;
                frame = { ...frame, y: top, height: bottom - top };
            }
            if (target.kind === "section") frame = { ...frame, width: geometry.sidebarRight + exitBuffer - frame.x };
            if (frame.width <= 0 || frame.height <= 0) continue;
            zones.push({ ...zone, frame });
        }
        return zones;
    }

    /** BrowserSidebarReorderZone.aimed: the innermost zone that takes the lift, or the nearest run in its column. */
    private aimed(lift: Lift, point: { x: number; y: number }, zones: readonly Zone[]): Zone | null {
        const usable = zones.filter((zone) => this.accepts(lift, zone.target) && this.offers(lift, zone.target));
        const containing = usable.filter((zone) => contains(this.aimingFrame(zone), point.x, point.y));
        let innermost: Zone | null = null;
        for (const zone of containing) if (!innermost || this.lessSpecific(innermost, zone)) innermost = zone;
        if (innermost && innermost.target.kind !== "content") return innermost;
        // A run within reach in its own column is offered before the page.
        let nearest: { zone: Zone; distance: number } | null = null;
        for (const zone of usable) {
            if (zone.target.kind !== "section" || point.x < zone.frame.x || point.x > zone.frame.x + zone.frame.width) continue;
            const distance = point.y < zone.frame.y ? zone.frame.y - point.y : point.y > maxY(zone.frame) ? point.y - maxY(zone.frame) : 0;
            if (distance > slop) continue;
            if (!nearest || distance < nearest.distance || (distance === nearest.distance && this.lessSpecific(nearest.zone, zone))) {
                nearest = { zone, distance };
            }
        }
        return nearest?.zone ?? innermost;
    }

    /** A folder's run owns its rows, and its outer edge belongs to the run around it. */
    private aimingFrame(zone: Zone): Rect {
        if (zone.target.kind !== "section" || !zone.target.section.folderId) return zone.frame;
        const inset = Math.min(8, zone.frame.height / 4);
        return { ...zone.frame, y: zone.frame.y + inset, height: zone.frame.height - inset * 2 };
    }

    /** Ranks overlapping zones: more specific, then more deeply nested, then smaller. */
    private lessSpecific(a: Zone, b: Zone): boolean {
        const specificity = (zone: Zone): number =>
            ({ space: 3, folder: 2, currentTab: 2, section: 1, content: 0 })[zone.target.kind];
        const depth = (zone: Zone): number => (zone.target.kind === "section" && zone.target.section.folderId ? 1 : 0);
        if (specificity(a) !== specificity(b)) return specificity(a) < specificity(b);
        if (depth(a) !== depth(b)) return depth(a) < depth(b);
        return a.frame.width * a.frame.height > b.frame.width * b.frame.height;
    }

    /** Whether the zone takes what the lift carries at all (BrowserSidebarReorderZone.Target.accepts). */
    private accepts(lift: Lift, target: ZoneTarget): boolean {
        const item = lift.item;
        switch (target.kind) {
            case "section":
                if (item.kind === "folder") return Placement.facts[target.section.placement].holdsFolders;
                if (item.kind === "split") return Placement.facts[target.section.placement].holdsSplits;
                return true;
            case "currentTab":
                if (item.kind === "folder") return false;
                if (item.kind === "split") return !this.members(item).includes(target.tabId);
                return item.id !== target.tabId;
            case "folder":
            case "space":
                return true;
            case "content":
                return item.kind !== "folder";
        }
    }

    /** Whether the core lists a drop on the zone for this lift, refused or not. */
    private offers(lift: Lift, target: ZoneTarget): boolean {
        const targets = lift.targets;
        if (!targets || targets.refusal) return true;
        switch (target.kind) {
            case "section":
                return targets.lists.some((list) => list.section === target.section.placement && list.folderId === target.section.folderId);
            case "folder":
                return targets.lists.some((list) => list.folderId === target.folderId);
            case "currentTab":
                return targets.folderAroundTabIds.includes(target.tabId);
            case "space":
                return targets.spaceIds.includes(target.spaceId);
            case "content":
                return targets.split !== null && targets.split.refusal === null;
        }
    }

    /** Horizontal movement admits deeper folder runs to a lifted folder; vertical motion stays among siblings. */
    private allowsNesting(lift: Lift, zone: Zone): boolean {
        if (lift.item.kind !== "folder" || zone.target.kind !== "section") return true;
        const indent = cssPixels("--folder-content-indent", 16);
        const extra = Math.max(0, Math.floor((this.pointer.x - lift.startX) / indent));
        return this.folderDepth(zone.target.section.folderId) <= this.folderDepth(lift.item.section.folderId) + extra;
    }

    private folderDepth(folderId: Guid | null): number {
        const space = this.shownSpace();
        const seen = new Set<Guid>();
        for (let id = folderId; id && !seen.has(id); id = space?.folders.get(id)?.parentId ?? null) seen.add(id);
        return seen.size;
    }

    /** Where a lift aimed at `zone` lands (BrowserSidebarReorderZone.Target.reorderTarget). */
    private landing(lift: Lift, zone: Zone): Target | null {
        const target = zone.target;
        switch (target.kind) {
            case "currentTab":
                return { kind: "aroundTab", tabId: target.tabId };
            case "space":
                return { kind: "space", spaceId: target.spaceId };
            case "folder":
                return lift.item.key === `folder:${target.folderId}` ? null : { kind: "intoFolder", folderId: target.folderId };
            case "section":
                return this.insertion(lift, target.section);
            case "content": {
                const frames = this.host.cards().frames().filter((frame) => frame.width > 0).sort((a, b) => a.x - b.x);
                if (frames.length === 0) return null;
                let index = 0;
                for (const frame of frames) {
                    if (this.pointer.x <= frame.x + frame.width / 2) break;
                    index++;
                }
                return { kind: "split", index };
            }
        }
    }

    /** Where a lift aimed at the run `section` inserts, among the rows it does not carry. */
    private insertion(lift: Lift, section: Section): Target | null {
        // A split's member stays where it is while the pointer is over its own split.
        if (sameSection(section, lift.item.section) && lift.item.parentKey) {
            const parent = lift.geometry.byKey.get(lift.item.parentKey);
            if (parent && contains(this.live(lift, this.project(lift, parent.frame, false), parent.scrolls), this.pointer.x, this.pointer.y)) return null;
        }
        const grid = isGrid(section);
        const pinned = grid ? this.pinned(lift) : null;
        const point = grid ? this.pointer : this.probe(lift);
        const candidates = this.rowsIn(lift, section).filter((row) => !lift.hidden.has(row.key));
        let index = 0;
        for (const row of candidates) {
            const frame = grid
                ? (pinned!.cells.get(row.key) ?? row.frame)
                : this.live(lift, this.project(lift, row.frame, row.kind === "folder" && !!lift.gap?.containingFolders.has(row.id)), row.scrolls);
            const passed = grid
                ? point.y > maxY(frame) || (point.y >= frame.y && point.x > frame.x + frame.width / 2)
                : point.y > frame.y + frame.height / 2;
            if (!passed) break;
            index++;
        }
        return { kind: "insert", section, beforeKey: candidates[index]?.key ?? null, index };
    }

    /** The rows standing at the top level of `section`, in reading order. */
    private rowsIn(lift: Lift, section: Section): Row[] {
        return lift.geometry.rows
            .filter((row) => !row.parentKey && sameSection(row.section, section))
            .sort((a, b) => (isGrid(section) && a.frame.y === b.frame.y ? a.frame.x - b.frame.x : a.frame.y - b.frame.y));
    }

    /**
     * Asks what the core says of the target the lift is over: one it offers
     * no such drop for lands nowhere, and one it refuses keeps its place with
     * the refusal's own words (BrowserSidebarReorderState.validateTarget).
     */
    private validate(lift: Lift): void {
        const target = lift.target;
        if (!target) {
            lift.message = null;
            return;
        }
        const verdict = this.verdict(lift, target);
        if (!verdict.offered) lift.target = null;
        lift.message = verdict.refusal ? placementExplanation(verdict.refusal) : null;
    }

    /** BrowserSidebarLiftPlan.verdict. */
    private verdict(lift: Lift, target: Target): Verdict {
        const targets = lift.targets;
        if (!targets) return { offered: false, refusal: null };
        if (targets.refusal) return { offered: true, refusal: targets.refusal };
        const allowed = { offered: true, refusal: null };
        switch (target.kind) {
            case "insert": {
                const list = targets.lists.find((list) => list.section === target.section.placement && list.folderId === target.section.folderId);
                return list ? this.ask(lift, `list:${sectionKey(target.section)}`, () => this.listDrop(lift, list.section, list.folderId, null, null)) : { offered: false, refusal: null };
            }
            case "intoFolder": {
                const list = targets.lists.find((list) => list.folderId === target.folderId);
                return list ? this.ask(lift, `list:${list.section}|${target.folderId}`, () => this.listDrop(lift, list.section, target.folderId, null, null)) : { offered: false, refusal: null };
            }
            case "space":
                if (!targets.spaceIds.includes(target.spaceId)) return { offered: false, refusal: null };
                return this.ask(lift, `space:${target.spaceId}`, () => this.spaceDrop(lift, target.spaceId));
            case "split":
                return targets.split ? { offered: true, refusal: targets.split.refusal } : { offered: false, refusal: null };
            case "aroundTab":
                return targets.folderAroundTabIds.includes(target.tabId) ? allowed : { offered: false, refusal: null };
        }
    }

    /**
     * The core's answer for one list or Space the lift reached, asked the
     * first time it gets there and kept for the lift (BrowserSidebarDropRefusals).
     * Until it answers, the drop is taken as allowed; its commit decides.
     */
    private ask(lift: Lift, key: string, drop: () => Intent | null): Verdict {
        if (lift.refusals.has(key)) return { offered: true, refusal: lift.refusals.get(key) ?? null };
        lift.refusals.set(key, null);
        const intent = drop();
        if (intent) {
            void query("CanSend", { intent }).then(
                (answer) => {
                    if (this.lift !== lift || !answer.refusal) return;
                    lift.refusals.set(key, answer.refusal);
                    this.resolve();
                },
                (error: unknown) => console.error(error),
            );
        }
        return { offered: true, refusal: null };
    }

    // MARK: - Actions - Layout

    /** The pinned grid as the lift rearranges it (BrowserPinnedTabReorderLayout). */
    private pinned(lift: Lift): { cells: Map<string, Rect>; gap: Rect | null; height: number } {
        const { grid, tiles } = lift.geometry;
        const ids = tiles.filter((tile) => !lift.hidden.has(tile.key)).map((tile) => tile.key);
        const target = lift.target;
        const insertion = target?.kind === "insert" && isGrid(target.section) && !lift.message ? Math.min(target.index, ids.length) : null;
        const count = ids.length + (insertion === null ? 0 : 1);
        const cells = new Map<string, Rect>();
        if (count === 0) return { cells, gap: null, height: 0 };
        const spacing = cssPixels("--pin-spacing", 8);
        const tileHeight = tiles[0]?.frame.height ?? cssPixels("--pin-tile-height", 47);
        const columns = pinnedColumnsFor(count, grid.frame.width, spacing);
        const width = (grid.frame.width - (columns - 1) * spacing) / columns;
        const slot = (index: number): Rect => ({
            x: grid.frame.x + (index % columns) * (width + spacing),
            y: grid.frame.y + Math.floor(index / columns) * (tileHeight + spacing),
            width,
            height: tileHeight,
        });
        let gap: Rect | null = null;
        let index = 0;
        for (const id of ids) {
            if (index === insertion) gap = slot(index++);
            cells.set(id, slot(index++));
        }
        if (insertion !== null && insertion >= ids.length) gap = slot(index);
        const rows = Math.ceil(count / columns);
        return { cells, gap, height: rows * tileHeight + (rows - 1) * spacing };
    }

    /** Opens the gap where the lift would land in a list (BrowserSidebarReorderState.refreshLayout). */
    private refreshLayout(): void {
        const lift = this.lift;
        if (!lift) return;
        const fromGrid = isGrid(lift.item.section);
        const target = lift.target;
        const pinned = this.pinned(lift);
        const { grid } = lift.geometry;
        lift.gridDelta = fromGrid || (target?.kind === "insert" && isGrid(target.section))
            ? Math.max(grid.emptyHeight, pinned.height) - grid.frame.height
            : 0;
        lift.gap = null;
        if (lift.message || target?.kind !== "insert" || isGrid(target.section)) return;
        const candidates = this.rowsIn(lift, target.section).filter((row) => !lift.hidden.has(row.key));
        const before = target.beforeKey ? candidates.find((row) => row.key === target.beforeKey) : undefined;
        const last = candidates[candidates.length - 1];
        let frame: Rect;
        let scrolls: boolean;
        if (before) {
            frame = before.frame;
            scrolls = before.scrolls;
        } else if (last) {
            frame = { x: last.frame.x, y: maxY(last.frame), width: last.frame.width, height: 0 };
            scrolls = last.scrolls;
        } else {
            const zone = lift.geometry.zones.find((zone) => zone.target.kind === "section" && sameSection(zone.target.section, target.section));
            if (!zone) return;
            frame = { x: zone.frame.x, y: zone.frame.y, width: zone.frame.width, height: 0 };
            scrolls = zone.scrolls;
        }
        const containing = new Set<Guid>();
        const space = this.shownSpace();
        for (let id = target.section.folderId; id && !containing.has(id); id = space?.folders.get(id)?.parentId ?? null) containing.add(id);
        lift.gap = { section: target.section, frame, scrolls, containingFolders: containing };
    }

    /** How tall the gap opens: the lifted row's height, or a row's for a pin or a split's member. */
    private gapHeight(lift: Lift): number {
        return isGrid(lift.item.section) || lift.item.parentKey ? cssPixels("--tab-row-height", 40) : lift.size.height;
    }

    /** `y`, measured as the lift began, once the lift's source is taken out of the column. */
    private removingSource(lift: Lift, y: number): number {
        const source = lift.item.frame;
        // A pin leaves the grid to the grid's own layout, and a split's member leaves its split row standing.
        const removal = isGrid(lift.item.section) || lift.item.parentKey ? 0 : Math.min(source.height, Math.max(0, y - source.y));
        const grid = lift.geometry.grid.frame;
        const gridShift = y >= maxY(grid) - 0.5 ? lift.gridDelta : 0;
        return y - removal + gridShift;
    }

    /** Where the open gap is, measured as the lift began. */
    private gapRect(lift: Lift): Rect | null {
        const gap = lift.gap;
        if (!gap) return null;
        return { x: gap.frame.x, y: this.removingSource(lift, gap.frame.y), width: gap.frame.width, height: this.gapHeight(lift) };
    }

    /** Where the open gap is on screen now. */
    private gapFrame(lift: Lift): Rect | null {
        const rect = this.gapRect(lift);
        return rect ? this.live(lift, rect, lift.gap!.scrolls) : null;
    }

    /** `frame` as the lift moves its column: the source taken out and the gap opened (BrowserSidebarReorderLayout.project). */
    private project(lift: Lift, frame: Rect, containsGap: boolean): Rect {
        const top = this.removingSource(lift, frame.y);
        const result = { x: frame.x, y: top, width: frame.width, height: Math.max(0, this.removingSource(lift, maxY(frame)) - top) };
        const gap = this.gapRect(lift);
        if (!gap) return result;
        if (containsGap) return { ...result, height: result.height + gap.height };
        if (result.y >= gap.y - 0.5) return { ...result, y: result.y + gap.height };
        return result;
    }

    /** Whether the run `section`, measured at `frame`, holds the open gap. */
    private holdsGap(lift: Lift, section: Section, frame: Rect): boolean {
        const gap = lift.gap;
        if (!gap) return false;
        return sameSection(section, gap.section)
            || (!!section.folderId && gap.containingFolders.has(section.folderId))
            || (frame.y < gap.frame.y && maxY(frame) >= gap.frame.y);
    }

    /** Moves every row, header and tile to where the lift's layout puts it, and marks what it aims at. */
    private applyLayout(): void {
        const lift = this.lift;
        if (!lift) return;
        for (const leaf of lift.geometry.leaves) {
            if (lift.source.contains(leaf.element)) continue;
            const dy = this.project(lift, leaf.frame, false).y - leaf.frame.y;
            leaf.element.style.transform = dy ? `translateY(${dy}px)` : "";
        }
        const pinned = this.pinned(lift);
        for (const tile of lift.geometry.tiles) {
            const cell = pinned.cells.get(tile.key);
            if (!cell) continue;
            tile.element.style.transform = `translate(${cell.x - tile.frame.x}px, ${cell.y - tile.frame.y}px)`;
            tile.element.style.width = `${cell.width}px`;
        }
        const target = lift.target;
        for (const marked of this.root.querySelectorAll(".drop-nest, .drop-into, .drop-target")) {
            marked.classList.remove("drop-nest", "drop-into", "drop-target");
        }
        if (target?.kind === "aroundTab") lift.geometry.byKey.get(`tab:${target.tabId}`)?.element.classList.add("drop-nest");
        if (target?.kind === "intoFolder") {
            const header = lift.geometry.byKey.get(`folder:${target.folderId}`)?.element.querySelector(".folder-header");
            // A folder filed inside another wears an outline; a tab lights the header as a row.
            header?.classList.add(lift.item.kind === "folder" ? "drop-nest" : "drop-into");
        }
        if (target?.kind === "space") this.root.querySelector(`[data-space="${target.spaceId}"]`)?.classList.add("drop-target");
        this.host.cards().previewDrop(target?.kind === "split" && !lift.message ? target.index : null);
    }

    // MARK: - Actions - Preview

    /** The shape a lifted tab takes over its target (BrowserSidebarReorderState.liftTargetShape). */
    private shape(lift: Lift): Shape {
        // Over no target of its own, a tile stays a tile, and anything else takes the shape it rests in.
        const resting: Shape = lift.lastShape === "pin" || isGrid(lift.item.section) ? "pin" : "row";
        if (lift.message) return isGrid(lift.item.section) ? "pin" : "row";
        if (lift.item.kind !== "tab") return "row";
        const target = lift.target;
        if (!target) return resting;
        switch (target.kind) {
            case "insert":
                return isGrid(target.section) ? "pin" : "row";
            case "intoFolder":
            case "aroundTab":
                return "row";
            case "split":
                return "card";
            case "space":
                return resting;
        }
    }

    /** The lift's floating preview: a tab's favicon and title, or the folder or split as drawn. */
    private drawPreview(lift: Lift, space: Space): HTMLElement {
        const preview = document.createElement("div");
        preview.className = "drag-lift";
        preview.setAttribute("aria-hidden", "true");
        const body = document.createElement("div");
        body.className = "drag-lift-body";
        if (lift.item.kind === "tab") {
            const tab = space.tabs.find((held) => held.id === lift.item.id);
            const icon = lift.item.element.querySelector(".favicon")?.cloneNode(true) as HTMLElement | undefined;
            if (icon) body.append(icon);
            const title = document.createElement("span");
            title.className = "title";
            title.textContent = tab?.displayTitle || tab?.url || "New Tab";
            body.append(title);
            preview.classList.add("tab");
        } else {
            const copy = lift.item.element.cloneNode(true) as HTMLElement;
            copy.classList.remove("drag-source", "selected");
            copy.removeAttribute("data-row");
            for (const node of copy.querySelectorAll("[data-row]")) node.removeAttribute("data-row");
            copy.style.margin = "0";
            body.append(copy);
        }
        const message = document.createElement("p");
        message.className = "drag-lift-message";
        preview.append(body, message);
        document.body.append(preview);
        return preview;
    }

    /** Puts the preview under the pointer in the shape of its target. */
    private place(): void {
        const lift = this.lift;
        const preview = this.preview;
        if (!lift || !preview) return;
        const shape = this.shape(lift);
        if (lift.target) lift.lastShape = shape;
        const size = this.shapeSize(lift, shape);
        preview.dataset.shape = shape;
        preview.style.width = `${size.width}px`;
        preview.style.height = `${size.height}px`;
        const x = this.pointer.x - lift.anchor.x * size.width;
        const y = this.pointer.y - lift.anchor.y * size.height;
        preview.style.transform = `translate(${x}px, ${y}px)`;
        preview.classList.toggle("refused", lift.message !== null);
        const message = preview.querySelector(".drag-lift-message")!;
        if (message.textContent !== (lift.message ?? "")) message.textContent = lift.message ?? "";
    }

    private shapeSize(lift: Lift, shape: Shape): { width: number; height: number } {
        switch (shape) {
            case "pin": {
                const gap = this.pinned(lift).gap;
                const tile = lift.geometry.tiles[0]?.frame;
                return gap ? { width: gap.width, height: gap.height } : tile ? { width: tile.width, height: tile.height } : pinSize;
            }
            case "card":
                return cardSize;
            case "row": {
                if (!isGrid(lift.item.section)) return lift.size;
                return { width: lift.geometry.grid.frame.width, height: cssPixels("--tab-row-height", 40) };
            }
        }
    }

    // MARK: - Actions - Scrolling

    /** Scrolls the tab list while the lift rests near its top or bottom edge. */
    private autoscroll(): void {
        cancelAnimationFrame(this.autoscrollFrame);
        const step = (): void => {
            const lift = this.lift;
            const scroller = lift?.geometry.scroller;
            if (!lift || !scroller) return;
            const viewport = rectOf(scroller);
            const { x, y } = this.pointer;
            let delta = 0;
            if (x >= viewport.x && x <= viewport.x + viewport.width) {
                if (y < viewport.y + autoscrollEdge && y > viewport.y - autoscrollEdge) delta = -autoscrollStep * (1 - Math.max(0, y - viewport.y) / autoscrollEdge);
                else if (y > maxY(viewport) - autoscrollEdge && y < maxY(viewport) + autoscrollEdge) delta = autoscrollStep * (1 - Math.max(0, maxY(viewport) - y) / autoscrollEdge);
            }
            if (delta !== 0) {
                const before = scroller.scrollTop;
                scroller.scrollTop += delta;
                if (scroller.scrollTop !== before) this.resolve();
            }
            this.autoscrollFrame = requestAnimationFrame(step);
        };
        this.autoscrollFrame = requestAnimationFrame(step);
    }

    // MARK: - Actions - Dropping

    /** Drops the lift where it is aimed, as the core's drop intent for its target (BrowserSidebarDropCommit). */
    private async drop(lift: Lift): Promise<void> {
        const target = lift.message ? null : lift.target;
        const intent = target && lift.selection ? this.intent(lift, target) : null;
        const landing = this.landingFrame(lift, target);
        if (intent && target && target.kind !== "space" && target.kind !== "split") {
            this.landingKey = lift.item.key;
        }
        const generation = this.generation;
        this.finish(landing, intent !== null && landing === null);
        if (!intent) {
            this.release(generation);
            return;
        }
        try {
            await dispatch(intent);
        } catch (error) {
            const rejection = error instanceof Refused ? error.rejection : null;
            postNotice(Notices.failure(rejection ? placementExplanation(rejection) : String(error)));
            this.landingKey = null;
        }
        this.release(generation);
    }

    /** Where a lift released here settles, on screen, or null where it leaves the sidebar (landingFrame). */
    private landingFrame(lift: Lift, target: Target | null): Rect | null {
        if (!target) return rectOf(lift.source);
        switch (target.kind) {
            case "insert":
                if (isGrid(target.section)) return this.pinned(lift).gap;
                return this.gapFrame(lift);
            case "intoFolder": {
                const header = lift.geometry.byKey.get(`folder:${target.folderId}`)?.element.querySelector(".folder-header");
                return header ? rectOf(header) : null;
            }
            case "aroundTab": {
                const row = lift.geometry.byKey.get(`tab:${target.tabId}`);
                return row ? rectOf(row.element) : null;
            }
            case "space":
            case "split":
                return null;
        }
    }

    /** The core's drop intent for the lift landing on `target` (BrowserSidebarReorderTarget.Kind.drop). */
    private intent(lift: Lift, target: Target): Intent | null {
        switch (target.kind) {
            case "insert": {
                const before = target.beforeKey ? lift.geometry.byKey.get(target.beforeKey) : undefined;
                return this.listDrop(
                    lift,
                    target.section.placement,
                    target.section.folderId,
                    before ? this.anchorTab(lift, before) : null,
                    before?.kind === "folder" ? before.id : null,
                );
            }
            case "intoFolder": {
                const folder = this.shownSpace()?.folders.get(target.folderId);
                return folder ? this.listDrop(lift, folder.location, folder.id, null, null) : null;
            }
            case "space":
                return this.spaceDrop(lift, target.spaceId);
            case "split": {
                const window = this.host.model.windows.get(this.host.windowId());
                const shown = window?.shownTabs.find((tab) => tab.spaceId === lift.spaceId)?.tabId;
                if (!shown || !lift.selection) return null;
                return {
                    kind: "DropIntoSplit",
                    value: { ...this.lifted(lift), selection: lift.selection, targetTabId: shown, index: target.index },
                };
            }
            case "aroundTab":
                return lift.selection
                    ? { kind: "DropAroundTab", value: { ...this.lifted(lift), selection: lift.selection, tabId: target.tabId, title: newFolderTitle } }
                    : null;
        }
    }

    private lifted(lift: Lift): { workspaceId: Guid; windowId: Guid; spaceId: Guid } {
        return { workspaceId: this.host.model.workspace!.id, windowId: this.host.windowId(), spaceId: lift.spaceId };
    }

    private listDrop(lift: Lift, section: TabPlacement, folderId: Guid | null, beforeTabId: Guid | null, beforeFolderId: Guid | null): Intent | null {
        if (!lift.selection) return null;
        return {
            kind: "DropIntoList",
            value: { ...this.lifted(lift), selection: lift.selection, section, folderId, beforeTabId, beforeFolderId },
        };
    }

    private spaceDrop(lift: Lift, destinationSpaceId: Guid): Intent | null {
        if (!lift.selection) return null;
        return { kind: "DropOnSpace", value: { ...this.lifted(lift), selection: lift.selection, destinationSpaceId } };
    }

    /**
     * The tab a drop anchored on `row` lands in front of: the tab, a split's
     * first member the lift does not carry, or a folder's first such tab
     * (BrowserSidebarReorderItemID.anchorTabID).
     */
    private anchorTab(lift: Lift, row: Row): Guid | null {
        const lifted = new Set(lift.selection?.memberTabIds ?? []);
        switch (row.kind) {
            case "tab":
                return row.id;
            case "split":
                return this.members(row).find((id) => !lifted.has(id)) ?? null;
            case "folder": {
                const space = this.shownSpace();
                const folder = space?.folders.get(row.id);
                return space && folder ? this.firstTab(space, folder.location, row.id, lifted) : null;
            }
        }
    }

    private firstTab(space: Space, placement: TabPlacement, folderId: Guid, lifted: ReadonlySet<Guid>): Guid | null {
        for (const row of space.lists.get(listKey(placement, folderId))?.rows ?? []) {
            if (row.kind === "Tab" && !lifted.has(row.id)) return row.id;
            if (row.kind === "Split") {
                const member = row.members.find((id) => !lifted.has(id));
                if (member) return member;
            }
            if (row.kind === "Folder") {
                const inner = this.firstTab(space, placement, row.id, lifted);
                if (inner) return inner;
            }
        }
        return null;
    }

    /**
     * A tab released outside the window opens in a window of its own, when
     * the core lets it leave (CanTearOff). Wayland tells a window neither
     * where the pointer is on screen nor which window is under it, so the
     * tab always opens in a new window rather than joining one under the
     * pointer as the Mac's BrowserMacWindowDropAction can.
     * TODO(linux): drop on another Crest window once the shell can find it.
     */
    private tearOff(lift: Lift): void {
        const generation = this.generation;
        this.finish(null, true);
        this.release(generation);
        if (lift.item.kind !== "tab") return;
        const space = this.host.model.workspace?.spaces.get(lift.spaceId);
        if (!space) return;
        void query("CanTearOff", {
            windowId: this.host.windowId(),
            spaceId: lift.spaceId,
            profileId: space.state.profileId,
            tabId: lift.item.id,
            draggedTabs: null,
        }).then(
            (permission) => {
                if (permission.allowed) this.host.tearOff(lift.spaceId, lift.item.id);
            },
            (error: unknown) => console.error(error),
        );
    }

    /** Lets the lift go without a drop: it settles back where it was lifted. */
    private cancel(): void {
        const lift = this.lift;
        if (!lift || lift.ending) {
            this.press = null;
            return;
        }
        const generation = this.generation;
        this.finish(rectOf(lift.source), false);
        this.release(generation);
    }

    /**
     * Ends the lift: the preview flies to `landing`, or fades where it leaves
     * the sidebar, and the pointer and the window let go of the sidebar.
     */
    private finish(landing: Rect | null, fades: boolean): void {
        const lift = this.lift;
        if (!lift) return;
        cancelAnimationFrame(this.autoscrollFrame);
        this.host.cards().previewDrop(null);
        this.releaseOverlay?.();
        this.releaseOverlay = null;
        this.suppressUntil = performance.now() + activationSuppression;
        lift.ending = true;
        const preview = this.preview;
        this.preview = null;
        const duration = cssPixels("--crest-dur-drag-preview", 180);
        this.landingUntil = performance.now() + duration;
        if (!preview) return;
        preview.classList.add("landing");
        if (landing && !fades) {
            preview.style.width = `${landing.width}px`;
            preview.style.height = `${landing.height}px`;
            preview.style.transform = `translate(${landing.x}px, ${landing.y}px)`;
        } else {
            preview.classList.add("leaving");
        }
        setTimeout(() => preview.remove(), duration + 40);
    }

    /** Shows the row the drop landed once the preview has reached it. */
    private clearLanding(): void {
        this.landingKey = null;
        for (const node of this.page.querySelectorAll(".drag-landing")) node.classList.remove("drag-landing");
    }

    /** Lets go of the sidebar the lift `generation` held and draws it as the core now has it. */
    private release(generation: number): void {
        const lift = this.lift;
        if (!lift || generation !== this.generation) return;
        this.lift = null;
        this.root.classList.remove("lifting");
        document.body.classList.remove("sidebar-lifting");
        lift.source.classList.remove("drag-source");
        for (const leaf of lift.geometry.leaves) leaf.element.style.transform = "";
        for (const tile of lift.geometry.tiles) {
            tile.element.style.transform = "";
            tile.element.style.width = "";
        }
        for (const marked of this.root.querySelectorAll(".drop-nest, .drop-into, .drop-target")) {
            marked.classList.remove("drop-nest", "drop-into", "drop-target");
        }
        this.host.redraw();
        if (this.landingKey) setTimeout(() => this.clearLanding(), Math.max(0, this.landingUntil - performance.now()));
    }

    // MARK: - Reading

    private shownSpace(): Space | undefined {
        const window = this.host.model.windows.get(this.host.windowId());
        return window ? this.host.model.workspace?.spaces.get(window.shownSpaceId) : undefined;
    }

    /** The tabs a split row stands for, in order. */
    private members(row: Row): Guid[] {
        return (row.element.dataset.members ?? "").split(" ").filter((id) => id.length > 0);
    }
}

function sameTarget(a: Target | null, b: Target | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
        case "insert": {
            const other = b as typeof a;
            return sameSection(a.section, other.section) && a.beforeKey === other.beforeKey && a.index === other.index;
        }
        case "intoFolder":
            return a.folderId === (b as typeof a).folderId;
        case "aroundTab":
            return a.tabId === (b as typeof a).tabId;
        case "space":
            return a.spaceId === (b as typeof a).spaceId;
        case "split":
            return a.index === (b as typeof a).index;
    }
}

/** The pinned grid's columns for `count` pins, as the sidebar lays them out (PinnedTabGridLayout). */
function pinnedColumnsFor(count: number, width: number, spacing: number): number {
    const minimum = cssPixels("--pin-tile-min-width", 36);
    const requested = pinColumnRequest();
    const capacity = Math.max(1, Math.min(requested.columns, Math.floor((width + spacing) / (minimum + spacing))));
    if (!requested.balances) return Math.max(1, Math.min(count, capacity));
    const rows = Math.ceil(count / capacity);
    return Math.ceil(count / rows);
}
