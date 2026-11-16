# Chromium for Linux

The Linux engine uses the same Chromium release and source archive as the Mac
engine (`../source.lock.json`). This folder adds what differs on Linux, so it
leaves the Mac engine's inputs and published key unchanged.

`source.lock.json` here names:

- `dependencies`: the toolchains DEPS pins for a Linux x86-64 host that the
  source archive does not carry (Chromium's clang and Rust, libclang, Node and
  the Debian sysroot). Each object is verified against the digest in the
  archive's own DEPS.
- `cipd`: host tools DEPS names only by CIPD version tag, pinned by package
  digest: the Go toolchain Dawn uses to generate Tint's sources.
- `patches`: the Crest privacy patches from `../Patches`, in `series` order.
  The host's own patches, `native-host.patch` and `content-filter.patch`, are
  not listed: `Scripts/control-plane/linux_host_patches.py` derives their
  Linux versions from them, so Linux follows every change to the Mac host. The
  two `*-apple-unwind` build adjustments are Apple-only.
- `linuxPatches`: Linux-only patches in `Patches/` here, applied after
  them. `service-discovery-sniffer.patch` keeps a Linux-only debugging tool
  that requires service discovery out of a build that turns it off.
- `overlay`: the overlay sources those patches compile.
- `buildArguments`: Linux GN arguments, added to the shared ones in
  `../source.lock.json`.

## Build on Fedora

The build needs an x86-64 machine with about 100 GB free. On Fedora:

```sh
sudo dnf install python3 ninja-build patch xz
python3 Scripts/control-plane/prepare-chromium-linux.py \
  --source ~/Chromium/crest-src --downloads ~/Chromium/downloads
python3 Scripts/control-plane/build-chromium-baseline.py \
  --source ~/Chromium/crest-src --jobs 16 --min-free-gib 20
~/Chromium/crest-src/out/CrestBaseline/chrome --ozone-platform=wayland
```

Without switches this is stock Chromium with Crest's privacy changes.

## Crest's host and window

`prepare-chromium-linux.py` installs Crest's native host with
`apply-chromium-host-linux.py`, which also brings a source prepared earlier up
to date (it skips a host already installed):

```sh
python3 Scripts/control-plane/apply-chromium-host-linux.py --source ~/Chromium/crest-src
cd ~/Chromium/crest-src && buildtools/linux64/gn gen out/CrestBaseline
```

The host is the Mac's, with Linux sources for what the Mac does in AppKit:
`crest_chrome_host_linux.cc` (the hooks), `crest_browser_window_linux.cc`,
`crest_core_host_linux.cc` (the browser process loads and creates the core,
which Crest's Swift UI does on the Mac), `crest_linux_window.cc` (a window with
Crest's sidebar beside the page) and `crest_webui_linux.cc` (`chrome://crest`,
the sidebar, which reaches the core through the browser process in the core's
wire format). Patches here that only Linux needs, such as
`feature-overrides.patch` (the Chromium features Crest turns off, as the Mac
host does, and the PDF viewer's Save to Google Drive), apply after the host's,
each on its own. The sidebar is `CrestLinux/WebUI`, built with Node 22.13 or
later:

```sh
node CrestLinux/WebUI/build.mjs ~/Chromium/crest-ui
~/Chromium/crest-src/out/CrestBaseline/chrome --ozone-platform=wayland \
  --crest-control-plane --user-data-dir=$HOME/.config/crest-dev \
  --crest-core-library=$PWD/CrestCore/src/CrestCore.Native/bin/Release/net10.0/linux-x64/native/CrestCore.Native.so \
  --crest-ui-dir=$HOME/Chromium/crest-ui
```

Crest keeps its session in `Crest/` inside the user data directory.
