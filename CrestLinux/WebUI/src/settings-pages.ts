// Every Settings page Linux draws, by its destination's name, and the Space
// page's sections other than Appearance.

import type { SettingsPage, SpaceSectionPage } from "./settings.js";
import { generalPage, tabsPage } from "./settings-general.js";
import { linksPage } from "./settings-links.js";
import { searchPage } from "./settings-search.js";
import { browsingSection, privacyPage, privacySection, spacesPage } from "./settings-space.js";

export const settingsPages: Readonly<Record<string, SettingsPage>> = {
    general: generalPage,
    tabs: tabsPage,
    search: searchPage,
    links: linksPage,
    spaces: spacesPage,
    privacy: privacyPage,
};

export const spaceSectionPages: Readonly<Record<"browsing" | "privacy", SpaceSectionPage>> = {
    browsing: browsingSection,
    privacy: privacySection,
};
