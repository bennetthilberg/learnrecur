"""Check the Daily app's startup module with synthetic configuration.

These tests never contact a real host or the Mac's real Tailscale client.
Tunnels are stand-in `sleep` processes, SSH destinations use reserved addresses,
and Tailscale is a fake script that prints canned status.
"""

from __future__ import annotations

import fcntl
import json
import os
import shlex
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


@pytest.fixture(autouse=True)
def no_real_tailscale(tmp_path, monkeypatch):
    monkeypatch.setattr(daily, "TAILSCALE_APP", str(tmp_path / "no-tailscale"))
    monkeypatch.setattr(daily, "TAILSCALE_CLI", None)
    monkeypatch.setattr(daily, "_tailscale_woken", False)
    monkeypatch.setattr(daily, "_tailscale_health", [])
    monkeypatch.setenv("PATH", str(tmp_path / "empty-path"))


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
        woken: bool = False,
    ) -> None:
        self.woken = woken
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
        # Stands in for start_tunnel() having to start Tailscale first.
        daily._tailscale_woken = self.woken
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


def test_configure_reads_tailscale_tool(root, monkeypatch, tmp_path):
    daily.configure(write_settings(tmp_path / "settings.json"))
    assert daily.TAILSCALE_CLI is None
    daily.configure(
        write_settings(tmp_path / "settings.json", tailscale_cli="/opt/ts/tailscale")
    )
    assert daily.TAILSCALE_CLI == Path("/opt/ts/tailscale")


@pytest.mark.parametrize(
    "changes",
    [
        {"config_dir": "relative/config"},
        {"tailscale_cli": "tailscale"},
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


TAILSCALE_HOST = "synthetic@100.64.0.1"


class FakeTailscale:
    """A stand-in Tailscale tool that prints canned status and records its calls."""

    def __init__(
        self,
        folder: Path,
        state: str = "Stopped",
        *,
        health: list[str] | None = None,
        up_exit: int = 0,
        status_output: str | None = None,
        status_sleep: float = 0,
    ) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / "tailscale"
        self.calls_file = folder / "calls"
        status = folder / "status.json"
        status.write_text(
            status_output
            if status_output is not None
            else json.dumps({"BackendState": state, "Health": health})
        )
        running = shlex.quote(json.dumps({"BackendState": "Running"}))
        after_up = f"printf '%s' {running} > {status}" if up_exit == 0 else ":"
        self.path.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/sh
                echo "$TAILSCALE_BE_CLI $*" >> {shlex.quote(str(self.calls_file))}
                case "$1" in
                  status) /bin/sleep {status_sleep}; /bin/cat {status} ;;
                  up) {after_up}; exit {up_exit} ;;
                esac
                """
            )
        )
        self.path.chmod(0o755)

    def calls(self) -> list[str]:
        if not self.calls_file.exists():
            return []
        return self.calls_file.read_text().splitlines()

    def ups(self) -> int:
        return self.calls().count("true up")


@pytest.fixture
def tailscale(root, tmp_path, monkeypatch):
    def make(*args, **kwargs) -> FakeTailscale:
        fake = FakeTailscale(tmp_path / "fake-tailscale", *args, **kwargs)
        monkeypatch.setattr(daily, "TAILSCALE_CLI", fake.path)
        return fake

    return make


def wake(root: Path, host: str = TAILSCALE_HOST) -> tuple[bool, bytes]:
    with (root / "log").open("ab") as log:
        woke = daily.wake_tailscale(host, log)
    return woke, (root / "log").read_bytes()


def test_stopped_tailscale_is_started_once(root, tailscale):
    fake = tailscale("Stopped")
    woke, log = wake(root)
    assert woke
    assert fake.calls() == ["true status --json", "true up", "true status --json"]
    assert b"found Tailscale stopped; running `tailscale up`." in log
    assert b"it's now Running." in log
    # Tailscale is running now, so the next check leaves it alone.
    assert wake(root)[0] is False
    assert fake.ups() == 1


def test_running_tailscale_is_left_alone(root, tailscale):
    fake = tailscale("Running")
    assert wake(root) == (False, b"")
    assert fake.calls() == ["true status --json"]


def test_stuck_tailscale_is_only_logged_once(root, tailscale):
    fake = tailscale("Running", health=["magicsock ReceiveIPv4 not running"])
    woke, log = wake(root)
    assert not woke
    assert b"warnings: magicsock ReceiveIPv4 not running" in log
    wake(root)
    assert (root / "log").read_bytes().count(b"warnings") == 1
    assert fake.ups() == 0


@pytest.mark.parametrize("state", ["NeedsLogin", "NeedsMachineAuth", "Starting"])
def test_other_tailscale_states_are_left_alone(root, tailscale, state):
    fake = tailscale(state)
    woke, log = wake(root)
    assert not woke
    assert fake.ups() == 0
    assert f"state {state}; leaving it alone".encode() in log


def test_failed_up_is_rate_limited(root, tailscale):
    fake = tailscale("Stopped", up_exit=1)
    for _ in range(3):
        assert wake(root)[0] is False
    assert fake.ups() == 1
    log = (root / "log").read_bytes()
    assert b"failed with exit code 1" in log
    assert log.count(b"less than a minute ago") == 2
    # A minute later, it tries again.
    (root / "tailscale-up.last").write_text(str(time.time() - 61))
    wake(root)
    assert fake.ups() == 2


def test_rate_limit_spans_launches(root, tailscale):
    fake = tailscale("Stopped")
    (root / "tailscale-up.last").write_text(str(time.time() - 10))
    assert wake(root)[0] is False
    assert fake.ups() == 0


def test_missing_tailscale_keeps_todays_behavior(root):
    assert daily.find_tailscale() is None
    assert wake(root) == (False, b"")


def test_non_tailscale_host_never_runs_tailscale(root, tailscale):
    fake = tailscale("Stopped")
    assert wake(root, "synthetic@192.0.2.1") == (False, b"")
    assert wake(root, "synthetic@backend.example") == (False, b"")
    assert fake.calls() == []


@pytest.mark.parametrize("output", ["", "not json", "[]"])
def test_unreadable_status_does_nothing(root, tailscale, output):
    fake = tailscale(status_output=output)
    woke, log = wake(root)
    assert not woke
    assert fake.ups() == 0
    assert b"couldn't read Tailscale's status" in log


def test_hung_tailscale_is_cut_off(root, tailscale, monkeypatch):
    monkeypatch.setattr(daily, "TAILSCALE_STATUS_TIMEOUT", 0.5)
    fake = tailscale("Stopped", status_sleep=30)
    started = time.monotonic()
    assert wake(root)[0] is False
    assert time.monotonic() - started < 5
    assert fake.ups() == 0


def test_tailscale_addresses():
    assert daily.tailscale_host("synthetic@100.64.0.1")
    assert daily.tailscale_host("100.127.255.254")
    assert daily.tailscale_host("synthetic@fd7a:115c:a1e0::1")
    assert not daily.tailscale_host("synthetic@100.128.0.1")
    assert not daily.tailscale_host("synthetic@192.0.2.1")
    assert not daily.tailscale_host("synthetic@backend.example")


def test_tailscale_tool_search_order(tmp_path, monkeypatch):
    def tool(path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n")
        path.chmod(0o755)
        return path

    on_path = tool(tmp_path / "bin/tailscale")
    monkeypatch.setenv("PATH", str(on_path.parent))
    assert daily.find_tailscale() == str(on_path)
    app = tool(tmp_path / "Tailscale.app/Contents/MacOS/Tailscale")
    monkeypatch.setattr(daily, "TAILSCALE_APP", str(app))
    assert daily.find_tailscale() == str(app)
    configured = tool(tmp_path / "configured/tailscale")
    monkeypatch.setattr(daily, "TAILSCALE_CLI", configured)
    assert daily.find_tailscale() == str(configured)
    # A configured tool replaces the search, even when it's missing.
    monkeypatch.setattr(daily, "TAILSCALE_CLI", tmp_path / "missing")
    assert daily.find_tailscale() is None


def test_tunnel_to_tailscale_host_starts_tailscale_first(root, tailscale, monkeypatch):
    fake = tailscale("Stopped")
    (root / "ssh-hosts").write_text(TAILSCALE_HOST + "\n")
    real_popen = subprocess.Popen
    ssh: list[list[str]] = []

    def popen(args, **kwargs):
        if args[0] == "/usr/bin/ssh":
            ssh.append(args)
            return None
        return real_popen(args, **kwargs)

    monkeypatch.setattr(daily.subprocess, "Popen", popen)
    with (root / "log").open("ab") as log:
        daily.start_tunnel(log)
    assert daily._tailscale_woken
    assert fake.ups() == 1
    assert ssh[0][-1] == TAILSCALE_HOST
    log = (root / "log").read_bytes()
    assert log.index(b"running `tailscale up`") < log.index(b"SSH forwarding")


@pytest.mark.parametrize("woken", [False, True])
def test_starting_tailscale_extends_first_wait(root, monkeypatch, helpers, woken):
    monkeypatch.setattr(daily, "READY_WAIT_SECONDS", 0.3)
    monkeypatch.setattr(daily, "WOKEN_WAIT_SECONDS", 2.5)
    started = time.monotonic()
    # The companion never answers, so the helper waits out the whole period.
    helper = run_helper(root, monkeypatch, helpers, authenticated=False, woken=woken)
    assert helper.control.recv(64) == b"ready\n"
    waited = time.monotonic() - started
    if woken:
        assert waited >= 2.5
    else:
        assert waited < 2
    helper.quit()


WAKE_SCRIPT = textwrap.dedent(
    """
    import importlib.util, sys
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("daily", sys.argv[1])
    daily = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(daily)
    daily.ROOT = Path(sys.argv[2])
    daily.TAILSCALE_CLI = Path(sys.argv[3])
    with (daily.ROOT / "log").open("ab") as log:
        print(daily.wake_tailscale("synthetic@100.64.0.1", log))
    """
)


@pytest.mark.parametrize("python", system_pythons())
def test_tailscale_check_runs_under_system_python(root, tmp_path, python):
    fake = FakeTailscale(tmp_path / "fake-tailscale", "Stopped")
    result = subprocess.run(
        [python, "-I", "-c", WAKE_SCRIPT, daily.__file__, str(root), str(fake.path)],
        capture_output=True,
        timeout=30,
        check=True,
    )
    assert result.stdout == b"True\n"
    assert fake.ups() == 1
