"""Build the LearnRecur Daily app from a packaged LearnRecur.app and install it.

The Daily app is the packaged app under its own name and bundle ID, with a
startup module that opens one profile from a private configuration directory
and forwards the sync and companion ports over SSH. The module and its settings
go inside the bundle; the configuration directory, SSH key, and known_hosts
file stay outside it. learnrecur/DAILY-USE.md describes the whole process.

    out/pyenv/bin/python qt/tools/learnrecur_daily/install.py \\
        --config DIR --app DEST.app --ssh-key KEY --known-hosts FILE [--dry-run]

The installer refuses to run while the app is open. Before replacing anything,
it saves the collection's notes, cards, and review log as JSON plus a copy of
the collection file. It keeps the previous app in the same backup folder, under
`<config>/installs/`, and verifies both signatures.
"""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
import plistlib
import py_compile
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[3]
STARTUP = Path(__file__).resolve().with_name("startup.py")
DEFAULT_PACKAGE = ROOT / "out/installer/build/anki/macos/app/LearnRecur.app"
DEFAULT_NAME = "LearnRecur Daily"
DEFAULT_BUNDLE_ID = "io.github.bennetthilberg.learnrecur.daily-trial-launcher"
DEFAULT_PORTS = (45351, 45352)
MODULE = "learnrecur_daily"
STORAGE_MARKER = "learnrecur-data-v1\n"
SNAPSHOT_TABLES = ("notes", "cards", "revlog")
DROPPED_PLIST_KEYS = (
    "CFBundleDocumentTypes",
    "UTExportedTypeDeclarations",
    "UTImportedTypeDeclarations",
)
BUNDLE_ID = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")

APP_PY = '''\
"""Start LearnRecur Daily. Written by qt/tools/learnrecur_daily/install.py."""


def main():
    import importlib.util
    import sys
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "{module}.py"
    spec = importlib.util.spec_from_file_location("{module}", path)
    daily = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = daily
    # Don't add a bytecode cache to the signed bundle.
    writes_bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(daily)
    finally:
        sys.dont_write_bytecode = writes_bytecode
    daily.configure()
    with daily.startup():
        import aqt

        aqt.run()
'''.format(module=MODULE)


class InstallError(Exception):
    pass


@dataclass(frozen=True)
class Plan:
    package: Path
    app: Path
    config: Path
    ssh_key: Path
    known_hosts: Path
    name: str
    bundle_id: str
    local_ports: tuple[int, int]
    profile: str
    collection: Path
    backup: Path
    version: str


def full_path(value: str) -> Path:
    return Path(value).expanduser().absolute()


def reject_anki_data(path: Path) -> None:
    anki = Path.home() / "Library/Application Support/Anki2"
    if "Anki2" in path.parts or path.resolve().is_relative_to(anki.resolve()):
        raise InstallError(f"Refusing to use Anki's data folder: {path}")


def run(*args: str) -> None:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode:
        raise InstallError(f"{' '.join(args)} failed:\n{result.stderr.strip()}")


def verify_signature(app: Path) -> None:
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(app))


def read_plist(app: Path) -> dict:
    try:
        return plistlib.loads((app / "Contents/Info.plist").read_bytes())
    except (OSError, plistlib.InvalidFileException) as err:
        raise InstallError(f"Can't read {app}/Contents/Info.plist: {err}") from err


def check_package(package: Path) -> None:
    if package.suffix != ".app" or not package.is_dir():
        raise InstallError(
            f"No packaged app at {package}. Run ./ninja installer:package."
        )
    info = read_plist(package)
    if not (package / "Contents/MacOS" / str(info.get("CFBundleExecutable"))).is_file():
        raise InstallError(f"{package} has no executable.")
    entry = package / "Contents/Resources/app/anki/__main__.pyc"
    if not entry.is_file():
        raise InstallError(f"{package} doesn't have the expected Briefcase layout.")
    # The new app.pyc must load in the bundled Python.
    if entry.read_bytes()[:4] != importlib.util.MAGIC_NUMBER:
        raise InstallError(
            f"{package} bundles a different Python version. "
            "Run this with out/pyenv/bin/python from the same build."
        )
    verify_signature(package)


def check_config(config: Path) -> tuple[str, Path]:
    """Return the profile name and its collection path."""
    if not config.is_dir():
        raise InstallError(f"No configuration directory at {config}.")
    marker = config / "desktop/.learnrecur-data"
    if not marker.is_file() or marker.read_text() != STORAGE_MARKER:
        raise InstallError(f"{config}/desktop isn't marked as LearnRecur storage.")
    if not (config / "companion-token").is_file():
        raise InstallError(f"{config} has no companion-token file.")
    try:
        ready = json.loads((config / "profile-ready.json").read_text())
        name = Path(ready["profile"]).name
        ready["source_id"]
    except (OSError, ValueError, KeyError, TypeError) as err:
        raise InstallError(
            f"{config}/profile-ready.json needs a profile and source_id: {err}"
        ) from err
    if name in ("", ".", ".."):
        raise InstallError(
            f"{config}/profile-ready.json doesn't name a profile folder."
        )
    return name, config / "desktop" / name / "collection.anki2"


def check_destination(app: Path, package: Path, config: Path, bundle_id: str) -> str:
    """Return the CFBundleVersion for the new app."""
    if app.suffix != ".app" or not app.parent.is_dir():
        raise InstallError(f"{app} must be an .app path in an existing folder.")
    if app.is_symlink():
        raise InstallError(f"{app} is a symbolic link.")
    for one, other in ((app, package), (package, app), (app, config), (config, app)):
        if one == other or one.is_relative_to(other):
            raise InstallError(f"{app} overlaps {other}.")
    if os.stat(config).st_dev != os.stat(app.parent).st_dev:
        raise InstallError(
            f"{config} and {app.parent} must be on the same disk so the swap is a rename."
        )
    if not app.exists():
        return "1"
    previous = read_plist(app)
    if previous.get("CFBundleIdentifier") != bundle_id:
        raise InstallError(
            f"{app} has bundle ID {previous.get('CFBundleIdentifier')!r}, not {bundle_id!r}. "
            "Refusing to replace a different app."
        )
    version = str(previous.get("CFBundleVersion", ""))
    return str(int(version) + 1) if version.isdigit() else "1"


def backup_folder(config: Path) -> Path:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    folder = config / "installs" / stamp
    count = 1
    while folder.exists():
        count += 1
        folder = config / "installs" / f"{stamp}-{count}"
    return folder


def make_plan(args: argparse.Namespace) -> Plan:
    if sys.platform != "darwin":
        raise InstallError("The Daily app can only be built on a Mac.")
    package = full_path(args.package)
    app = full_path(args.app)
    config = full_path(args.config)
    ssh_key = full_path(args.ssh_key)
    known_hosts = full_path(args.known_hosts)
    for path in (app, config):
        reject_anki_data(path)
    for path in (ssh_key, known_hosts):
        if not path.is_file():
            raise InstallError(f"No file at {path}.")
    if not BUNDLE_ID.match(args.bundle_id):
        raise InstallError(f"{args.bundle_id!r} isn't a bundle ID.")
    ports = tuple(int(port) for port in args.local_ports.split(","))
    if (
        len(ports) != 2
        or ports[0] == ports[1]
        or not all(1024 < p < 65536 for p in ports)
    ):
        raise InstallError("--local-ports needs two different ports, like 45351,45352.")
    check_package(package)
    profile, collection = check_config(config)
    version = check_destination(app, package, config, args.bundle_id)
    return Plan(
        package=package,
        app=app,
        config=config,
        ssh_key=ssh_key,
        known_hosts=known_hosts,
        name=args.name,
        bundle_id=args.bundle_id,
        local_ports=(ports[0], ports[1]),
        profile=profile,
        collection=collection,
        backup=backup_folder(config),
        version=version,
    )


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def check_not_running(plan: Plan) -> None:
    listing = subprocess.run(
        ["/bin/ps", "-axww", "-o", "command="],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    if f"{plan.app}/Contents/" in listing:
        raise InstallError(f"{plan.app} is running. Quit it first.")
    pid_file = plan.config / "desktop.pid"
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
        except ValueError:
            pid = 0
        if pid > 0 and pid != os.getpid() and process_alive(pid):
            raise InstallError(
                f"The Daily app is still running as process {pid}. Quit it first."
            )
    if Path(f"{plan.collection}-wal").exists():
        raise InstallError(
            f"{plan.collection} has a write-ahead log, so it may still be open. "
            "Quit the app first."
        )


@contextmanager
def launcher_lock(plan: Plan, dry_run: bool) -> Iterator[None]:
    """Hold the app's locks, so the app can't start mid-swap.

    A running app holds a shared lock on `install.lock` for its whole life, and
    its connection helper holds `launcher.lock`. Holding both exclusively makes
    a launch during installation refuse to start.
    """
    with ExitStack() as stack:
        for name in ("install.lock", "launcher.lock"):
            path = plan.config / name
            if dry_run and not path.exists():
                continue
            lock = stack.enter_context(path.open("r" if dry_run else "a"))
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as err:
                raise InstallError("The Daily app is running. Quit it first.") from err
        yield


def read_rows(collection: Path) -> dict[str, list[list]]:
    uri = collection.as_uri() + "?mode=ro&immutable=1"
    db = sqlite3.connect(uri, uri=True)
    try:
        return {
            table: [
                list(row) for row in db.execute(f"select * from {table} order by id")
            ]
            for table in SNAPSHOT_TABLES
        }
    finally:
        db.close()


def write_private(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


def snapshot(plan: Plan) -> dict[str, int] | None:
    """Save the collection's rows and a copy of its file in the backup folder."""
    if not plan.collection.exists():
        return None
    rows = read_rows(plan.collection)
    write_private(
        plan.backup / "native-before.json",
        json.dumps(rows, default=lambda value: value.hex()).encode(),
    )
    copy = plan.backup / "collection-before.anki2"
    write_private(copy, b"")
    shutil.copyfile(plan.collection, copy)
    if read_rows(copy) != rows:
        raise InstallError("The collection copy doesn't match the collection.")
    return {table: len(items) for table, items in rows.items()}


def build(plan: Plan, staged: Path) -> None:
    """Make the Daily app from a clone of the package and sign it."""
    run("/bin/cp", "-cR", str(plan.package), str(staged))
    info_path = staged / "Contents/Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info["CFBundleName"] = info["CFBundleDisplayName"] = plan.name
    info["CFBundleIdentifier"] = plan.bundle_id
    info["CFBundleVersion"] = plan.version
    for key in DROPPED_PLIST_KEYS:
        info.pop(key, None)
    info_path.write_bytes(plistlib.dumps(info))

    resources = staged / "Contents/Resources/app"
    shutil.copyfile(STARTUP, resources / f"{MODULE}.py")
    settings = {
        "config_dir": str(plan.config),
        "ssh_key": str(plan.ssh_key),
        "known_hosts": str(plan.known_hosts),
        "local_ports": list(plan.local_ports),
    }
    (resources / f"{MODULE}.json").write_text(json.dumps(settings, indent=2) + "\n")
    entry = resources / "anki/app.py"
    entry.write_text(APP_PY)
    py_compile.compile(str(entry), cfile=str(entry.with_suffix(".pyc")), doraise=True)
    run("/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(staged))
    verify_signature(staged)


def swap(plan: Plan, staged: Path) -> Path | None:
    """Move the old app into the backup folder and the new one into place."""
    previous = plan.backup / "previous.app"
    if plan.app.exists():
        plan.app.rename(previous)
    try:
        staged.rename(plan.app)
    except OSError:
        if previous.exists():
            previous.rename(plan.app)
        raise
    return previous if previous.exists() else None


def describe(plan: Plan) -> dict:
    return {
        "app": str(plan.app),
        "package": str(plan.package),
        "config": str(plan.config),
        "profile": plan.profile,
        "bundle_id": plan.bundle_id,
        "version": plan.version,
        "local_ports": list(plan.local_ports),
        "backup": str(plan.backup),
        "replaces_existing_app": plan.app.exists(),
    }


def install(plan: Plan, dry_run: bool = False) -> dict:
    with launcher_lock(plan, dry_run):
        check_not_running(plan)
        summary = describe(plan)
        if dry_run:
            if plan.collection.exists():
                rows = read_rows(plan.collection)
                summary["collection"] = {t: len(r) for t, r in rows.items()}
            summary["dry_run"] = True
            return summary
        (plan.config / "installs").mkdir(mode=0o700, exist_ok=True)
        plan.backup.mkdir(mode=0o700)
        summary["collection"] = snapshot(plan)
        staged = plan.backup / plan.app.name
        build(plan, staged)
        previous = swap(plan, staged)
        verify_signature(plan.app)
        summary["previous_app"] = str(previous) if previous else None
        write_private(
            plan.backup / "install.json", json.dumps(summary, indent=2).encode()
        )
        return summary


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--config", required=True, help="private configuration directory"
    )
    parser.add_argument("--app", required=True, help="where to install the Daily app")
    parser.add_argument(
        "--ssh-key", required=True, help="SSH private key for the backend"
    )
    parser.add_argument(
        "--known-hosts", required=True, help="known_hosts file for the backend"
    )
    parser.add_argument(
        "--package", default=str(DEFAULT_PACKAGE), help="packaged LearnRecur.app"
    )
    parser.add_argument("--name", default=DEFAULT_NAME, help="app name")
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID, help="app bundle ID")
    parser.add_argument(
        "--local-ports",
        default="%d,%d" % DEFAULT_PORTS,
        help="local sync and companion ports, comma-separated",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="check everything, change nothing"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        summary = install(make_plan(args), dry_run=args.dry_run)
    except (InstallError, OSError, sqlite3.Error) as err:
        print(f"Daily app not installed: {err}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
