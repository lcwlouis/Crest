#!/usr/bin/env python3
"""Derive the Linux native host's patches from the Mac host patches.

Crest's Mac host (`native-host.patch`, `content-filter.patch`) gates every hook
it adds to Chromium on `BUILDFLAG(IS_MAC)`. The hooks themselves are portable:
the overlay's binding implements them in C++. Linux takes the same patches,
leaves out the Mac-only files, and widens each gate Crest added to Linux, except
in the files whose gated code calls Mac-only Chromium APIs. Deriving them keeps
Linux in step with every change to the Mac host.
"""

import argparse
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / "CrestEngines/Chromium"
SOURCES = ("native-host.patch", "content-filter.patch")

# Files only the Mac build compiles.
MAC_ONLY = re.compile(r"(_mac\.(cc|h|mm)$|\.mm$|/cocoa/|/mac/|_cocoa\.)")
# Files whose Crest gates hold code that needs Mac-only Chromium APIs or system
# services (the macOS passkey sheet, the system screen-sharing picker, Mac
# feature flags, Chrome's Mac native-messaging folders, a product bundle). They
# keep their Mac gates; Linux gets its own behavior for them later.
#
# TODO(linux): screen sharing keeps Chromium's own picker on Linux, whose
# window and screen choices go through the xdg-desktop-portal ScreenCast
# picker on Wayland. Crest's offer (ShareSourcesOffered, ChooseShareSource)
# needs the display_media_access_handler gate widened and
# ScreenSharingPicker::OpenSystemPicker to start the portal's picker through
# webrtc's PipeWire capturer (its DelegatedSourceListController) on Linux.
KEEP_MAC_GATES = {
    "chrome/app/chrome_main_delegate.cc",
    "chrome/browser/chrome_browser_field_trials.cc",
    "chrome/browser/extensions/api/messaging/launch_context_posix.cc",
    "chrome/browser/media/webrtc/desktop_capture_access_handler.cc",
    "chrome/browser/media/webrtc/desktop_capture_devices_util.cc",
    "chrome/browser/media/webrtc/display_media_access_handler.cc",
    "chrome/browser/ui/views/translate/translate_bubble_controller.cc",
    "chrome/browser/webauthn/authenticator_request_dialog_controller.cc",
    "chrome/browser/webauthn/authenticator_request_dialog_controller.h",
    "chrome/browser/webauthn/chrome_authenticator_request_delegate.cc",
    "chrome/browser/webauthn/chrome_web_authentication_delegate.cc",
}
# The Mac host's Objective-C sources and their Linux counterparts. The Linux
# shell's own sources (its core host, window and WebUI) go beside the host's.
LINUX_SHELL_SOURCES = (
    "ui/crest/crest_contracts.h",
    "ui/crest/crest_core_host_linux.cc",
    "ui/crest/crest_core_host_linux.h",
    "ui/crest/crest_credentials_linux.cc",
    "ui/crest/crest_credentials_linux.h",
    "ui/crest/crest_extensions_linux.cc",
    "ui/crest/crest_extensions_linux.h",
    "ui/crest/crest_linux_ui.h",
    "ui/crest/crest_linux_window.cc",
    "ui/crest/crest_linux_window.h",
    "ui/crest/crest_notifications_linux.cc",
    "ui/crest/crest_notifications_linux.h",
    "ui/crest/crest_password_import_linux.cc",
    "ui/crest/crest_password_import_linux.h",
    "ui/crest/crest_secret_service_linux.cc",
    "ui/crest/crest_secret_service_linux.h",
    "ui/crest/crest_system_webui_linux.cc",
    "ui/crest/crest_system_webui_linux.h",
    "ui/crest/crest_webui_linux.cc",
    "ui/crest/crest_webui_linux.h",
)
PLATFORM_SOURCES = {
    '      "ui/crest/crest_browser_window.mm",\n': '      "ui/crest/crest_browser_window_linux.cc",\n',
    '      "ui/crest/crest_chrome_host.mm",\n': "".join(
        f'      "{name}",\n' for name in ("ui/crest/crest_chrome_host_linux.cc", *LINUX_SHELL_SOURCES)),
}
# What the Linux shell links beyond the Mac host's dependencies: its page
# views, the clipboard a copied password or capture goes on, BoringSSL, which
# decrypts the passwords setup imports, D-Bus, which reaches the desktop's
# notifications, and the printing build flags, which gate a page's print
# preview. libsecret and the system SQLite are loaded at run time, so
# the build needs neither.
LINUX_SHELL_DEPS = ("//ui/views/controls/webview", "//ui/base/clipboard", "//third_party/boringssl",
                    "//components/dbus", "//dbus", "//printing/buildflags")


def sections(text):
    """The patch's leading comment and its per-file sections, in order."""
    parts = re.split(r"(?m)^(?=--- a/)", text)
    return parts[0], [(re.match(r"--- a/(\S+)", part).group(1), part) for part in parts[1:]]


def recount(section, context=3):
    """Rewrites each hunk's header after lines were added, and trims its context
    to `context` lines each side: patch reads a hunk whose leading and trailing
    context differ as anchored to the start or end of the file."""
    hunks = re.split(r"(?m)^(?=@@ )", section)
    out = [hunks[0]]
    for hunk in hunks[1:]:
        header, body = hunk.split("\n", 1)
        lines = body.splitlines(keepends=True)
        changed = [index for index, line in enumerate(lines) if line[:1] in ("+", "-")]
        leading = max(0, changed[0] - context)
        trailing = min(len(lines), changed[-1] + 1 + context)
        lines = lines[leading:trailing]
        old = sum(1 for line in lines if line[:1] in (" ", "-") or line == "\n")
        new = sum(1 for line in lines if line[:1] in (" ", "+") or line == "\n")
        match = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)", header)
        out.append(f"@@ -{int(match.group(1)) + leading},{old} +{int(match.group(2)) + leading},{new} @@{match.group(3)}\n"
                   + "".join(lines))
    return "".join(out)


def split_mac_includes(section):
    """Moves each Crest header the host includes inside one of Chromium's own
    Mac blocks out to a gate of its own, which takes Linux too: the calls the
    host adds are widened to Linux, so their declarations must be."""
    hunks = re.split(r"(?m)^(?=@@ )", section)
    changed = False
    for index, hunk in enumerate(hunks[1:], start=1):
        lines = hunk.splitlines(keepends=True)
        opened = []  # Each open #if in the hunk: whether it is Chromium's own Mac gate.
        out = []
        for line in lines:
            prefix, text = line[:1], line[1:]
            if prefix in (" ", "+", "-") and text.startswith("#if"):
                opened.append(prefix == " " and text.startswith("#if BUILDFLAG(IS_MAC)") and "||" not in text)
            elif prefix in (" ", "+", "-") and text.startswith("#endif") and opened:
                opened.pop()
            elif (prefix == "+" and text.startswith("#include") and '/crest' in text and opened and opened[-1]):
                out += ["+#endif  // BUILDFLAG(IS_MAC)\n", "+#if BUILDFLAG(IS_MAC) || BUILDFLAG(IS_LINUX)\n", line,
                        "+#endif  // BUILDFLAG(IS_MAC) || BUILDFLAG(IS_LINUX)\n", "+#if BUILDFLAG(IS_MAC)\n"]
                changed = True
                continue
            out.append(line)
        hunks[index] = "".join(out)
    section = "".join(hunks)
    return recount(section) if changed else section


def transform_section(name, section, follows_host, split=True):
    if name == "chrome/browser/BUILD.gn":
        # The host's source set builds for Linux from the Linux sources; the
        # Mac hunk that adds it to the browser's Mac dependencies is dropped
        # (crest-host-linux-deps.patch adds it on Linux).
        hunks = re.split(r"(?m)^(?=@@ )", section)
        kept = [hunks[0]] + [hunk for hunk in hunks[1:] if '+      ":crest_host",' not in hunk]
        section = "".join(kept)
        section = section.replace("+if (is_mac) {\n+  # Crest's host", "+if (is_linux) {\n+  # Crest's host")
        # Each replaced line keeps its own prefix: an added line in the host's
        # patch, a context line in a patch applied after it.
        lines = []
        for line in section.splitlines(keepends=True):
            prefix, text = line[:1], line[1:]
            if prefix in ("+", " ") and text in PLATFORM_SOURCES:
                lines += [prefix + entry for entry in PLATFORM_SOURCES[text].splitlines(keepends=True)]
            elif prefix in ("+", " ") and text == '      "//media/mojo/mojom",\n':
                lines += [line] + [f'{prefix}      "{dep}",\n' for dep in LINUX_SHELL_DEPS]
            else:
                lines.append(line)
        section = "".join(lines)
        return recount(section)
    if name in KEEP_MAC_GATES:
        return section
    lines = []
    for line in section.splitlines(keepends=True):
        # A patch applied after the host's sees the host's widened gates in its context.
        changed = line.startswith("+") and not line.startswith("+++")
        if changed or (follows_host and line.startswith(" ")):
            line = line.replace("#if BUILDFLAG(IS_MAC)", "#if BUILDFLAG(IS_MAC) || BUILDFLAG(IS_LINUX)")
            line = line.replace("#endif  // BUILDFLAG(IS_MAC)", "#endif  // BUILDFLAG(IS_MAC) || BUILDFLAG(IS_LINUX)")
        lines.append(line)
    # After widening: a gate the host's earlier patch already widened is no
    # longer Chromium's own Mac block.
    return split_mac_includes("".join(lines)) if split else "".join(lines)


def derive(source, follows_host, split=True):
    """`split=False` gives the first derivation, which left Crest's includes in
    Chromium's own Mac blocks, so a source it was applied to can be updated."""
    header, parts = sections(source)
    kept = [transform_section(name, section, follows_host, split) for name, section in parts
            if not MAC_ONLY.search(name)]
    return header + "".join(kept)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Directory for the derived patches")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for name in SOURCES:
        derived = derive((ENGINE / "Patches" / name).read_text(), follows_host=name != SOURCES[0])
        (args.output / name.replace(".patch", "-linux.patch")).write_text(derived)
        print(args.output / name.replace(".patch", "-linux.patch"))


if __name__ == "__main__":
    sys.exit(main())
