#!/usr/bin/env python3
"""Prepare the pinned Chromium source for a Linux x86-64 build with Crest's Linux patches.

Uses the Chromium release and archive that CrestEngines/Chromium/source.lock.json pins
and what CrestEngines/Chromium/Linux/source.lock.json adds for Linux.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import sys
import tarfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("prepare_chromium", HERE / "prepare-chromium.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
# A tarball build on a Linux x86-64 host: what gclient sets for that checkout.
shared.DEPS_VARIABLES = {"host_os": "linux", "host_cpu": "x64", "checkout_linux": True, "checkout_x64": True,
                         "non_git_source": True}

ENGINE = shared.ENGINE
LINUX = ENGINE / "Linux"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="New directory for the expanded source")
    parser.add_argument("--downloads", required=True, type=Path, help="Shared download cache")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        parser.error("The Linux engine builds on an x86-64 Linux host")
    source = args.source.resolve()
    if source == shared.REPO or shared.REPO in source.parents:
        parser.error("The Chromium source must be outside Crest")
    if source.exists():
        parser.error("Source directory already exists; use a new directory")
    lock = json.loads((ENGINE / "source.lock.json").read_text())
    linux = json.loads((LINUX / "source.lock.json").read_text())
    downloads = args.downloads.resolve()

    chromium = lock["chromium"]
    archive = shared.fetch(chromium["sourceArchive"], downloads / Path(chromium["sourceArchive"]).name,
                           chromium["sourceArchiveSha256"])
    staging = source.with_name(source.name + ".partial")
    if staging.exists():
        parser.error(f"Inspect the incomplete preparation at {staging} before removing it")
    staging.mkdir(parents=True)
    print("Unpacking the Chromium source archive", flush=True)
    shared.extract(archive, staging, strip=f"chromium-{chromium['version']}")

    available = shared.deps_dependencies(staging)
    for path in linux["dependencies"]:
        if path not in available or not available[path][1]:
            parser.error(f"DEPS no longer pins {path} for a Linux x86-64 host")
        bucket, objects = available[path]
        destination = staging / path.removeprefix("src/")
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        for item in objects:
            name = item.get("output_file") or Path(item["object_name"]).name
            print(f"Fetching {path}: {name}", flush=True)
            cached = shared.fetch(f"https://storage.googleapis.com/{bucket}/{item['object_name']}",
                                  downloads / bucket / item["sha256sum"] / name, item["sha256sum"])
            if tarfile.is_tarfile(cached):
                shared.extract(cached, destination)
            else:
                shutil.copyfile(cached, destination / name)

    for relative in linux["overlay"]:
        target = staging / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ENGINE / "Overlay" / relative, target)
    for name in linux["patches"]:
        shared.run(["patch", "-p1", "--forward", "--fuzz=0", "--input", ENGINE / "Patches" / name], staging)

    staging.rename(source)
    output = source / "out/CrestBaseline"
    output.mkdir(parents=True)
    flags = {**lock["buildArguments"], **linux["buildArguments"]}
    (output / "args.gn").write_text("".join(f"{key}={json.dumps(value)}\n" for key, value in flags.items()))
    gn = source / "buildtools/linux64/gn"
    if not gn.is_file():
        shared.run([sys.executable, source / "tools/gn/bootstrap/bootstrap.py", "-o", "out/CrestBaseline/gn",
                    "--skip-generate-buildfiles"], source)
        gn = output / "gn"
    # The build loads only what Chrome needs: the whole tree also holds Linux-only tools, such as the
    # service discovery sniffer, that assert on features Crest turns off.
    shared.run([gn, "gen", "out/CrestBaseline", "--fail-on-unused-args", "--root-target=//chrome"], source)
    print("Source prepared. Run build-chromium-baseline.py against it.")


if __name__ == "__main__":
    main()
