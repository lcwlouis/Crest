// Line glyphs for the SF Symbols Crest's menus name, so each item shows the
// icon its Mac counterpart shows. A name with no glyph here draws an empty
// square of the same size, which keeps the titles aligned.

const paths: Record<string, string> = {
    "arrow.left": '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
    "arrow.right": '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    "arrow.triangle.2.circlepath":
        '<path d="M19.5 10A8 8 0 0 0 5 7.5"/><path d="M4 4v4h4"/><path d="M4.5 14A8 8 0 0 0 19 16.5"/><path d="M20 20v-4h-4"/>',
    "arrow.uturn.backward": '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    bookmark: '<path d="M7 3h10v18l-5-4-5 4z"/>',
    checkmark: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    "checkmark.circle.fill":
        '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="symbol-knockout" d="M7.5 12.5l3 3 6-6.5"/>',
    "chevron.right": '<path d="M9 6l6 6-6 6"/>',
    "chevron.up": '<path d="M6 15l6-6 6 6"/>',
    ellipsis:
        '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    "exclamationmark.triangle.fill":
        '<path d="M12 2.5L1.5 21h21z" fill="currentColor" stroke-linejoin="round"/><path class="symbol-knockout" d="M12 9.5v5"/><circle class="symbol-knockout" cx="12" cy="17.6" r="0.4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "folder.badge.gearshape":
        '<path d="M11 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><circle cx="18" cy="17" r="2.5"/><path d="M18 12.5v2M18 19.5v2M13.5 17h2M20.5 17h2"/>',
    "folder.badge.minus":
        '<path d="M12 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v4"/><path d="M15 18h7"/>',
    "folder.badge.plus":
        '<path d="M12 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v4"/><path d="M18.5 14.5v7M15 18h7"/>',
    "info.circle": '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="0.5"/>',
    keyboard:
        '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 15h6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    "lock.open": '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>',
    minus: '<path d="M5 12h14"/>',
    pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
    pin: '<path d="M12 16v6"/><path d="M8 3h8l-1 6 3 4v3H6v-3l3-4z"/>',
    "pin.slash": '<path d="M12 16v6"/><path d="M8 3h8l-1 6 3 4v3H6v-3l3-4z"/><path d="M3 3l18 18"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    "plus.square": '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
    "plus.square.on.square":
        '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/><path d="M14.5 11.5v6M11.5 14.5h6"/>',
    "rectangle.badge.minus":
        '<path d="M14 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/><path d="M16 18h6"/>',
    "rectangle.split.2x1": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
    "rectangle.stack": '<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M5 6h14"/><path d="M7 3h10"/>',
    "rectangle.topthird.inset.filled":
        '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="6" y="7" width="12" height="3" rx="1" fill="currentColor" stroke="none"/>',
    sparkles:
        '<path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
    "textformat.size":
        '<path d="M3 19l5-13 5 13"/><path d="M5 14h6"/><path d="M14 19l3.5-8 3.5 8"/><path d="M15.2 16.5h4.6"/>',
    "square.grid.2x2":
        '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    xmark: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    "xmark.circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
};
paths["folder.fill"] = paths.folder!;

/** The SVG of the SF Symbol `name`, drawn in the current colour. */
export function sfSymbol(name: string, size = 16): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}
