// This device's appearance choices, which the Mac keeps in UserDefaults
// (BrowserDeviceAppearanceStore) and never syncs: kept here in localStorage
// under the Mac's own keys and in its own spellings, so the two read alike.
// The ones the Linux window already draws take effect at once; the rest are
// kept for when it draws them.

/** What a Reset reads and does, whatever a choice holds. */
export interface Resettable {
    readonly isDefault: boolean;
    reset(): void;
}

/** One choice, kept under `key`, or under `field` of the JSON object at `key`. */
export class DeviceSetting<T> {
    readonly key: string;
    readonly field: string | null;
    readonly fallback: T;

    constructor(key: string, fallback: T, field: string | null = null) {
        this.key = key;
        this.fallback = fallback;
        this.field = field;
    }

    get value(): T {
        const kept = this.kept();
        return kept === undefined ? this.fallback : kept;
    }

    get isDefault(): boolean {
        return JSON.stringify(this.value) === JSON.stringify(this.fallback);
    }

    set(value: T): void {
        if (this.field) {
            const object = { ...this.object(), [this.field]: value };
            localStorage.setItem(this.key, JSON.stringify(object));
        } else {
            localStorage.setItem(this.key, JSON.stringify(value));
        }
        DeviceAppearance.changed();
    }

    reset(): void {
        if (this.field) {
            const object = this.object();
            delete object[this.field];
            localStorage.setItem(this.key, JSON.stringify(object));
        } else {
            localStorage.removeItem(this.key);
        }
        DeviceAppearance.changed();
    }

    private kept(): T | undefined {
        if (this.field) return this.object()[this.field] as T | undefined;
        try {
            const text = localStorage.getItem(this.key);
            return text === null ? undefined : (JSON.parse(text) as T);
        } catch {
            return undefined;
        }
    }

    private object(): Record<string, unknown> {
        try {
            const value: unknown = JSON.parse(localStorage.getItem(this.key) ?? "{}");
            return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        } catch {
            return {};
        }
    }
}

const tabs = "crest.appearance.tabs";
const address = "crest.appearance.address";

/** The choices, by the Mac's keys and defaults (BrowserLookAndFeelDefaults). */
export const DeviceAppearance = {
    sidebarOnRight: new DeviceSetting("crest.appearance.sidebar-on-right", false),
    mode: new DeviceSetting<"system" | "light" | "dark">("crest.appearance.mode", "system"),
    darkSpaceDimming: new DeviceSetting("crest.appearance.darkSpaceDimming", 0),
    spaceIcons: new DeviceSetting<"icons" | "dots">("crest.appearance.space-icons", "icons"),
    spaceIconScale: new DeviceSetting("crest.appearance.spaceIconScale", 1),
    cornerRadius: new DeviceSetting("crest.appearance.cornerRadius", 10),
    tabScale: new DeviceSetting("crest.appearance.tabScale", 1),
    pinColumns: new DeviceSetting("crest.appearance.pinColumns", 0),
    pinsFillRow: new DeviceSetting("crest.appearance.pinsFillRow", false),
    borders: new DeviceSetting<"selected" | "pinned" | "all">(tabs, "selected", "borders"),
    outlinesSelectedTabs: new DeviceSetting(tabs, false, "outlinesSelectedTabs"),
    usesWebsitePinColor: new DeviceSetting(tabs, true, "usesWebsitePinColor"),
    dimsUnloadedTabs: new DeviceSetting(tabs, true, "dimsUnloadedTabs"),
    pinFill: new DeviceSetting(tabs, 0, "pinFill"),
    pinGlow: new DeviceSetting(tabs, 0, "pinGlow"),
    hoverFill: new DeviceSetting(tabs, 0, "hoverFill"),
    statusStyle: new DeviceSetting<"badge" | "icon">(tabs, "badge", "statusStyle"),
    showsAudioVisualizer: new DeviceSetting(tabs, true, "showsAudioVisualizer"),
    addressFill: new DeviceSetting(address, 0, "fill"),
    addressBorder: new DeviceSetting(address, 0, "border"),
    addressDisplay: new DeviceSetting<"twoLines" | "oneLine" | "siteOnly">(address, "twoLines", "display"),
    usesAccentWhenEditing: new DeviceSetting(address, false, "usesAccentWhenEditing"),
    animatesIntoCommandPalette: new DeviceSetting(address, true, "animatesIntoCommandPalette"),
    showsCopyURLButton: new DeviceSetting(address, false, "showsCopyURLButton"),
    folderIconOnly: new DeviceSetting("crest.folders.iconOnly", false),
    folderTintsTitle: new DeviceSetting("crest.folders.tintsTitle", false),
    folderAlwaysShowsHighlights: new DeviceSetting("crest.folders.alwaysShowHighlights", false),
    folderShowsTabCounts: new DeviceSetting("crest.folders.showsTabCounts", true),
    folderShowsBorders: new DeviceSetting("crest.folders.showsBorders", true),
    tabHoverPreview: new DeviceSetting("crest.appearance.hover-preview.tabs", true),
    folderHoverPreview: new DeviceSetting("crest.appearance.hover-preview.folders", true),
    defaultPageZoom: new DeviceSetting("crest.page-zoom.default", 1),

    listeners: [] as (() => void)[],

    /** Calls `listener` after any choice changes. */
    listen(listener: () => void): void {
        this.listeners.push(listener);
    },

    changed(): void {
        applyDeviceAppearance();
        for (const listener of DeviceAppearance.listeners) listener();
    },

    /** Every choice, for Reset All. */
    all(): Resettable[] {
        return Object.values(DeviceAppearance).filter((value) => value instanceof DeviceSetting) as Resettable[];
    },
};

/** The pinned grid's largest column count (PinnedTabGridLayout), and whether it balances rows. */
export function pinColumnRequest(): { readonly columns: number; readonly balances: boolean } {
    const chosen = Math.round(DeviceAppearance.pinColumns.value);
    if (chosen > 0) return { columns: Math.min(Math.max(chosen, 1), 6), balances: false };
    const automatic = Math.round(4 / (DeviceAppearance.tabScale.value || 1));
    return { columns: Math.min(Math.max(automatic, 1), 6), balances: true };
}

let switcherIconSize: number | null = null;

/** Draws the choices the Linux window already draws. */
export function applyDeviceAppearance(): void {
    const root = document.documentElement;
    const style = root.style;
    document.body.classList.toggle("sidebar-on-right", DeviceAppearance.sidebarOnRight.value);
    document.body.classList.toggle("keeps-unloaded-bright", !DeviceAppearance.dimsUnloadedTabs.value);
    document.body.classList.toggle("space-dots", DeviceAppearance.spaceIcons.value === "dots");
    style.setProperty("--tab-scale", String(DeviceAppearance.tabScale.value));
    // BrowserSidebarLayerShape: the outer layer rounds a little more than
    // the setting, each nested layer 4 points less, never under the setting,
    // and nothing past a capsule.
    const setting = Math.min(Math.max(DeviceAppearance.cornerRadius.value, 0), 40);
    const capsule = 20;
    const outer = Math.min(setting + Math.min(setting, 4), capsule);
    const at = (depth: number): number => Math.max(Math.min(setting, capsule), outer - 4 * depth);
    style.setProperty("--sidebar-row-radius", `${at(0)}px`);
    style.setProperty("--sidebar-row-radius-nested", `${at(1)}px`);
    switcherIconSize ??= parseFloat(getComputedStyle(root).getPropertyValue("--switcher-icon-size")) || 24;
    style.setProperty("--switcher-icon-size", `${Math.round(switcherIconSize * DeviceAppearance.spaceIconScale.value)}px`);
    // The page's view follows its card, which moved to the other side.
    window.dispatchEvent(new Event("resize"));
}
