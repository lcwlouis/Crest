// The person's app-level preferences as the core publishes them: the
// workspace's behavior preferences, the search catalog, the link
// preferences, the shortcuts and the content blocking lists. The core keeps
// each in its session or its device store and applies every rule; this only
// follows what it says, as the Mac's CoreState does, and asks the core to
// publish them at launch, as the Mac's launch does before a window opens.

import { AppPreferences } from "../generated/crest_contracts.js";
import type {
    Change,
    EngineCapability,
    FilterLists,
    Guid,
    LinkPreferences,
    SearchCatalogChanged,
    ShortcutsChanged,
    SiteContentBlocking,
    SitePermissionRecordState,
} from "../generated/crest_contracts.js";
import { dispatch, query } from "./bridge.js";

export class Preferences {
    /** The workspace's behavior preferences; the core's defaults until it keeps some. */
    app: AppPreferences = AppPreferences.default;
    defaultSpaceId: Guid | null = null;
    search: SearchCatalogChanged | null = null;
    links: LinkPreferences | null = null;
    shortcuts: ShortcutsChanged | null = null;
    filterLists: FilterLists | null = null;
    blockingOff: readonly SiteContentBlocking[] = [];
    readonly sitePermissions = new Map<Guid, readonly SitePermissionRecordState[]>();
    /** What the registered engines offer, or null before any registers. */
    private offered: readonly EngineCapability[] | null = null;
    private readonly listeners: (() => void)[] = [];

    /**
     * Whether the device offers `capability` where a person can find it: an
     * engine supports it, or no engine has registered yet (CoreState.offers).
     */
    offers(capability: EngineCapability): boolean {
        return this.offered?.includes(capability) ?? true;
    }

    /** Calls `listener` after each batch that changed a preference. */
    listen(listener: () => void): void {
        this.listeners.push(listener);
    }

    apply(changes: readonly Change[]): void {
        let changed = false;
        for (const change of changes) {
            switch (change.kind) {
                case "WorkspaceOpened":
                    this.app = change.value.session.appPreferences ?? AppPreferences.default;
                    this.defaultSpaceId = change.value.session.defaultSpaceId;
                    break;
                case "WorkspaceChanged":
                    this.defaultSpaceId = change.value.defaultSpaceId;
                    break;
                case "AppPreferencesChanged":
                    this.app = change.value.preferences ?? AppPreferences.default;
                    break;
                case "SearchCatalogChanged":
                    this.search = change.value;
                    break;
                case "LinkPreferencesChanged":
                    this.links = change.value.preferences;
                    break;
                case "ShortcutsChanged":
                    this.shortcuts = change.value;
                    break;
                case "FilterListsChanged":
                    this.filterLists = change.value.lists;
                    break;
                case "SiteContentBlockingChanged":
                    this.blockingOff = change.value.sites;
                    break;
                case "EnginesChanged":
                    this.offered = change.value.roster.offered;
                    break;
                case "SitePermissionsChanged":
                    this.sitePermissions.set(change.value.spaceId, change.value.records);
                    break;
                default:
                    continue;
            }
            changed = true;
        }
        if (changed) for (const listener of this.listeners) listener();
    }

    /**
     * Has the core publish what its device store keeps, as the Mac's launch
     * does: the search catalog for this locale, the shortcuts, the link
     * preferences and the site permissions, then reads the content blocking
     * lists, which the core answers rather than publishes at launch.
     */
    async adopt(report: (error: unknown) => void): Promise<void> {
        const locale = new Intl.Locale(navigator.language || "en-US");
        const steps: Promise<unknown>[] = [
            dispatch({ kind: "RestoreSearchCatalog", value: { language: locale.language, region: locale.region ?? null } }),
            dispatch({ kind: "AdoptShortcuts", value: { overrides: null } }),
            dispatch({ kind: "AdoptLinkPreferences", value: { preferences: null } }),
            dispatch({ kind: "AdoptSitePermissions", value: { records: null } }),
            this.refreshBlocking(),
        ];
        for (const result of await Promise.allSettled(steps)) if (result.status === "rejected") report(result.reason);
    }

    /** Reads the content blocking lists and the sites with blocking off again. */
    async refreshBlocking(): Promise<void> {
        const [lists, sites] = await Promise.all([query("GetFilterLists", {}), query("GetSiteContentBlocking", {})]);
        this.filterLists = lists;
        this.blockingOff = sites;
        for (const listener of this.listeners) listener();
    }
}
