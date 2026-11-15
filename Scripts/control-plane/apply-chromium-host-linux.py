#!/usr/bin/env python3
"""Install Crest's native host into a Chromium source prepared for Linux.

prepare-chromium-linux.py calls this for a new source; run it by hand to bring
an existing one up to date. It applies the Linux host patches that
linux_host_patches.py derives from the Mac host's, then copies the overlay
and the C headers the host compiles against. A patch already applied is left
alone, so running it again is safe. Regenerate GN and build afterwards.
"""

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import linux_host_patches  # noqa: E402

REPO = HERE.parents[1]
ENGINE = REPO / "CrestEngines/Chromium"
# The C headers the host compiles against: the engine contract, the app
# contract's tags and fingerprint (the Linux host creates the core itself),
# the content filter's interface and the Mac host's protocols, which the
# shared sources name.
HEADERS = [REPO / "CrestContracts/include" / name
           for name in ("crest_core.h", "crest_app.h", "crest_engine.h", "crest_engine_contract.h",
                        "crest_contracts.h")]
HEADERS += [REPO / "CrestCore/native/ContentFilter/include/crest_content_filter.h",
            ENGINE / "Apple/CrestChromiumHost.h"]
# Linux-only host patches, each applied on its own once the host's are in, so
# a source that already has the host takes a new one without a new prepare.
LINUX_HOST_PATCHES = [ENGINE / "Linux/Patches/feature-overrides.patch"]


def dry_run(patch, source, *flags):
    return subprocess.run(["patch", "--batch", "--fuzz=0", "--dry-run", "-p1", "-s", *flags, "--input", patch],
                          cwd=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def installed(patches, source, scratch):
    """Whether every patch is in `source`: they reverse, last first, in a copy."""
    names = {line.split()[1].removeprefix("a/") for patch in patches
             for line in patch.read_text().splitlines() if line.startswith("--- a/")}
    for name in names:
        if not (source / name).is_file():
            return False
        (scratch / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, scratch / name)
    # --forward makes a patch that is not applied fail to reverse; with --batch
    # alone, patch would apply it forward instead and still succeed.
    return all(subprocess.run(["patch", "--batch", "--fuzz=0", "--reverse", "--forward", "-p1", "-s", "--input", patch],
                              cwd=scratch, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
               for patch in reversed(patches))


def derive(directory, split):
    """The host patches for Linux, in the order they apply."""
    directory.mkdir(parents=True, exist_ok=True)
    for name in linux_host_patches.SOURCES:
        text = linux_host_patches.derive((ENGINE / "Patches" / name).read_text(),
                                         follows_host=name != linux_host_patches.SOURCES[0], split=split)
        (directory / name.replace(".patch", "-linux.patch")).write_text(text)
    # On a source the privacy patches already changed, these give the same
    # result as the Mac order, where the host's patch comes first.
    return [directory / "native-host-linux.patch", directory / "content-filter-linux.patch",
            ENGINE / "Linux/Patches/crest-host-linux-deps.patch"]


def run(patches, source, *flags):
    for patch in patches:
        print(f"{'Reversing' if '--reverse' in flags else 'Applying'} {patch.name}", flush=True)
        subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-s", *flags, "--input", patch],
                       cwd=source, check=True)


def install(source):
    with tempfile.TemporaryDirectory(prefix="crest-linux-host-") as temporary:
        derived = Path(temporary)
        patches = derive(derived / "current", split=True)
        # The first derivation left Crest's includes inside Chromium's own Mac
        # include blocks; a source that has it is moved to the current one.
        legacy = derive(derived / "legacy", split=False)
        if dry_run(patches[0], source, "--forward"):
            run(patches, source, "--forward")
        elif installed(patches, source, derived / "check"):
            print("The host patches are already applied.")
        elif installed(legacy, source, derived / "check-legacy"):
            run(reversed(legacy), source, "--reverse")
            run(patches, source, "--forward")
        else:
            sys.exit("The host patches neither apply nor are applied; review the Chromium source")
    for patch in LINUX_HOST_PATCHES:
        if dry_run(patch, source, "--reverse", "--forward"):
            print(f"{patch.name} is already applied.")
        else:
            run([patch], source, "--forward")
    for path in (ENGINE / "Overlay").rglob("*"):
        if path.is_file():
            destination = source / path.relative_to(ENGINE / "Overlay")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.is_file() or destination.read_bytes() != path.read_bytes():
                shutil.copy(path, destination)
    for header in HEADERS:
        destination = source / "chrome/browser/ui/crest" / header.name
        if not destination.is_file() or destination.read_bytes() != header.read_bytes():
            shutil.copy(header, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="The prepared Chromium source")
    args = parser.parse_args()
    source = args.source.resolve()
    if source == REPO or REPO in source.parents:
        parser.error("Use the external Chromium source")
    if not (source / "chrome/browser/BUILD.gn").is_file():
        parser.error(f"{source} is not a Chromium source")
    install(source)
    print("Installed Crest's Linux host. Regenerate GN and build.")


if __name__ == "__main__":
    main()
