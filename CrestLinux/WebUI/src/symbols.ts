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
    "chevron.down": '<path d="M6 9l6 6 6-6"/>',
    "chevron.left": '<path d="M15 18l-6-6 6-6"/>',
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
    macwindow: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M6 6.25h.01M8.5 6.25h.01"/>',
    "macwindow.badge.plus":
        '<path d="M13 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7"/><path d="M3 8.5h18"/><path d="M6 6.25h.01M8.5 6.25h.01"/><path d="M18.5 14.5v7M15 18h7"/>',
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

// The glyphs a Space's icon, the editor's symbol choices
// (BrowserSpaceSimpleSymbol) and a crest's SF Symbol charges wear. Their
// ".fill" names draw filled, as the Mac's do, so each is one closed shape.
Object.assign(paths, {
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    person: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0z"/>',
    house: '<path d="M4 11l8-7 8 7v9h-5v-6h-6v6H4z"/>',
    graduationcap: '<path d="M2 9.5L12 5l10 4.5-10 4.5z"/><path d="M6 11.5V16c2 2 10 2 12 0v-4.5"/>',
    paintbrush: '<path d="M14.5 3.5l6 6-7 7-6-6z"/><path d="M7.5 10.5C4 11 4 15 3 20c5-1 9-1 9.5-4.5"/>',
    gamecontroller: '<path d="M7 7h10a5 5 0 0 1 4.6 7l-1 2.4a2.4 2.4 0 0 1-4 .5L14.5 15h-5l-2.1 1.9a2.4 2.4 0 0 1-4-.5l-1-2.4A5 5 0 0 1 7 7z"/>',
    airplane: '<path d="M21 15.5v-2l-8-5V4a1.5 1.5 0 0 0-3 0v4.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z"/>',
    "square.grid.2x2.fill": '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    eyeglasses: '<circle cx="6.5" cy="14" r="3.5"/><circle cx="17.5" cy="14" r="3.5"/><path d="M10 14c1-1 3-1 4 0"/><path d="M3 14l2-6M21 14l-2-6"/>',
    "sun.max": '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
    "sun.horizon": '<path d="M6 17a6 6 0 0 1 12 0z"/><path d="M2 17h20M12 4v3M4.9 8.9l1.8 1.8M19.1 8.9l-1.8 1.8"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    star: '<path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    flame: '<path d="M12 22c4 0 7-2.7 7-7 0-4-3-6.5-4-10-2 2-3 4-3 6-1-1-2-2-2.5-3.5C7 10 5 12 5 15c0 4.3 3 7 7 7z"/>',
    drop: '<path d="M12 3c3.5 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.5-6.5 6-11z"/>',
    key: '<circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21v3M18 12v2.5"/>',
    crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z"/>',
    leaf: '<path d="M5 19C5 10 10 5 20 4c0 10-5 15-14 15z"/><path d="M5 19l8-8"/>',
    "mountain.2": '<path d="M2 20l7-12 4 6 3-4 6 10z"/>',
    snowflake: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/><path d="M9.5 3.5L12 6l2.5-2.5M9.5 20.5L12 18l2.5 2.5"/>',
    heart: '<path d="M12 20s-8-4.8-8-10.5A4.5 4.5 0 0 1 12 6.5a4.5 4.5 0 0 1 8 3C20 15.2 12 20 12 20z"/>',
    "face.smiling": '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    shuffle: '<path d="M3 7h4l10 10h4"/><path d="M3 17h4l3-3M14 10l3-3h4"/><path d="M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5"/>',
    paintpalette: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    "arrow.up": '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    "arrow.down": '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    "arrow.counterclockwise": '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4h4"/>',
    "square.on.square": '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    gearshape:
        '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/><circle cx="12" cy="12" r="6.5"/>',
    "hand.raised": '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v7M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13c0 4.5-2.5 8-6.5 8C7 21 5 18 4 15l-1-3a1.5 1.5 0 0 1 2.8-1L8 14"/>',
    "shield.lefthalf.filled": '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M12 3v18c-4.6-1-8-4.5-8-9V6z" fill="currentColor"/>',
    "switch.2": '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    "arrow.up.right": '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
    "chevron.down": '<path d="M6 9l6 6 6-6"/>',
    "square.and.arrow.down": '<path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M8 8H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2"/>',
    "rectangle.portrait.and.arrow.right": '<path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/><path d="M10 12h11"/><path d="M17.5 8.5L21 12l-3.5 3.5"/>',
});
// Setup's glyphs (onboarding).
Object.assign(paths, {
    "chevron.up.chevron.down": '<path d="M8 9l4-4 4 4"/><path d="M8 15l4 4 4-4"/>',
    "minus.circle.fill": '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    "equal.circle.fill": '<circle cx="12" cy="12" r="9"/><path d="M8 10h8M8 14h8"/>',
    "exclamationmark.circle.fill": '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r="0.5"/>',
    "square.stack.3d.up.slash": '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/><path d="M3 3l18 18"/>',
    "checklist.unchecked": '<rect x="3" y="5" width="4" height="4" rx="1"/><rect x="3" y="15" width="4" height="4" rx="1"/><path d="M11 7h10M11 17h10"/>',
    "rectangle.stack.badge.minus": '<rect x="3" y="9" width="14" height="11" rx="2"/><path d="M5 6h12"/><path d="M7 3h8"/><path d="M18 5h4"/>',
    "book.fill": '<path d="M4 5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 1h14"/>',
});
for (const name of [
    "gearshape", "briefcase", "person", "house", "graduationcap", "paintbrush", "gamecontroller", "sun.max", "sun.horizon", "moon", "star",
    "bolt", "flame", "drop", "key", "crown", "leaf", "mountain.2", "heart", "pin", "bookmark", "rectangle.stack",
]) {
    paths[`${name}.fill`] = paths[name]!;
}

// The glyphs Site Controls show: its trigger, a page's connection, the site
// permissions (SitePermission.symbol), a blocked pop-up's status, the
// permission choices and the site data actions.
Object.assign(paths, {
    "slider.horizontal.3":
        '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    "lock.fill": '<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    "lock.open.fill": '<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>',
    "lock.trianglebadge.exclamationmark.fill":
        '<rect x="3" y="11" width="11" height="10" rx="2" fill="currentColor"/><path d="M5.5 11V7.5a3 3 0 0 1 6 0V11"/><path d="M18 11l4.5 9h-9z"/><path d="M18 14.5v2.5M18 18.8v.01"/>',
    "exclamationmark.lock.fill":
        '<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path class="symbol-knockout" d="M12 13.5v3.5M12 19v.01"/>',
    "exclamationmark.octagon.fill":
        '<path d="M8 2.5h8l5.5 5.5v8L16 21.5H8L2.5 16V8z" fill="currentColor"/><path class="symbol-knockout" d="M12 7.5v5.5M12 16.3v.01"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/>',
    "video.and.waveform": '<rect x="2" y="6" width="12" height="12" rx="2"/><path d="M14 10l4-2v8l-4-2"/><path d="M21 9v6"/>',
    location: '<path d="M3 11l18-8-8 18-2-8z"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    "macwindow.on.rectangle": '<rect x="7" y="3" width="14" height="11" rx="2"/><path d="M7 7h14"/><path d="M3 9v10a2 2 0 0 0 2 2h11"/>',
    "macwindow.badge.plus": '<rect x="2" y="4" width="15" height="13" rx="2"/><path d="M2 8h15"/><path d="M19 14v7M15.5 17.5h7"/>',
    "arrow.up.forward.app": '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M10 14l6-6"/><path d="M10 8h6v6"/>',
    "rectangle.inset.filled.and.person.filled":
        '<rect x="2" y="4" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M8 16a4 4 0 0 1 8 0"/>',
    "questionmark.circle": '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17v.01"/>',
    nosign: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    "person.crop.circle.badge.xmark":
        '<path d="M20.5 10.5A9 9 0 1 0 12 21"/><circle cx="12" cy="9.5" r="3"/><path d="M6.5 18a6 6 0 0 1 7-3"/><path d="M16.5 16.5l5 5M21.5 16.5l-5 5"/>',
    "chevron.down": '<path d="M6 9l6 6 6-6"/>',
});

/** The paths of the SF Symbol `name` on a 24-point grid, or none when it has no glyph here. */
export function sfSymbolPaths(name: string): string {
    return paths[name] ?? "";
}

/** The SVG of the SF Symbol `name`, drawn in the current colour. */
export function sfSymbol(name: string, size = 16): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}
