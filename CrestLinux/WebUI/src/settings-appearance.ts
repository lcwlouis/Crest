// Settings' Appearance page (BrowserLookAndFeelSettingsPane): this device's
// look, which the Mac keeps in UserDefaults and Linux in localStorage under
// the same keys (device-appearance.ts), and Super Copy, which is one of the
// core's link preferences. Each group has its Reset, each changed row its
// own, and Reset All… puts every choice back.
//
// Left out on Linux: the Style group (Heraldic, Modern, Simple), which
// restyles every Space through onboarding's looks; Window border, Material
// and Material color, and the accent row, which need the window's own
// material; the sidebar hover rows, which need a collapsing sidebar; Fit
// Space icons to sidebar; hover previews, which Linux does not host; and the
// app icon.

import { showAlert } from "./alert.js";
import { zoomSteps } from "./commands.js";
import { DeviceAppearance } from "./device-appearance.js";
import type { DeviceSetting, Resettable } from "./device-appearance.js";
import type { SettingsContext } from "./settings.js";
import { button, deviceRow, element, group, picker, resetButton, row, segmented, slider, toggle, wideRow } from "./settings-form.js";
import type { Choice } from "./settings-form.js";

const A = DeviceAppearance;

/** A slider's readout: its ends by name, a percentage between (CrestSettingSlider .percent). */
function percent(zero: string, full: string): (value: number) => string {
    return (value) => (value <= 0 ? zero : value >= 1 ? full : `${Math.round(value * 100)}%`);
}

function switchRow(title: string, setting: DeviceSetting<boolean>): HTMLElement {
    return deviceRow(title, setting, (value, change) => toggle(value, change));
}

function intensityRow(title: string, setting: DeviceSetting<number>, zero: string, full: string): HTMLElement {
    return deviceRow(title, setting, (value, change) => slider(value, { min: 0, max: 1, step: 0.01, readout: percent(zero, full) }, change));
}

function choiceRow<T>(title: string, setting: DeviceSetting<T>, choices: readonly Choice<T>[], segments = false): HTMLElement {
    return deviceRow(title, setting, (value, change) => (segments ? segmented(choices, value, change) : picker(choices, value, change)));
}

/** Named stops along a value, and "Custom" between them (BrowserAppearancePresetPicker). */
function presetRow(title: string, setting: DeviceSetting<number>, presets: readonly (readonly [string, number])[], tolerance: number): HTMLElement {
    return deviceRow(title, setting, (value, change) => {
        const controls = element("div", "settings-inline-controls");
        const matched = presets.find(([, preset]) => Math.abs(preset - value) <= tolerance);
        if (!matched) controls.append(element("span", "settings-row-detail", "Custom"));
        const control = segmented(
            presets.map(([name, preset]) => ({ value: preset, title: name })),
            matched?.[1] ?? Number.NaN,
            change,
        );
        control.setAttribute("aria-label", title);
        controls.append(control);
        return controls;
    });
}

function settingsGroup(title: string, settings: readonly Resettable[], rows: (HTMLElement | null)[], footer?: string): HTMLElement {
    return group(title, rows, { accessory: resetButton(settings), ...(footer ? { footer } : {}) });
}

export function appearancePage(context: SettingsContext): (HTMLElement | null)[] {
    const links = context.preferences.links;
    const pinLayouts: Choice<number>[] = [
        { value: 0, title: "Balanced rows" },
        { value: 1, title: "One per row" },
        ...[2, 3, 4, 5, 6].map((count) => ({ value: count, title: `Up to ${count} per row` })),
    ];
    return [
        settingsGroup("Window", [A.sidebarOnRight, A.mode, A.darkSpaceDimming], [
            switchRow("Sidebar on right", A.sidebarOnRight),
            choiceRow(
                "Appearance",
                A.mode,
                [
                    { value: "system", title: "System" },
                    { value: "light", title: "Light" },
                    { value: "dark", title: "Dark" },
                ],
                true,
            ),
            intensityRow("Dim Space colors in dark", A.darkSpaceDimming, "Off", "Full"),
        ]),
        settingsGroup("Space icons", [A.spaceIcons, A.spaceIconScale], [
            choiceRow(
                "Space icons",
                A.spaceIcons,
                [
                    { value: "icons", title: "Icons" },
                    { value: "dots", title: "Dots" },
                ],
                true,
            ),
            deviceRow("Space icon size", A.spaceIconScale, (value, change) =>
                slider(value, { min: 0.3, max: 1.5, step: 0.05, readout: (scale) => `${Math.round(scale * 100)}%` }, change),
            ),
        ]),
        settingsGroup(
            "Tabs and pins",
            [A.cornerRadius, A.tabScale, A.pinColumns, A.pinsFillRow, A.borders, A.outlinesSelectedTabs, A.usesWebsitePinColor, A.dimsUnloadedTabs, A.pinFill, A.pinGlow, A.hoverFill],
            [
                presetRow("Corner radius", A.cornerRadius, [["Square", 0], ["Soft", 6], ["Round", 10], ["Capsule", 40]], 0.5),
                presetRow("Tab scale", A.tabScale, [["Compact", 0.85], ["Default", 1], ["Comfortable", 1.15]], 0.025),
                choiceRow("Pin layout", A.pinColumns, pinLayouts),
                switchRow("Stretch pins to fill the row", A.pinsFillRow),
                choiceRow("Color borders", A.borders, [
                    { value: "selected", title: "Selected" },
                    { value: "pinned", title: "Pins" },
                    { value: "all", title: "All tabs" },
                ]),
                switchRow("Accent outline on selected tabs", A.outlinesSelectedTabs),
                switchRow("Website colors for pins", A.usesWebsitePinColor),
                switchRow("Dim unloaded tabs", A.dimsUnloadedTabs),
                intensityRow("Pinned fill", A.pinFill, "None", "Strong"),
                intensityRow("Selected tab glow", A.pinGlow, "None", "Strong"),
                intensityRow("Hover tint", A.hoverFill, "Neutral", "Accent"),
            ],
        ),
        settingsGroup("Tab status", [A.statusStyle, A.showsAudioVisualizer], [
            choiceRow(
                "Status",
                A.statusStyle,
                [
                    { value: "badge", title: "Badge" },
                    { value: "icon", title: "Replace Icon" },
                ],
                true,
            ),
            switchRow("Audio visualizer", A.showsAudioVisualizer),
        ]),
        settingsGroup(
            "Address field",
            [A.addressFill, A.addressBorder, A.addressDisplay, A.usesAccentWhenEditing, A.animatesIntoCommandPalette, A.showsCopyURLButton],
            [
                intensityRow("Color fill", A.addressFill, "None", "Strong"),
                intensityRow("Border", A.addressBorder, "None", "Strong"),
                choiceRow("Address", A.addressDisplay, [
                    { value: "twoLines", title: "Two lines" },
                    { value: "oneLine", title: "One line" },
                    { value: "siteOnly", title: "Site only" },
                ]),
                switchRow("Accent outline while editing", A.usesAccentWhenEditing),
                switchRow("Animate into command palette", A.animatesIntoCommandPalette),
                switchRow("Copy URL button", A.showsCopyURLButton),
                links
                    ? row(
                          "Super Copy",
                          toggle(links.cleansCopiedLinks, (isOn) => void context.send({ kind: "SetLinkBehavior", value: { behavior: "CleansCopiedLinks", isOn } })),
                      )
                    : null,
            ],
            "With Super Copy, copying or sharing a link leaves out its trackers, using AdGuard's URL Tracking filter. Copying the selected address keeps everything.",
        ),
        settingsGroup("Folders", [A.folderIconOnly, A.folderTintsTitle, A.folderAlwaysShowsHighlights, A.folderShowsTabCounts, A.folderShowsBorders], [
            switchRow("Icon Only Folders", A.folderIconOnly),
            switchRow("Tint Folder Title", A.folderTintsTitle),
            switchRow("Always show folder highlights", A.folderAlwaysShowsHighlights),
            switchRow("Show folder tab counts", A.folderShowsTabCounts),
            switchRow("Show folder color borders", A.folderShowsBorders),
        ]),
        settingsGroup("Page", [A.defaultPageZoom], [
            choiceRow(
                "Default page zoom",
                A.defaultPageZoom,
                zoomSteps.map((level) => ({ value: level, title: `${Math.round(level * 100)}%` })),
            ),
        ]),
        group(
            null,
            [
                wideRow(
                    button("Reset All…", () =>
                        showAlert({
                            title: "Reset all Look and Feel settings?",
                            message: "Window, tab, address field, folder, and app icon choices return to their defaults.",
                            buttons: [
                                { title: "Reset All", role: "destructive", action: () => A.all().forEach((setting) => setting.reset()) },
                                { title: "Cancel", role: "cancel" },
                            ],
                        }),
                    ),
                ),
            ],
            { footer: "Applies to every Space on this device. Doesn’t sync." },
        ),
    ];
}
