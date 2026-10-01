"""Prepare the pinned Anki release for a synthetic Mac deck check."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import plistlib
import py_compile
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DMG_SHA256 = "b36fe8f6c015a602feaf3ef38f5967c27c8964ee30a5c74ca2532225cf602345"


def synthetic_path(path: Path) -> Path:
    path = path.absolute()
    allowed = ROOT / "out/learnrecur"
    if not path.is_relative_to(allowed) or path == allowed:
        raise ValueError("Use a path below this checkout's out/learnrecur directory")
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError(f"Symlinks are not allowed: {parent}")
        if parent == ROOT:
            break
    if path.resolve() != path:
        raise ValueError("Use a canonical path without '..'")
    return path


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare(dmg: Path, package: Path, work: Path) -> Path:
    if sys.platform != "darwin":
        raise ValueError("This check requires macOS")
    dmg, package, work = map(synthetic_path, (dmg, package, work))
    if work.exists():
        raise ValueError("Use a fresh work directory")
    if digest(dmg) != DMG_SHA256:
        raise ValueError("The disk image does not match Anki 26.09.3 for Apple Silicon")
    if package.suffix != ".apkg" or not package.is_file():
        raise ValueError("Choose the exported synthetic .apkg file")
    work.mkdir(parents=True)
    volume = work / "upstream-volume"
    subprocess.run(
        [
            "hdiutil",
            "attach",
            "-readonly",
            "-nobrowse",
            "-mountpoint",
            str(volume),
            str(dmg),
        ],
        check=True,
    )
    app = work / "AnkiCompatibility.app"
    try:
        original = volume / "Anki.app"
        subprocess.run(
            ["codesign", "--verify", "--deep", "--strict", str(original)], check=True
        )
        launcher = original / "Contents/Resources/app/anki/app.pyc"
        if launcher.read_bytes()[:4] != importlib.util.MAGIC_NUMBER:
            raise ValueError(
                "Run this script with the repository's out/pyenv/bin/python"
            )
        shutil.copytree(original, app, symlinks=True)
        original_bridge = digest(
            original / "Contents/Resources/app_packages/anki/_rsbridge.so"
        )
    finally:
        subprocess.run(["hdiutil", "detach", str(volume)], check=True)

    base = work / "upstream-profile"
    base.mkdir()
    # Seed only the new test profile. This helper imports no Anki collection code.
    sys.path.insert(0, str(ROOT / "qt/tests"))
    from launch_anki_for_e2e import _seed_prefs

    _seed_prefs(base)
    temp = work / "upstream-temp"
    temp.mkdir()
    key = "learnrecur-upstream-" + hashlib.sha256(str(work).encode()).hexdigest()[:12]
    info_path = app / "Contents/Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info["CFBundleIdentifier"] = (
        "io.github.bennetthilberg.learnrecur.compatibility." + key
    )
    info["CFBundleName"] = info["CFBundleDisplayName"] = "AnkiCompatibility"
    for field in (
        "CFBundleDocumentTypes",
        "UTExportedTypeDeclarations",
        "UTImportedTypeDeclarations",
    ):
        info.pop(field, None)
    info_path.write_bytes(plistlib.dumps(info))

    launcher = app / "Contents/Resources/app/anki/app.py"
    launcher.write_text(
        f"""def main():
    import os
    import sys
    if sys.argv[1:] not in ([], [{str(package)!r}]):
        raise SystemExit("Use only the synthetic package or no arguments")
    os.environ["ANKI_BASE"] = {str(base)!r}
    os.environ["ANKI_SINGLE_INSTANCE_KEY"] = {key!r}
    os.environ["TMPDIR"] = {str(temp)!r}
    sys.argv = [sys.argv[0], "-b", {str(base)!r}, "-p", "test", *sys.argv[1:]]
    import aqt
    aqt.run()
"""
    )
    py_compile.compile(
        str(launcher), cfile=str(launcher.with_suffix(".pyc")), doraise=True
    )
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True
    )
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    bridge = app / "Contents/Resources/app_packages/anki/_rsbridge.so"
    if digest(bridge) != original_bridge:
        raise ValueError("The upstream Rust bridge changed while preparing the app")
    (work / "provenance.json").write_text(
        json.dumps(
            {
                "release": "26.09.3",
                "dmg_sha256": DMG_SHA256,
                "package_sha256": digest(package),
                "bridge_sha256": original_bridge,
                "base": str(base),
                "changes": [
                    "bundle identity and document associations",
                    "launch wrapper",
                    "ad hoc signatures",
                ],
            },
            indent=2,
        )
    )
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dmg", type=Path)
    parser.add_argument("package", type=Path)
    parser.add_argument("work", type=Path)
    args = parser.parse_args()
    try:
        print(prepare(args.dmg, args.package, args.work))
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
