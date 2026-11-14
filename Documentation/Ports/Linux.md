# Crest on Linux

This fork is porting Crest to Linux (Fedora first) and then Windows. The
browser core, `CrestCore`, is shared unchanged with the Mac app, so Spaces,
tabs, folders, splits, menus, prompts and launch behave the same everywhere.
The Linux interface is drawn inside Chromium and mirrors the Mac interface.

## Build the core

Requirements on Fedora:

```sh
sudo dnf install clang sqlite-devel python3 rustup
rustup-init -y
Scripts/control-plane/install-dotnet.sh   # or the .NET SDK pinned by CrestCore/global.json
```

Run the core's tests:

```sh
cd CrestCore
dotnet test tests/CrestCore.Tests
```

Publish the native core library, `CrestCore.Native.so`:

```sh
cd CrestCore
dotnet publish src/CrestCore.Native -c Release -r linux-x64 -o artifacts/linux-x64
```

Linux and Windows have no published content filter, so publishing compiles
`CrestCore/native/ContentFilter` with Cargo for the machine it runs on and
links it into the library. Build on the operating system you are targeting.

## Build Chromium

`CrestEngines/Chromium/Linux/README.md` prepares and builds the pinned Chromium
for Linux with Crest's privacy patches.
