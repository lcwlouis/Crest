#!/usr/bin/env bash
# Installs Crest's desktop entry and icon for the current user, so the
# desktop lists Crest among its browsers and can hand it links and HTML files.
#
#   CrestLinux/Desktop/install-desktop-entry.sh \
#     --chrome ~/Chromium/crest-src/out/CrestBaseline/chrome \
#     --core-library "$PWD/CrestCore/src/CrestCore.Native/bin/Release/net10.0/linux-x64/native/CrestCore.Native.so" \
#     --ui-dir ~/Chromium/crest-ui \
#     --user-data-dir ~/.config/crest-dev
#
# It writes only under the user's data directory ($XDG_DATA_HOME, or
# ~/.local/share): it never makes Crest the default browser. To do that, see
# "Open links from other apps" in CrestEngines/Chromium/Linux/README.md.
# --uninstall removes what it installed.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
applications="$data_home/applications"
icons="$data_home/icons/hicolor"

usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

chrome="" core_library="" ui_dir="" user_data_dir="" uninstall=0
while [ $# -gt 0 ]; do
    case "$1" in
        --chrome) chrome="$2"; shift 2 ;;
        --core-library) core_library="$2"; shift 2 ;;
        --ui-dir) ui_dir="$2"; shift 2 ;;
        --user-data-dir) user_data_dir="$2"; shift 2 ;;
        --uninstall) uninstall=1; shift ;;
        *) usage ;;
    esac
done

refresh() {
    if command -v update-desktop-database >/dev/null; then update-desktop-database "$applications" || true; fi
    if [ -f "$icons/index.theme" ] && command -v gtk-update-icon-cache >/dev/null; then
        gtk-update-icon-cache --quiet "$icons" || true
    fi
}

if [ "$uninstall" = 1 ]; then
    rm -f "$applications/crest.desktop" "$icons/32x32/apps/crest.png" "$icons/192x192/apps/crest.png" \
        "$icons/512x512/apps/crest.png"
    refresh
    echo "Removed Crest's desktop entry."
    exit 0
fi

[ -n "$chrome" ] && [ -n "$core_library" ] && [ -n "$ui_dir" ] && [ -n "$user_data_dir" ] || usage
for file in "$chrome" "$core_library"; do
    [ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
done
[ -d "$ui_dir" ] || { echo "No such folder: $ui_dir" >&2; exit 1; }

absolute() { (cd "$(dirname "$1")" && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }

# One argument of the entry's Exec line, quoted as the Desktop Entry
# Specification asks, and with % doubled so it is not read as a field code.
quoted() {
    local value="${1//\\/\\\\\\\\}"
    value="${value//\"/\\\\\"}"
    value="${value//\`/\\\\\`}"
    value="${value//\$/\\\\\$}"
    value="${value//%/%%}"
    printf '"%s"' "$value"
}

mkdir -p "$user_data_dir"
exec_line="$(quoted "$(absolute "$chrome")") --ozone-platform=wayland --class=Crest --crest-control-plane"
exec_line+=" $(quoted "--user-data-dir=$(absolute "$user_data_dir")")"
exec_line+=" $(quoted "--crest-core-library=$(absolute "$core_library")")"
exec_line+=" $(quoted "--crest-ui-dir=$(absolute "$ui_dir")")"

mkdir -p "$applications" "$icons/32x32/apps" "$icons/192x192/apps" "$icons/512x512/apps"
# The template's @EXEC@ is replaced literally, whatever the line holds.
EXEC_LINE="$exec_line" awk '{ gsub(/@EXEC@/, "\034"); n = split($0, parts, "\034"); line = parts[1];
    for (i = 2; i <= n; i++) line = line ENVIRON["EXEC_LINE"] parts[i]; print line }' \
    "$here/crest.desktop.in" > "$applications/crest.desktop"
cp "$repo/Website/assets/crest-icon-32.png" "$icons/32x32/apps/crest.png"
cp "$repo/Website/assets/crest-icon-192.png" "$icons/192x192/apps/crest.png"
cp "$repo/Website/assets/crest-icon-512.png" "$icons/512x512/apps/crest.png"
if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$applications/crest.desktop"; fi
refresh
echo "Installed $applications/crest.desktop"
