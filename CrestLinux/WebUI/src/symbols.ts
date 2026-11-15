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
    "chevron.right": '<path d="M9 6l6 6-6 6"/>',
    ellipsis:
        '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "folder.badge.gearshape":
        '<path d="M11 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><circle cx="18" cy="17" r="2.5"/><path d="M18 12.5v2M18 19.5v2M13.5 17h2M20.5 17h2"/>',
    "folder.badge.minus":
        '<path d="M12 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v4"/><path d="M15 18h7"/>',
    "folder.badge.plus":
        '<path d="M12 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v4"/><path d="M18.5 14.5v7M15 18h7"/>',
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
    "square.grid.2x2":
        '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    xmark: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    "xmark.circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
};
// The utility lists' symbols: the lists themselves, their filters, a
// download's file kinds, states and row actions.
Object.assign(paths, {
    archivebox: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    "clock.arrow.circlepath": '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
    "arrow.down.circle": '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9"/><path d="M8.5 13l3.5 3.5 3.5-3.5"/>',
    "line.3.horizontal.decrease": '<path d="M4 7h16"/><path d="M7 12h10"/><path d="M10 17h4"/>',
    magnifyingglass: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
    "checkmark.circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    "exclamationmark.triangle": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>',
    "exclamationmark.shield": '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M12 8v5"/><path d="M12 16v.01"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16"/><path d="M8 3v4M16 3v4"/>',
    "calendar.badge.clock": '<path d="M12 20H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M4 10h16"/><path d="M8 3v4M16 3v4"/><circle cx="17.5" cy="17.5" r="4"/><path d="M17.5 15.5v2l1.5 1"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V10"/><path d="M10 3h4"/>',
    "icloud.and.arrow.down": '<path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17.5 18"/><path d="M12 11v9"/><path d="M9 17l3 3 3-3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
    "arrow.up.forward": '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>',
    "arrow.up.forward.square": '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9.5 14.5l5-5"/><path d="M10.5 9.5h4v4"/>',
    "square.and.arrow.up": '<path d="M8 9H6.5A1.5 1.5 0 0 0 5 10.5v8A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 9H16"/><path d="M12 14V3"/><path d="M8.5 6.5L12 3l3.5 3.5"/>',
    "arrow.clockwise": '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    photo: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M20.5 16l-5-5-8 8"/>',
    "doc.richtext": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 17l2.5-3 2 2 1.5-1.5 1.5 2.5"/>',
    "doc.text": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    waveform: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
    film: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>',
    externaldrive: '<rect x="3" y="7" width="18" height="10" rx="2.5"/><path d="M17 12h.01"/>',
    "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90": '<path d="M4.5 12a7.5 7.5 0 0 1 13-5"/><path d="M18 3v4h-4"/><path d="M19.5 12a7.5 7.5 0 0 1-13 5"/><path d="M6 21v-4h4"/><path d="M12 8.5v4"/><path d="M12 15.5v.01"/>',
});
paths["folder.fill"] = paths.folder!;
// SF Symbols' filled variants draw as their outlines here.
for (const name of [
    "archivebox", "arrow.down.circle", "checkmark.circle", "exclamationmark.triangle", "exclamationmark.shield",
    "xmark.circle", "icloud.and.arrow.down", "photo", "doc.richtext", "doc.text", "doc", "film", "externaldrive", "trash",
]) {
    paths[`${name}.fill`] = paths[name]!;
}

/** The SVG of the SF Symbol `name`, drawn in the current colour. */
export function sfSymbol(name: string, size = 16): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}
