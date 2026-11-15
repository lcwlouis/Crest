// The browsers on this computer setup imports from, as the Mac's
// BrowserInstalledImportSource and BrowserInstalledImportSourceDetector find
// them, and the folder access its BrowserImportAccessStore and
// BrowserImportFilePicker hold. The core reads each browser's data
// (FindImportData, ReadImport); this knows where Linux keeps it.
//
// The Mac finds a browser by its app and reads its data only when the person
// asks, since macOS may say Crest looked at another app's data. Linux says
// nothing, and a browser here is known by the data it keeps, so setup reads
// each listed browser's data folder as it opens: a browser shows once the
// core finds a profile in one of the folders it keeps its data in, native,
// Flatpak or Snap. A browser whose folder is there but holds nothing the core
// can read shows too, without data, and reading it asks the person for its
// data folder, as the Mac asks when it cannot read a browser's data. Arc,
// Safari and the other browsers only the Mac runs have no folder here.
//
// TODO(linux): other browsers built on Chromium that setup does not list,
// which the Mac's Scan for more finds below Application Support by app
// (FindChromiumBrowsers), are not looked for under ~/.config yet.

import type { ImportData, ImportProfile } from "../generated/crest_contracts.js";
import { ImportSource } from "../generated/crest_contracts.js";
import { chooseImportFolder, existingFolders, homeFolders, queryAway } from "./bridge.js";

// MARK: - Types

/** The folders a browser keeps its data in, first found first: `~` is the home folder, `$CONFIG` the XDG config folder. */
const dataFolders: Partial<Record<ImportSource, readonly string[]>> = {
    Zen: ["~/.zen", "~/.var/app/app.zen_browser.zen/.zen"],
    Chrome: ["$CONFIG/google-chrome", "~/.var/app/com.google.Chrome/config/google-chrome"],
    Firefox: [
        "~/.mozilla/firefox",
        "$CONFIG/mozilla/firefox",
        "~/.var/app/org.mozilla.firefox/.mozilla/firefox",
        "~/.var/app/org.mozilla.firefox/config/mozilla/firefox",
        "~/snap/firefox/common/.mozilla/firefox",
    ],
    ChromeBeta: ["$CONFIG/google-chrome-beta"],
    ChromeDev: ["$CONFIG/google-chrome-unstable"],
    ChromeCanary: ["$CONFIG/google-chrome-canary"],
    Chromium: ["$CONFIG/chromium", "~/.var/app/org.chromium.Chromium/config/chromium", "~/snap/chromium/common/chromium"],
    Brave: [
        "$CONFIG/BraveSoftware/Brave-Browser",
        "~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
        "~/snap/brave/current/.config/BraveSoftware/Brave-Browser",
    ],
    Edge: ["$CONFIG/microsoft-edge", "~/.var/app/com.microsoft.Edge/config/microsoft-edge"],
    Vivaldi: ["$CONFIG/vivaldi", "~/.var/app/com.vivaldi.Vivaldi/config/vivaldi"],
    Opera: ["$CONFIG/opera", "~/.var/app/com.opera.Opera/config/opera"],
};

/** Where the access the person gave to a browser's data folder is kept, by the source's name (BrowserImportAccessStore). */
const accessKeyPrefix = "browser.import.access.";

let folders: Promise<{ readonly home: string; readonly config: string }> | null = null;

function expanded(template: string, home: { readonly home: string; readonly config: string }): string {
    if (template.startsWith("$CONFIG/")) return `${home.config}/${template.slice("$CONFIG/".length)}`;
    if (template.startsWith("~/")) return `${home.home}/${template.slice(2)}`;
    return template;
}

/** What the core finds `application` keeps in `folder`; nothing when it cannot look. */
async function importData(application: ImportSource, folder: string): Promise<ImportData> {
    try {
        return await queryAway("FindImportData", { source: application, folder });
    } catch (error) {
        console.error(error);
        return { profiles: [], passwordStores: [] };
    }
}

function hasProfiles(data: ImportData): boolean {
    return data.profiles.length > 0;
}

// MARK: - Source

/** A browser setup can import from, and what the core found in its data folder. */
export class InstalledImportSource {
    // MARK: - Variables

    readonly application: ImportSource;
    /** The folder its data is in. */
    readonly folder: string;
    /** What the core found there, or null until setup reads it. */
    readonly detected: ImportData | null;

    // MARK: - Initializers

    constructor(application: ImportSource, folder: string, detected: ImportData | null) {
        this.application = application;
        this.folder = folder;
        this.detected = detected;
    }

    /** The name the browser goes by. */
    get title(): string {
        return ImportSource.facts[this.application].title;
    }

    /** Whether a profile the core found keeps bookmarks or a session. */
    get hasDetectedData(): boolean {
        return this.detected?.profiles.some((profile) => profile.bookmarksPath !== null || profile.sessionPath !== null) ?? false;
    }

    /**
     * Whether setup may read every file the core found, without asking the
     * person for the folder: on Linux, whatever the core found it could list.
     */
    get hasReadableDetectedData(): boolean {
        return this.hasDetectedData;
    }

    // MARK: - Actions - Discovery

    /**
     * Each listed browser that keeps its data on this computer, in the order
     * the core lists them, at the first of its folders where the core finds a
     * profile, else at the first of them that is there, with nothing found.
     */
    static async installed(): Promise<InstalledImportSource[]> {
        folders ??= homeFolders();
        const home = await folders;
        const found = await Promise.all(
            ImportSource.all.map(async (application) => {
                const candidates = (dataFolders[application] ?? []).map((template) => expanded(template, home));
                for (const folder of candidates) {
                    const data = await importData(application, folder);
                    if (hasProfiles(data)) return new InstalledImportSource(application, folder, data);
                }
                const present = candidates.length > 0 ? await existingFolders(candidates).catch(() => []) : [];
                return present[0] === undefined ? null : new InstalledImportSource(application, present[0], null);
            }),
        );
        return found.filter((source): source is InstalledImportSource => source !== null);
    }

    /** Where `application` keeps its data here, for the folder picker to open at. */
    static async defaultFolder(application: ImportSource): Promise<string> {
        folders ??= homeFolders();
        const home = await folders;
        const first = dataFolders[application]?.[0];
        return first ? expanded(first, home) : home.home;
    }

    /** The payload of what the core found in this browser's folder, when it found a profile there. */
    get detectedPayload(): ImportPayload | null {
        return this.detected && hasProfiles(this.detected) ? this.payload(this.detected.profiles) : null;
    }

    /** `profiles` of this browser as the payload the core reads. */
    payload(profiles: readonly ImportProfile[] = this.detected?.profiles ?? []): ImportPayload {
        return { application: this.application, profiles };
    }
}

/** What the core reads of one browser: its profiles' files. */
export interface ImportPayload {
    readonly application: ImportSource;
    readonly profiles: readonly ImportProfile[];
}

// MARK: - Access

/**
 * The data folder the person chose for a browser, kept so the next read goes
 * straight to it (BrowserImportAccessStore). Linux needs no security scope,
 * so the folder's path is all it keeps.
 */
export const ImportAccess = {
    /** The folder the person chose for `application`, when they chose one. */
    folder(application: ImportSource): string | null {
        return localStorage.getItem(accessKeyPrefix + ImportSource.facts[application].name);
    },

    remember(folder: string, application: ImportSource): void {
        localStorage.setItem(accessKeyPrefix + ImportSource.facts[application].name, folder);
    },

    clear(application: ImportSource): void {
        localStorage.removeItem(accessKeyPrefix + ImportSource.facts[application].name);
    },

    /** What `application` keeps in the folder the person chose for it, or null with none chosen. */
    async read(application: ImportSource): Promise<ImportData | null> {
        const folder = this.folder(application);
        return folder === null ? null : importData(application, folder);
    },

    /**
     * Asks the person for `application`'s data folder (BrowserImportFilePicker),
     * opening at `near`, or where the browser keeps it, and answers the folder with what the
     * core finds there, or null when they cancel.
     */
    async choose(application: ImportSource, near?: string): Promise<{ readonly folder: string; readonly data: ImportData } | null> {
        const title = ImportSource.facts[application].title;
        const folder = await chooseImportFolder(
            `Allow Crest to Read ${title}`,
            near ?? (await InstalledImportSource.defaultFolder(application)),
        );
        return folder === null ? null : { folder, data: await importData(application, folder) };
    },
};
