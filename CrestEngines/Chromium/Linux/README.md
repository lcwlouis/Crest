# Chromium for Linux

The Linux engine uses the same Chromium release and source archive as the Mac
engine (`../source.lock.json`). This folder adds what differs on Linux, so it
leaves the Mac engine's inputs and published key unchanged.

`source.lock.json` here names:

- `dependencies`: the toolchains DEPS pins for a Linux x86-64 host that the
  source archive does not carry (Chromium's clang and Rust, libclang, Node and
  the Debian sysroot). Each object is verified against the digest in the
  archive's own DEPS.
- `patches`: the Crest patches from `../Patches` that apply to Linux today, in
  `series` order. `native-host.patch` and `content-filter.patch` hold the Mac
  native host and come to Linux with the Linux host. The two `*-apple-unwind`
  build adjustments are Apple-only.
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

This build is stock Chromium with Crest's privacy changes. Crest's own
interface on Linux comes with the Linux native host.
