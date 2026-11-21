// Small pictures of the tabs this window's pages showed, which a tab's
// preview card draws, as the Mac's BrowserTabPictures. They are kept in memory
// only and never written anywhere.
//
// A tab is pictured once it has shown on screen for a moment, again once it
// has shown another page or its page has finished loading, and never more
// often than `minimumGap`, while its page still draws. Its picture keeps the
// top of the page, as much as a card draws, and stays when the tab goes to
// sleep, so its card shows how it last looked, until the tab closes or more
// recently pictured tabs take its place. Nothing is pictured while nothing
// the window has draws pictures (the tab previews turned off in Appearance),
// and once nothing does, every picture goes.
//
// TODO(linux): the Mac pictures no tab of a locked Space; Linux pictures them
// all until it locks Spaces.

import type { Guid } from "../generated/crest_contracts.js";

// MARK: - Types

/** One tab's picture, compressed, with its proportions. */
export interface TabPicture {
    /** The picture as a JPEG data: address, ready to draw. */
    readonly src: string;
    /** Height over width. */
    readonly aspectRatio: number;
    readonly takenAt: number;
}

/** What the pictures read of the window. */
export interface TabPicturesContext {
    /** Whether something the window has draws pictures. */
    readonly wanted: () => boolean;
    /** The tabs the window shows as cards now. */
    readonly shownCards: () => readonly Guid[];
    /** The page the window shows for `tabId`, on screen now, with its address and whether it loads. */
    readonly shownPage: (tabId: Guid) => { readonly id: Guid; readonly url: string | null; readonly isLoading: boolean } | undefined;
    /** Every tab that is open, whose pictures are kept. */
    readonly openTabs: () => ReadonlySet<Guid>;
    /** Captures the page `pageId`, `width` points wide, as a PNG. */
    readonly capture: (pageId: Guid, width: number) => Promise<Uint8Array | null>;
    /** A picture was kept or let go. */
    readonly changed: () => void;
}

/** The width each picture is taken at, in points. */
const pictureWidth = 320;
/** Pictures of one tab are never taken closer together than this. */
const minimumGap = 10_000;
/** Pictures of one tab at one address are never taken closer together than this unless its page finished loading since. */
const minimumInterval = 30_000;
/** The tallest a picture is kept, as height over width. */
const tallestAspectRatio = 0.75;
/** How long a tab shows before it is pictured. */
const settleDelay = 1500;
/** How many tabs keep a picture. The least recently pictured go first. */
const capacity = 100;
/** How much each picture is compressed, from 0 (most) to 1 (least). */
const quality = 0.7;

export class TabPictures {
    private readonly context: TabPicturesContext;
    private readonly pictures = new Map<Guid, TabPicture>();
    /** When each tab was last pictured, and at which address. */
    private readonly lastCaptures = new Map<Guid, { readonly at: number; readonly url: string | null }>();
    private settling = 0;
    /** What the window showed when last followed, so a change pictures again. */
    private shownKey = "";
    private wasLoading = false;
    private wasWanted = false;

    constructor(context: TabPicturesContext) {
        this.context = context;
    }

    /** The picture of `tabId`, if one was kept. */
    picture(tabId: Guid): TabPicture | undefined {
        return this.pictures.get(tabId);
    }

    // MARK: - Actions - Following

    /**
     * Follows the window: pictures the tabs it shows once they have shown for
     * a moment, each time it shows others or one of them goes to another
     * page, and again once their pages finish loading.
     */
    follow(): void {
        const wanted = this.context.wanted();
        if (wanted !== this.wasWanted) {
            this.wasWanted = wanted;
            if (!wanted) this.removeAll();
        }
        if (!wanted) return;
        const shown = this.context.shownCards().map((tabId) => ({ tabId, page: this.context.shownPage(tabId) }));
        const key = JSON.stringify(shown.map(({ tabId, page }) => [tabId, page?.id ?? null, page?.url ?? null]));
        const loading = shown.some(({ page }) => page?.isLoading === true);
        const finished = this.wasLoading && !loading;
        this.wasLoading = loading;
        if (key !== this.shownKey) {
            this.shownKey = key;
            this.settle(settleDelay, false);
        } else if (finished) {
            this.settle(settleDelay, true);
        }
        this.prune();
    }

    /** Pictures what the window shows after `delay`, unless it shows something else by then. */
    private settle(delay: number, refreshing: boolean): void {
        window.clearTimeout(this.settling);
        this.settling = window.setTimeout(() => this.capture(this.context.shownCards(), refreshing), delay);
    }

    // MARK: - Actions - Capturing

    /**
     * Pictures `tabIds` whose pages the window shows. A tab pictured at the
     * same address moments ago is skipped unless `refreshing`, and a change
     * within `minimumGap` of its last picture waits until the gap passes.
     */
    private capture(tabIds: readonly Guid[], refreshing: boolean): void {
        if (!this.context.wanted()) return;
        const now = Date.now();
        let wait: number | null = null;
        for (const tabId of tabIds) {
            const page = this.context.shownPage(tabId);
            if (!page) continue;
            const last = this.lastCaptures.get(tabId);
            if (last) {
                const elapsed = now - last.at;
                if (elapsed < minimumGap) {
                    if (refreshing || last.url !== page.url) wait = Math.min(wait ?? Infinity, minimumGap - elapsed);
                    continue;
                }
                if (!refreshing && last.url === page.url && elapsed < minimumInterval) continue;
            }
            this.lastCaptures.set(tabId, { at: now, url: page.url });
            void this.context
                .capture(page.id, pictureWidth)
                .then((png) => (png ? compressed(png, now) : null))
                .then((picture) => {
                    if (!picture || !this.context.wanted()) return;
                    this.pictures.set(tabId, picture);
                    this.prune();
                    this.context.changed();
                })
                .catch(() => undefined);
        }
        if (wait !== null) this.settle(wait, refreshing);
    }

    // MARK: - Actions - Keeping

    /** Lets go of the pictures of tabs that closed, and of the least recently pictured past `capacity`. */
    private prune(): void {
        const open = this.context.openTabs();
        let kept = [...this.pictures].filter(([tabId]) => open.has(tabId));
        if (kept.length > capacity) kept = kept.sort((a, b) => b[1].takenAt - a[1].takenAt).slice(0, capacity);
        if (kept.length === this.pictures.size) return;
        const keep = new Set(kept.map(([tabId]) => tabId));
        for (const tabId of [...this.pictures.keys()]) if (!keep.has(tabId)) this.pictures.delete(tabId);
        for (const tabId of [...this.lastCaptures.keys()]) if (!keep.has(tabId)) this.lastCaptures.delete(tabId);
        this.context.changed();
    }

    /** Lets go of every picture, as when nothing draws them. */
    private removeAll(): void {
        window.clearTimeout(this.settling);
        this.shownKey = "";
        if (this.pictures.size === 0 && this.lastCaptures.size === 0) return;
        this.pictures.clear();
        this.lastCaptures.clear();
        this.context.changed();
    }
}

/** `png` as a compressed picture of its top, no taller than a card draws. */
async function compressed(png: Uint8Array, takenAt: number): Promise<TabPicture | null> {
    const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
    if (bitmap.width === 0) return null;
    const height = Math.min(bitmap.height, Math.round(bitmap.width * tallestAspectRatio));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { src: canvas.toDataURL("image/jpeg", quality), aspectRatio: height / canvas.width, takenAt };
}
