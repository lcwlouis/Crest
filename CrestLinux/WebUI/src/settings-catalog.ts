// Settings' pages, as the Mac's BrowserSettingsDestination lists them: each
// page's name, title, subtitle, the words a search finds it by, its symbol
// and the tincture its sidebar tile wears. Pages Linux does not have yet
// (Engines, Sync, Feature Flags, Agents) are left out.

import type { EngineCapability, PaletteSettingsPage, Tincture } from "../generated/crest_contracts.js";

export interface SettingsDestination {
    readonly name: string;
    readonly title: string;
    /** The shorter title the sidebar shows, where the Mac's row has no room. */
    readonly navigationTitle: string;
    readonly subtitle: string;
    readonly searchTerms: string;
    readonly symbol: string;
    readonly tincture: Tincture;
    /** What an engine must offer for the page to show. */
    readonly requiredCapability: EngineCapability | null;
}

function destination(
    name: string,
    title: string,
    subtitle: string,
    searchTerms: string,
    symbol: string,
    tincture: Tincture,
    navigationTitle = title,
    requiredCapability: EngineCapability | null = null,
): SettingsDestination {
    return { name, title, navigationTitle, subtitle, searchTerms, symbol, tincture, requiredCapability };
}

export const SettingsDestination = {
    general: destination(
        "general",
        "General",
        "Browsing and startup",
        "browser startup default Space typing spelling spell check text editing Picture in Picture video developer toolbar localhost local pages translation system permissions access camera microphone location notifications passkeys files folders downloads allow blocked repair new tab floating sidebar",
        "gearshape",
        "VigilAsh",
    ),
    tabs: destination(
        "tabs",
        "Tabs",
        "New, pinned and saved tabs",
        "focus switch new tabs follow move between Spaces Command-click middle-click Shift pinned saved close resume restore root URL favicon Split View focus follows mouse pointer sidebar widgets Now Playing media cards",
        "square.on.square",
        "RiverAzure",
    ),
    search: destination(
        "search",
        "Search",
        "Search engine, command palette and site searches",
        "search engine Google suggestions command palette address bar results order top hit blended sections complete addresses inline autocomplete learn choices clear site searches shortcuts Tab YouTube Wikipedia scopes calculator paste and go reasons",
        "magnifyingglass",
        "SunTenne",
    ),
    lookAndFeel: destination(
        "lookAndFeel",
        "Appearance",
        "Window, tabs, zoom and motion",
        "look and feel theme accent color transparency page zoom percentage sidebar left right borderless window fullscreen layout interface animation motion page cards folder highlights counts borders preview density spacing padding scale icons space size fit automatic",
        "paintpalette",
        "LionGules",
    ),
    links: destination("links", "Links", "Quick Window and Peek", "external apps Quick Window Peek pinned saved routing open", "link", "MeadowVert"),
    shortcuts: destination(
        "shortcuts",
        "Shortcuts",
        "Keyboard commands",
        "keyboard keys commands rebind remap Arc hotkeys navigation tabs Spaces page",
        "keyboard",
        "LionOr",
    ),
    spaces: destination(
        "spaces",
        "Spaces",
        "Profiles and appearance",
        "profile name identity icon color appearance theme search cleanup isolation reorder browsing archive independence folder intensity text color light dark automatic preview",
        "square.grid.2x2",
        "StormOr",
    ),
    privacy: destination(
        "privacy",
        "Privacy & Permissions",
        "Site access and data",
        "camera microphone site access history cookies data website cache clear browsing",
        "hand.raised",
        "DragonFire",
        "Privacy",
    ),
    adBlocking: destination(
        "adBlocking",
        "Ad Blocking",
        "Filter lists, your rules and sites",
        "ads trackers content blocking filter lists subscribe EasyList uBlock AdGuard my filters custom rules block element cookie notices strict balanced",
        "shield.lefthalf.filled",
        "RiverGules",
        "Ad Blocking",
        "ContentBlocking",
    ),
    passwords: destination(
        "passwords",
        "Passwords",
        "Credentials and autofill",
        "credentials autofill iCloud Keychain passkeys synchronization",
        "key",
        "IronPatina",
    ),
    extensions: destination(
        "extensions",
        "Extensions",
        "Space extensions and permissions",
        "extensions permissions Chromium Chrome Web Store install copies Spaces",
        "puzzlepiece.extension",
        "MeadowMoss",
        "Extensions",
        "Extensions",
    ),
    advanced: destination("advanced", "Advanced", "Import, export, and runtime", "import export backup portability data records", "switch.2", "StormGunmetal"),
    about: destination(
        "about",
        "About",
        "Version, updates, and support",
        "version build updates changelog what's new feedback Reddit GitHub issues roadmap support community",
        "info.circle",
        "SunDune",
    ),
};

/** The sidebar's first group, above the Spaces. */
export const primaryDestinations: readonly SettingsDestination[] = [
    SettingsDestination.general,
    SettingsDestination.tabs,
    SettingsDestination.search,
    SettingsDestination.lookAndFeel,
    SettingsDestination.links,
    SettingsDestination.shortcuts,
    SettingsDestination.privacy,
    SettingsDestination.adBlocking,
    SettingsDestination.passwords,
    SettingsDestination.extensions,
];

/** The sidebar's last group, below the Spaces. */
export const secondaryDestinations: readonly SettingsDestination[] = [SettingsDestination.advanced, SettingsDestination.about];

export const allDestinations: readonly SettingsDestination[] = [
    ...primaryDestinations,
    SettingsDestination.spaces,
    ...secondaryDestinations,
];

export function destinationNamed(name: string): SettingsDestination | undefined {
    return allDestinations.find((candidate) => candidate.name === name);
}

/** Whether `query` finds `destination`, by its title, subtitle or search words. */
export function destinationMatches(destination: SettingsDestination, query: string): boolean {
    const haystack = `${destination.title} ${destination.navigationTitle} ${destination.subtitle} ${destination.searchTerms}`.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .every((word) => haystack.includes(word));
}

/** The pages the command bar offers, as the Mac's palettePages. */
export const paletteSettingsPages: readonly PaletteSettingsPage[] = allDestinations.map((page) => ({
    name: page.name,
    title: page.title,
    terms: `${page.subtitle} ${page.searchTerms}`,
}));
