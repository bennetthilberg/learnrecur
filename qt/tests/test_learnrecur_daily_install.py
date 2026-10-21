"""Install the Daily app from a fake package into synthetic folders."""

from __future__ import annotations

import fcntl
import importlib.util
import json
import plistlib
import py_compile
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from tools.learnrecur_daily import install as daily_install

pytestmark = pytest.mark.skipif(
    sys.platform != "darwin" or not Path("/usr/bin/codesign").exists(),
    reason="needs macOS codesign",
)

BUNDLE_ID = "io.github.bennetthilberg.learnrecur.daily-test"


def sign(app: Path) -> None:
    subprocess.run(
        ["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(app)],
        check=True,
        capture_output=True,
    )


def make_bundle(app: Path, bundle_id: str, version: str = "26.9.3") -> Path:
    """Make a signed app shaped like the Briefcase package, around a tiny binary."""
    (app / "Contents/MacOS").mkdir(parents=True)
    shutil.copyfile("/usr/bin/true", app / "Contents/MacOS/LearnRecur")
    (app / "Contents/MacOS/LearnRecur").chmod(0o755)
    info = {
        "CFBundleExecutable": "LearnRecur",
        "CFBundleIdentifier": bundle_id,
        "CFBundleName": "LearnRecur",
        "CFBundleDisplayName": "LearnRecur",
        "CFBundlePackageType": "APPL",
        "CFBundleVersion": version,
        "CFBundleDocumentTypes": [{"CFBundleTypeName": "Anki package"}],
        "UTExportedTypeDeclarations": [{"UTTypeIdentifier": "net.ankiweb.apkg"}],
    }
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    anki = app / "Contents/Resources/app/anki"
    anki.mkdir(parents=True)
    for name, source in (
        ("__init__", ""),
        ("__main__", "from anki.app import main\nmain()\n"),
        ("app", "def main():\n    pass\n"),
    ):
        (anki / f"{name}.py").write_text(source)
        py_compile.compile(
            str(anki / f"{name}.py"), cfile=str(anki / f"{name}.pyc"), doraise=True
        )
        (anki / f"{name}.py").unlink()
    sign(app)
    return app


def make_collection(path: Path) -> None:
    path.parent.mkdir(parents=True)
    db = sqlite3.connect(path)
    for table in daily_install.SNAPSHOT_TABLES:
        db.execute(f"create table {table} (id integer primary key, data text)")
        db.execute(f"insert into {table} values (1, 'synthetic {table}')")
    db.commit()
    db.close()


class Setup:
    def __init__(self, root: Path) -> None:
        self.package = make_bundle(
            root / "package/LearnRecur.app", "io.github.bennetthilberg.learnrecur.anki"
        )
        self.config = root / "config"
        desktop = self.config / "desktop"
        desktop.mkdir(parents=True)
        (desktop / ".learnrecur-data").write_text(daily_install.STORAGE_MARKER)
        (self.config / "companion-token").write_text("synthetic-token\n")
        (self.config / "ssh-hosts").write_text("synthetic@192.0.2.1\n")
        (self.config / "profile-ready.json").write_text(
            json.dumps(
                {"profile": str(desktop / "Synthetic Daily"), "source_id": "synthetic"}
            )
        )
        self.collection = desktop / "Synthetic Daily/collection.anki2"
        make_collection(self.collection)
        self.ssh = root / "ssh"
        self.ssh.mkdir()
        (self.ssh / "key").write_text("synthetic key placeholder\n")
        (self.ssh / "known_hosts").write_text("")
        (root / "Desktop").mkdir()
        self.app = root / "Desktop/LearnRecur Daily.app"

    def args(self, *extra: str) -> list[str]:
        return [
            "--config",
            str(self.config),
            "--app",
            str(self.app),
            "--ssh-key",
            str(self.ssh / "key"),
            "--known-hosts",
            str(self.ssh / "known_hosts"),
            "--package",
            str(self.package),
            "--bundle-id",
            BUNDLE_ID,
            *extra,
        ]

    def backups(self) -> list[Path]:
        folder = self.config / "installs"
        return sorted(folder.iterdir()) if folder.exists() else []


@pytest.fixture
def setup(tmp_path) -> Setup:
    return Setup(tmp_path)


def install(setup: Setup, capsys, *extra: str) -> dict:
    assert daily_install.main(setup.args(*extra)) == 0
    return json.loads(capsys.readouterr().out)


def refuse(setup: Setup, capsys, match: str, *extra: str) -> None:
    assert daily_install.main(setup.args(*extra)) == 1
    assert match in capsys.readouterr().err


def plist(app: Path) -> dict:
    return plistlib.loads((app / "Contents/Info.plist").read_bytes())


def rows(collection: Path) -> dict:
    return daily_install.read_rows(collection)


def mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def test_installs_and_keeps_previous_app(setup, capsys):
    first = install(setup, capsys)
    assert first["previous_app"] is None
    info = plist(setup.app)
    assert info["CFBundleName"] == info["CFBundleDisplayName"] == "LearnRecur Daily"
    assert info["CFBundleIdentifier"] == BUNDLE_ID
    assert info["CFBundleVersion"] == "1"
    assert info["CFBundleExecutable"] == "LearnRecur"
    for key in daily_install.DROPPED_PLIST_KEYS:
        assert key not in info

    resources = setup.app / "Contents/Resources/app"
    app_py = (resources / "anki/app.py").read_text()
    assert app_py == daily_install.APP_PY
    assert str(setup.config) not in app_py
    assert str(Path.home()) not in app_py
    pyc = (resources / "anki/app.pyc").read_bytes()
    assert pyc[:4] == importlib.util.MAGIC_NUMBER
    assert (resources / "learnrecur_daily.py").read_bytes() == (
        daily_install.STARTUP.read_bytes()
    )
    assert json.loads((resources / "learnrecur_daily.json").read_text()) == {
        "config_dir": str(setup.config),
        "ssh_key": str(setup.ssh / "key"),
        "known_hosts": str(setup.ssh / "known_hosts"),
        "local_ports": [45351, 45352],
    }
    daily_install.verify_signature(setup.app)

    (backup,) = setup.backups()
    assert mode(backup) == 0o700
    before = rows(setup.collection)
    snapshot = backup / "native-before.json"
    assert json.loads(snapshot.read_text()) == before
    assert mode(snapshot) == 0o600
    copy = backup / "collection-before.anki2"
    assert copy.read_bytes() == setup.collection.read_bytes()
    assert mode(copy) == 0o600
    assert first["collection"] == {"notes": 1, "cards": 1, "revlog": 1}

    # A review after the first install shows up in the second snapshot.
    db = sqlite3.connect(setup.collection)
    db.execute("insert into revlog values (2, 'second review')")
    db.commit()
    db.close()
    second = install(setup, capsys)
    assert plist(setup.app)["CFBundleVersion"] == "2"
    old, new = setup.backups()
    assert old == backup
    previous = new / "previous.app"
    assert second["previous_app"] == str(previous)
    assert plist(previous)["CFBundleVersion"] == "1"
    daily_install.verify_signature(previous)
    daily_install.verify_signature(setup.app)
    assert len(json.loads((new / "native-before.json").read_text())["revlog"]) == 2
    assert json.loads((new / "install.json").read_text())["version"] == "2"


def test_dry_run_changes_nothing(setup, capsys):
    summary = install(setup, capsys, "--dry-run")
    assert summary["dry_run"] is True
    assert summary["profile"] == "Synthetic Daily"
    assert summary["collection"] == {"notes": 1, "cards": 1, "revlog": 1}
    assert not setup.app.exists()
    assert setup.backups() == []
    assert not (setup.config / "launcher.lock").exists()


def test_refuses_while_app_process_is_alive(setup, capsys):
    install(setup, capsys)
    before = (setup.app / "Contents/Info.plist").read_bytes()
    process = subprocess.Popen(["/bin/sleep", "30"])
    try:
        (setup.config / "desktop.pid").write_text(str(process.pid))
        refuse(setup, capsys, "still running")
        refuse(setup, capsys, "still running", "--dry-run")
    finally:
        process.kill()
        process.wait()
    assert (setup.app / "Contents/Info.plist").read_bytes() == before
    assert len(setup.backups()) == 1
    install(setup, capsys)


def test_refuses_while_launcher_lock_is_held(setup, capsys):
    with (setup.config / "launcher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        refuse(setup, capsys, "running")
    assert not setup.app.exists()
    assert setup.backups() == []


def test_refuses_while_app_holds_install_lock(setup, capsys):
    with (setup.config / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        refuse(setup, capsys, "running")
    assert not setup.app.exists()
    assert setup.backups() == []


def test_refuses_open_collection(setup, capsys):
    Path(f"{setup.collection}-wal").write_bytes(b"")
    refuse(setup, capsys, "write-ahead log")
    assert not setup.app.exists()
    assert setup.backups() == []


def test_refuses_to_replace_a_different_app(setup, capsys):
    make_bundle(setup.app, "net.ankiweb.dtop")
    before = (setup.app / "Contents/Info.plist").read_bytes()
    refuse(setup, capsys, "Refusing to replace a different app")
    assert (setup.app / "Contents/Info.plist").read_bytes() == before
    assert setup.backups() == []


def test_refuses_anki_data_folder(setup, capsys, tmp_path):
    anki = tmp_path / "Anki2"
    setup.config.rename(anki)
    setup.config = anki
    refuse(setup, capsys, "Anki's data folder")
    assert setup.backups() == []


def test_refuses_package_with_other_python(setup, capsys):
    entry = setup.package / "Contents/Resources/app/anki/__main__.pyc"
    entry.write_bytes(b"\0\0\r\n" + entry.read_bytes()[4:])
    refuse(setup, capsys, "different Python version")
    assert not setup.app.exists()
