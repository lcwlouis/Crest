// Every Settings page Linux draws, by its destination's name, and the Space
// page's sections other than Appearance.

import type { SettingsPage, SpaceSectionPage } from "./settings.js";
import { aboutPage, advancedPage } from "./settings-about.js";
import { adBlockingPage } from "./settings-adblocking.js";
import { appearancePage } from "./settings-appearance.js";
import { extensionsPage, extensionsSection } from "./settings-extensions.js";
import { generalPage, tabsPage } from "./settings-general.js";
import { linksPage } from "./settings-links.js";
import { passwordsPage, passwordsSection } from "./settings-passwords.js";
import { searchPage } from "./settings-search.js";
import { shortcutsPage } from "./settings-shortcuts.js";
import { browsingSection, privacyPage, privacySection, spacesPage } from "./settings-space.js";

export const settingsPages: Readonly<Record<string, SettingsPage>> = {
    general: generalPage,
    tabs: tabsPage,
    search: searchPage,
    lookAndFeel: appearancePage,
    links: linksPage,
    shortcuts: shortcutsPage,
    spaces: spacesPage,
    privacy: privacyPage,
    adBlocking: adBlockingPage,
    passwords: passwordsPage,
    extensions: extensionsPage,
    advanced: advancedPage,
    about: aboutPage,
};

export const spaceSectionPages: Readonly<Record<"browsing" | "privacy" | "passwords" | "extensions", SpaceSectionPage>> = {
    browsing: browsingSection,
    privacy: privacySection,
    passwords: passwordsSection,
    extensions: extensionsSection,
};
