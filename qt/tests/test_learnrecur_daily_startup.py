"""Check the Daily app's startup module with synthetic configuration.

These tests never contact a real host. Tunnels are stand-in `sleep` processes,
and SSH destinations use reserved addresses.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import socket
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from tools.learnrecur_daily import startup as daily

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="needs POSIX")

HOSTS = ("synthetic@100.64.0.1", "synthetic@192.0.2.1")


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    monkeypatch.setattr(daily, "ROOT", tmp_path)
    monkeypatch.setattr(daily, "SSH_KEY", tmp_path / "key")
    monkeypatch.setattr(daily, "KNOWN_HOSTS", tmp_path / "known_hosts")
    monkeypatch.setattr(daily, "PORTS", daily.DEFAULT_PORTS)
    monkeypatch.setattr(daily, "_host_index", 0)
    monkeypatch.setattr(daily, "_started_at", 0.0)
    return tmp_path


def ended(process: subprocess.Popen) -> bool:
    return process.poll() is not None


class Helper:
    """Run the connection helper in a thread with stand-in tunnels."""

    def __init__(
        self,
        root: Path,
        monkeypatch,
        *,
        existing: bool = False,
        authenticated: bool = True,
        both_ports: bool = True,
        sync_ok: bool = True,
        hosts: tuple[str, ...] = HOSTS,
    ) -> None:
        if hosts:
            (root / "ssh-hosts").write_text("\n".join(hosts) + "\n")
        self.tunnels: list[subprocess.Popen] = []
        monkeypatch.setattr(daily, "occupied", lambda: existing)
        monkeypatch.setattr(daily, "connected", lambda: authenticated)
        monkeypatch.setattr(daily, "fully_occupied", lambda: existing and both_ports)
        monkeypatch.setattr(daily, "sync_reachable", lambda: sync_ok)
        monkeypatch.setattr(daily, "start_tunnel", self.start)
        self.control, child = socket.socketpair()
        self.control.settimeout(12)
        log = (root / "log").open("ab")

        def work() -> None:
            with child, log:
                daily.supervise(child, log)

        self.thread = threading.Thread(target=work, daemon=True)
        self.thread.start()

    def start(self, log) -> subprocess.Popen:
        tunnel = subprocess.Popen(["/bin/sleep", "120"])
        self.tunnels.append(tunnel)
        return tunnel

    def quit(self) -> None:
        self.control.close()
        self.thread.join(8)
        assert not self.thread.is_alive()

    def cleanup(self) -> None:
        for tunnel in self.tunnels:
            if tunnel.poll() is None:
                tunnel.kill()
                tunnel.wait()


@pytest.fixture
def helpers():
    started: list[Helper] = []
    yield started
    for helper in started:
        helper.cleanup()


def run_helper(root, monkeypatch, helpers, **kwargs) -> Helper:
    helper = Helper(root, monkeypatch, **kwargs)
    helpers.append(helper)
    return helper


def test_app_exit_closes_only_owned_tunnel(root, monkeypatch, helpers):
    helper = run_helper(root, monkeypatch, helpers)
    assert helper.control.recv(64) == b"ready\n"
    (tunnel,) = helper.tunnels
    assert not ended(tunnel)
    helper.quit()
    assert ended(tunnel)


def test_dead_owned_tunnel_is_restarted(root, monkeypatch, helpers):
    helper = run_helper(root, monkeypatch, helpers)
    assert helper.control.recv(64) == b"ready\n"
    helper.tunnels[0].terminate()
    until = time.monotonic() + 8
    while time.monotonic() < until and len(helper.tunnels) < 2:
        time.sleep(0.1)
    assert len(helper.tunnels) == 2
    assert not ended(helper.tunnels[1])
    helper.quit()
    assert ended(helper.tunnels[1])
    assert b"retrying in five seconds" in (root / "log").read_bytes()


def test_existing_authenticated_tunnel_is_not_owned(root, monkeypatch, helpers):
    helper = run_helper(root, monkeypatch, helpers, existing=True)
    assert helper.control.recv(64) == b"ready\n"
    helper.quit()
    assert helper.tunnels == []


def test_foreign_service_is_refused(root, monkeypatch, helpers):
    helper = run_helper(root, monkeypatch, helpers, existing=True, authenticated=False)
    assert helper.control.recv(64) == b"error\n"
    helper.quit()
    assert helper.tunnels == []


def test_partial_forwarding_is_refused(root, monkeypatch, helpers):
    # Only one port answers, so it can't be our own two-port tunnel.
    helper = run_helper(root, monkeypatch, helpers, existing=True, both_ports=False)
    assert helper.control.recv(64) == b"error\n"
    helper.quit()
    assert helper.tunnels == []


def test_foreign_sync_port_is_refused(root, monkeypatch, helpers):
    helper = run_helper(root, monkeypatch, helpers, existing=True, sync_ok=False)
    assert helper.control.recv(64) == b"error\n"
    helper.quit()
    assert helper.tunnels == []


def test_lock_conflict_never_starts_a_tunnel(root, monkeypatch, helpers):
    with (root / "launcher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        helper = run_helper(root, monkeypatch, helpers)
        assert helper.control.recv(64) == b"existing\n"
        helper.quit()
    assert helper.tunnels == []


def test_no_hosts_works_offline(root, monkeypatch, helpers):
    helper = run_helper(root, monkeypatch, helpers, hosts=())
    assert helper.control.recv(64) == b"ready\n"
    time.sleep(0.7)
    helper.quit()
    assert helper.tunnels == []
    assert b"working offline" in (root / "log").read_bytes()


def write_config(root: Path, profile: str = "Synthetic Daily") -> None:
    (root / "desktop").mkdir()
    (root / "desktop/.learnrecur-data").write_text(daily.STORAGE_MARKER)
    (root / "companion-token").write_text("synthetic-token\n")
    (root / "profile-ready.json").write_text(
        json.dumps({"profile": str(root / "desktop" / profile), "source_id": "s1"})
    )


def test_startup_keeps_profile_and_accepts_split_status(root, monkeypatch):
    write_config(root)
    seen: dict = {}

    class FakeHelper:
        def __init__(self, args, **kwargs):
            seen["args"] = args
            self.control = socket.socket(fileno=os.dup(kwargs["pass_fds"][0]))

            def work():
                with self.control:
                    self.control.sendall(b"re")
                    time.sleep(0.02)
                    self.control.sendall(b"ady\n")
                    seen["eof"] = self.control.recv(1) == b""

            self.thread = threading.Thread(target=work)
            self.thread.start()

        def wait(self, timeout):
            self.thread.join(timeout)
            assert not self.thread.is_alive()
            return 0

    logs: list[Path] = []
    monkeypatch.setattr(daily, "redirect_output", logs.append)
    monkeypatch.setattr(daily.subprocess, "Popen", FakeHelper)
    monkeypatch.setattr(daily.sys, "argv", ["LearnRecur"])
    with patch.dict(
        os.environ, {"ANKI_BASE": "ignore-me", "OPENAI_API_KEY": "ignore-me"}
    ):
        with daily.startup():
            assert "ANKI_BASE" not in os.environ
            assert "OPENAI_API_KEY" not in os.environ
            assert os.environ["LEARNRECUR_BASE"] == str(root / "desktop")
            assert os.environ["LEARNRECUR_COMPANION_URL"] == "http://127.0.0.1:45352"
            assert os.environ["LEARNRECUR_COMPANION_TOKEN"] == "synthetic-token"
            assert daily.sys.argv == [
                "LearnRecur",
                "-b",
                str(root / "desktop"),
                "-p",
                "Synthetic Daily",
            ]
    assert seen["eof"]
    assert seen["args"][:3] == [daily.HELPER_PYTHON, "-I", daily.__file__]
    assert seen["args"][3] == "--supervise"
    assert logs == [root / "app.log"]
    assert (root / "desktop.pid").read_text() == str(os.getpid())


def test_unmarked_storage_never_starts_helper(root, monkeypatch):
    monkeypatch.setattr(daily, "redirect_output", lambda path: None)
    with patch.object(daily.subprocess, "Popen") as start:
        with pytest.raises(FileNotFoundError):
            with daily.startup():
                pass
        start.assert_not_called()


def test_missing_profile_never_starts_helper(root, monkeypatch):
    write_config(root)
    (root / "profile-ready.json").write_text("{}")
    monkeypatch.setattr(daily, "redirect_output", lambda path: None)
    with patch.object(daily.subprocess, "Popen") as start:
        with pytest.raises(KeyError):
            with daily.startup():
                pass
        start.assert_not_called()


def hosts_used(root: Path, monkeypatch, durations: list[float]) -> list[list[str]]:
    used: list[list[str]] = []
    clock = [1000.0]
    monkeypatch.setattr(daily.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        daily.subprocess, "Popen", lambda args, **kwargs: used.append(args)
    )
    with (root / "log").open("ab") as log:
        for lasted in durations:
            daily.start_tunnel(log)
            clock[0] += lasted
    return used


def test_missing_host_file_starts_no_tunnel(root, monkeypatch):
    assert hosts_used(root, monkeypatch, [1]) == []
    assert b"no SSH hosts" in (root / "log").read_bytes()


def test_quick_failures_rotate_and_stable_tunnel_reconnects_same_host(
    root, monkeypatch
):
    (root / "ssh-hosts").write_text(
        "# comment\nsynthetic@100.64.0.1\n\n  synthetic@192.0.2.1\n"
    )
    used = hosts_used(root, monkeypatch, [6, 6, 600, 6])
    assert [args[-1] for args in used] == [
        "synthetic@100.64.0.1",
        "synthetic@192.0.2.1",
        "synthetic@100.64.0.1",
        "synthetic@100.64.0.1",
    ]


def test_tunnel_uses_configured_key_and_ports(root, monkeypatch):
    (root / "ssh-hosts").write_text("synthetic@192.0.2.1\n")
    monkeypatch.setattr(daily, "PORTS", (46001, 46002))
    (args,) = hosts_used(root, monkeypatch, [1])
    assert args[:3] == ["/usr/bin/ssh", "-i", str(root / "key")]
    assert "UserKnownHostsFile=" + str(root / "known_hosts") in args
    assert "StrictHostKeyChecking=yes" in args
    assert args[-6:] == [
        "-N",
        "-L",
        "127.0.0.1:46001:127.0.0.1:45331",
        "-L",
        "127.0.0.1:46002:127.0.0.1:45321",
        "synthetic@192.0.2.1",
    ]


def write_settings(path: Path, **changes) -> Path:
    settings = {
        "config_dir": str(path.parent / "config"),
        "ssh_key": str(path.parent / "key"),
        "known_hosts": str(path.parent / "known_hosts"),
        "local_ports": [46001, 46002],
    }
    settings.update(changes)
    path.write_text(json.dumps(settings))
    return path


def test_configure_reads_settings(root, monkeypatch, tmp_path):
    daily.configure(write_settings(tmp_path / "settings.json"))
    assert daily.ROOT == tmp_path / "config"
    assert daily.SSH_KEY == tmp_path / "key"
    assert daily.KNOWN_HOSTS == tmp_path / "known_hosts"
    assert daily.PORTS == (46001, 46002)


@pytest.mark.parametrize(
    "changes",
    [
        {"config_dir": "relative/config"},
        {"ssh_key": "key"},
        {"local_ports": [46001, 46001]},
        {"local_ports": [46001]},
        {"local_ports": [80, 46002]},
    ],
)
def test_configure_rejects_bad_settings(root, tmp_path, changes):
    with pytest.raises(ValueError):
        daily.configure(write_settings(tmp_path / "settings.json", **changes))
    assert daily.ROOT == root


LOG_SCRIPT = textwrap.dedent(
    """
    import importlib.util, os, sys, time
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("daily", sys.argv[1])
    daily = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(daily)
    log = Path(sys.argv[2])
    daily.redirect_output(log, limit=400, check_seconds=0.05)
    for number in range(20):
        print("python line", number, "x" * 40)
        os.write(2, b"native line\\n")
        time.sleep(0.02)
    time.sleep(0.3)
    print("last line")
    """
)


def test_app_output_goes_to_private_bounded_log(tmp_path):
    log = tmp_path / "app.log"
    log.write_bytes(b"old launch\n" * 100)
    result = subprocess.run(
        [sys.executable, "-c", LOG_SCRIPT, daily.__file__, str(log)],
        capture_output=True,
        timeout=30,
        check=True,
    )
    assert result.stdout == b""
    assert result.stderr == b""
    older = log.with_name("app.log.1")
    assert (log.stat().st_mode & 0o777) == 0o600
    assert (older.stat().st_mode & 0o777) == 0o600
    # The check runs every 0.05 s, so a file can pass the limit by a few lines,
    # more on a busy machine.
    assert log.stat().st_size < 2000
    assert older.stat().st_size < 2000
    assert b"old launch" not in older.read_bytes()
    assert log.read_bytes().endswith(b"last line\n")
    assert b"native line" in log.read_bytes() + older.read_bytes()


def system_pythons() -> list[str]:
    pythons = [sys.executable]
    if Path(daily.HELPER_PYTHON).exists():
        pythons.append(daily.HELPER_PYTHON)
    return pythons


@pytest.mark.parametrize("python", system_pythons())
def test_helper_entry_point_reads_bundle_settings(tmp_path, python):
    bundle = tmp_path / "bundle"
    config = tmp_path / "config"
    bundle.mkdir()
    config.mkdir()
    module = bundle / "learnrecur_daily.py"
    shutil.copyfile(daily.__file__, module)
    write_settings(bundle / "learnrecur_daily.json", config_dir=str(config))
    control, child = socket.socketpair()
    with control, (config / "launcher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        process = subprocess.Popen(
            [python, "-I", str(module), "--supervise", str(child.fileno())],
            pass_fds=(child.fileno(),),
        )
        child.close()
        control.settimeout(20)
        assert control.recv(64) == b"existing\n"
    assert process.wait(timeout=20) == 0
    assert (config / "launcher.log").exists()
    assert not (bundle / "__pycache__").exists()


def test_daily_storage_overrides_command_line_storage(root):
    from aqt import parseArgs

    base = root / "desktop"
    arguments = daily.app_arguments(
        ["-b", "/elsewhere", "--profile=Other", "-psn_0_12345", "deck.apkg"],
        base,
        "Synthetic Daily",
    )
    opts, args = parseArgs(["LearnRecur", *arguments])
    assert opts.base == str(base)
    assert opts.profile == "Synthetic Daily"
    assert args == ["deck.apkg"]


def test_startup_refuses_during_installation(root, monkeypatch):
    write_config(root)
    monkeypatch.setattr(daily, "redirect_output", lambda path: None)
    with (root / daily.INSTALL_LOCK).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with patch.object(daily.subprocess, "Popen") as start:
            with pytest.raises(RuntimeError, match="being updated"):
                with daily.startup():
                    pass
            start.assert_not_called()


def test_running_app_blocks_installation(root, monkeypatch):
    write_config(root)

    class FakeHelper:
        def __init__(self, args, **kwargs):
            self.control = socket.socket(fileno=os.dup(kwargs["pass_fds"][0]))
            self.control.sendall(b"ready\n")

        def wait(self, timeout):
            self.control.close()
            return 0

    monkeypatch.setattr(daily, "redirect_output", lambda path: None)
    monkeypatch.setattr(daily.subprocess, "Popen", FakeHelper)
    monkeypatch.setattr(daily.sys, "argv", ["LearnRecur"])

    def installer_can_lock() -> bool:
        with (root / daily.INSTALL_LOCK).open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            return True

    with daily.startup():
        assert not installer_can_lock()
    assert installer_can_lock()
