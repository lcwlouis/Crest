// Settings' Advanced and About pages (BrowserAdvancedSettingsPane,
// BrowserAboutSettingsPane): exporting the person's data, which the core
// writes, and the build, its release notes and where to talk about Crest.
//
// Left out on Linux: Setup (onboarding and importing from another browser),
// importing Crest's own browser data, which needs the desktop's open dialog
// to hand the core a file's path, and software updates, which the
// distribution's packages bring.

import { ExportFormat } from "../generated/crest_contracts.js";
import { query } from "./bridge.js";
import { Notices, postNotice } from "./notices.js";
import { aboutInformation } from "./settings.js";
import type { SettingsContext } from "./settings.js";
import { button, element, group, wideRow } from "./settings-form.js";
import { explanation } from "./space-actions.js";
import { sfSymbol } from "./symbols.js";

// MARK: - Advanced

/** Hands the person the file the core wrote, as the Mac's save panel does. */
async function exportDocument(context: SettingsContext, format: ExportFormat): Promise<void> {
    const workspace = context.workspace();
    if (!workspace) return;
    const facts = ExportFormat.facts[format];
    try {
        const document = await query("ExportWorkspace", { workspaceId: workspace.id, format });
        const type = format === "Bookmarks" ? "text/html" : "application/json";
        const url = URL.createObjectURL(new Blob([document.contents as Uint8Array<ArrayBuffer>], { type }));
        const anchor = element("a", "");
        anchor.href = url;
        anchor.download = facts.fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        postNotice({ message: facts.savedMessage.text, symbol: "checkmark.circle.fill", label: null });
    } catch (error) {
        postNotice(Notices.failure(explanation(error)));
    }
}

export function advancedPage(context: SettingsContext): (HTMLElement | null)[] {
    return [
        group(
            "Import and export",
            [
                wideRow(button("Export Browser Data…", () => void exportDocument(context, "BrowserData"))),
                wideRow(button("Export Bookmarks as HTML…", () => void exportDocument(context, "Bookmarks"))),
            ],
            { footer: "Exports never include passwords, cookies, website data or extensions." },
        ),
    ];
}

// MARK: - About

const links: readonly { readonly title: string; readonly address: string }[] = [
    { title: "Share Feedback on r/CrestBrowser", address: "https://www.reddit.com/r/CrestBrowser" },
    { title: "Report an Issue", address: "https://github.com/pauljoda/Crest/issues/new/choose" },
    { title: "View the Roadmap", address: "https://github.com/users/pauljoda/projects/3" },
];

/** Each release note's mark (BrowserAboutReleaseNoteMark). */
const marks: Readonly<Record<string, { readonly symbol: string; readonly color: string }>> = {
    new: { symbol: "sparkles", color: "var(--crest-sky)" },
    improved: { symbol: "arrow.up", color: "var(--crest-butter)" },
    fixed: { symbol: "checkmark", color: "var(--crest-sage)" },
};

let showsWhatsNew = false;

export function aboutPage(context: SettingsContext): (HTMLElement | null)[] {
    const identity = element("div", "settings-row settings-about-identity");
    const mark = element("div", "settings-about-icon");
    mark.innerHTML =
        '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4l24 9v17c0 15-10 26-24 30C18 56 8 45 8 30V13z" fill="var(--crest-coral)"/><path d="M32 16l4 9 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" fill="white" opacity="0.9"/></svg>';
    const names = element("div", "settings-row-label");
    const version = element("span", "settings-about-version", "");
    names.append(element("span", "settings-about-name", "Crest"), version);
    identity.append(mark, names);
    const whatsNew = element("section", "settings-group");
    whatsNew.hidden = true;
    void aboutInformation().then((about) => {
        if (!about) return;
        version.textContent = `Version ${about.version} (${about.build})`;
        if (about.notes.length === 0) return;
        const card = element("div", "settings-card");
        const disclosure = element("button", showsWhatsNew ? "settings-row settings-link settings-whats-new open" : "settings-row settings-link settings-whats-new");
        disclosure.type = "button";
        disclosure.setAttribute("aria-expanded", String(showsWhatsNew));
        disclosure.innerHTML = sfSymbol("chevron.right", 11);
        disclosure.append(element("span", "settings-row-title", `What's New in Crest ${about.version}`));
        disclosure.addEventListener("click", () => {
            showsWhatsNew = !showsWhatsNew;
            context.redraw();
        });
        card.append(disclosure);
        if (showsWhatsNew) {
            const notes = element("div", "settings-release-notes");
            for (const note of about.notes) {
                const entry = element("div", "settings-release-note");
                const glyph = element("span", "settings-release-mark");
                const style = marks[note.category] ?? marks.new!;
                glyph.innerHTML = sfSymbol(style.symbol, 12);
                glyph.style.color = style.color;
                entry.append(glyph, element("span", "", note.message));
                notes.append(entry);
            }
            card.append(notes);
        }
        whatsNew.replaceChildren(card);
        whatsNew.hidden = false;
    });
    const openLink = (address: string): void => {
        const workspace = context.workspace();
        const window = context.model.windows.get(context.windowId());
        if (!workspace || !window) return;
        void context.send({
            kind: "OpenAddress",
            value: { workspaceId: workspace.id, windowId: window.id, spaceId: window.shownSpaceId, tabId: crypto.randomUUID(), address },
        });
    };
    return [
        group(null, [identity]),
        whatsNew,
        group(
            "Community and support",
            links.map((link) => {
                const node = element("button", "settings-row settings-link");
                node.type = "button";
                node.append(element("span", "settings-row-title settings-link-title", link.title), element("span", "settings-spacer"));
                const arrow = element("span", "settings-chevron");
                arrow.innerHTML = sfSymbol("arrow.up.right", 12);
                node.append(arrow);
                node.addEventListener("click", () => openLink(link.address));
                return node;
            }),
            { footer: "Reddit is public. Leave out private details." },
        ),
    ];
}
