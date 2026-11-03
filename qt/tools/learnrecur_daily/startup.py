"""Open the Daily profile and connect it to the backend before Qt starts.

The Daily installer copies this file into the app bundle as `learnrecur_daily.py`,
next to `learnrecur_daily.json`, which names a private configuration directory
outside the bundle. The app imports this module before Qt starts. The same file
also runs under the system Python as a small helper that owns the SSH process
forwarding the sync and companion ports to the backend. Keep it compatible with
Python 3.9 and the standard library, since `/usr/bin/python3` runs it.

The configuration directory contains:

- `ssh-hosts`: SSH destinations, one per line, tried in order. Lines starting
  with `#` are comments. Without any hosts, the app works offline.
- `companion-token`: the companion's bearer token.
- `profile-ready.json`: the profile folder (`profile`) and companion source ID
  (`source_id`).
- `desktop/`: the LearnRecur base folder, with its `.learnrecur-data` marker.

The helper keeps `launcher.lock`, `launcher.log`, and `tailscale-up.last` there,
and the app writes `desktop.pid` and its own output to `app.log`. A running app
holds a shared lock on `install.lock`, and the installer takes it exclusively, so
neither can start while the other is running.

Before connecting to a Tailscale address, the helper checks whether the Mac's
Tailscale client is stopped and, if so, runs a plain `tailscale up`. The
settings file can name the Tailscale tool as `tailscale_cli`; otherwise the
helper uses the Mac app's binary or `tailscale` on PATH.
"""

from __future__ import annotations

import fcntl
import http.client
import ipaddress
import json
import os
import select
import shutil
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Iterator

SETTINGS = Path(__file__).resolve().with_suffix(".json")
HELPER_PYTHON = "/usr/bin/python3"
# Local sync and companion ports, and the backend ports they forward to.
DEFAULT_PORTS = (45351, 45352)
REMOTE_PORTS = (45331, 45321)
# A tunnel that lasted this long counts as working; reconnect to the same host.
STABLE_SECONDS = 30
# Keep app.log and one older app.log.1, each about this size.
APP_LOG_LIMIT = 2 * 1024 * 1024
APP_LOG_CHECK_SECONDS = 30
STORAGE_MARKER = "learnrecur-data-v1\n"
INSTALL_LOCK = "install.lock"
# How long the helper waits for the companion before telling the app it's ready,
# and the longer wait after it had to start Tailscale.
READY_WAIT_SECONDS = 6.0
WOKEN_WAIT_SECONDS = 15.0
# The Mac app's command-line tool, used when the settings don't name one.
TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
TAILSCALE_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
)
TAILSCALE_STATUS_TIMEOUT = 3.0
TAILSCALE_UP_TIMEOUT = 15.0
# Run `tailscale up` at most once in this many seconds, across launches.
TAILSCALE_UP_INTERVAL = 60.0

# Set by configure() from the bundle's settings file.
ROOT: Path = Path()
SSH_KEY: Path = Path()
KNOWN_HOSTS: Path = Path()
PORTS: tuple[int, int] = DEFAULT_PORTS
TAILSCALE_CLI: Path | None = None

_host_index = 0
_started_at = 0.0
# Whether the latest start_tunnel() call had to start Tailscale first.
_tailscale_woken = False
_tailscale_health: list = []


def configure(path: Path = SETTINGS) -> None:
    """Read the directories, SSH files, ports, and Tailscale tool from the settings."""
    global ROOT, SSH_KEY, KNOWN_HOSTS, PORTS, TAILSCALE_CLI
    data = json.loads(path.read_text())
    paths = [Path(data[key]) for key in ("config_dir", "ssh_key", "known_hosts")]
    tailscale = Path(data["tailscale_cli"]) if "tailscale_cli" in data else None
    if not all(item.is_absolute() for item in [*paths, tailscale or Path("/")]):
        raise ValueError("Daily settings need absolute paths.")
    ports = tuple(int(port) for port in data.get("local_ports", DEFAULT_PORTS))
    if (
        len(ports) != 2
        or ports[0] == ports[1]
        or not all(1024 < port < 65536 for port in ports)
    ):
        raise ValueError("Daily settings need two different local ports.")
    ROOT, SSH_KEY, KNOWN_HOSTS = paths
    PORTS = (ports[0], ports[1])
    TAILSCALE_CLI = tailscale


def ports_open() -> list[bool]:
    result = []
    for port in PORTS:
        with socket.socket() as connection:
            result.append(connection.connect_ex(("127.0.0.1", port)) == 0)
    return result


def occupied() -> bool:
    return any(ports_open())


def fully_occupied() -> bool:
    return all(ports_open())


def sync_reachable() -> bool:
    """Check that the sync port answers like the sync server's health endpoint."""
    connection = http.client.HTTPConnection("127.0.0.1", PORTS[0], timeout=1)
    try:
        connection.request("GET", "/health")
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def reusable() -> bool:
    """Reuse existing forwarding only when both ports reach our own services."""
    return fully_occupied() and connected() and sync_reachable()


def connected() -> bool:
    """Check that the companion port reaches our own companion, not another service."""
    expected = json.loads((ROOT / "profile-ready.json").read_text())["source_id"]
    token = (ROOT / "companion-token").read_text().strip()
    connection = http.client.HTTPConnection("127.0.0.1", PORTS[1], timeout=1)
    try:
        connection.request(
            "GET",
            "/v1/generation-history?limit=1",
            headers={"Authorization": "Bearer " + token},
        )
        response = connection.getresponse()
        return (
            response.status == 200
            and json.loads(response.read(1024 * 1024))["source_id"] == expected
        )
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def ssh_hosts() -> list[str]:
    """Read SSH destinations in preference order, such as Tailscale, then public."""
    try:
        lines = (ROOT / "ssh-hosts").read_text().splitlines()
    except FileNotFoundError:
        return []
    return [
        line.strip()
        for line in lines
        if line.strip() and not line.lstrip().startswith("#")
    ]


def _log(log: IO[bytes], message: str) -> None:
    log.write(("LearnRecur " + message + "\n").encode())
    log.flush()


def tailscale_host(host: str) -> bool:
    """Check whether an SSH destination like `user@100.64.0.1` is a Tailscale address."""
    try:
        address = ipaddress.ip_address(host.rpartition("@")[2])
    except ValueError:
        return False
    return any(address in network for network in TAILSCALE_NETWORKS)


def find_tailscale() -> str | None:
    """Find the Tailscale command-line tool: the configured one, or the Mac app's,
    or one on PATH."""
    if TAILSCALE_CLI is not None:
        candidates = [str(TAILSCALE_CLI)]
    else:
        candidates = [TAILSCALE_APP, shutil.which("tailscale") or ""]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def run_tailscale(
    cli: str, arguments: list[str], timeout: float
) -> subprocess.CompletedProcess:
    # The Mac app's binary acts as the command-line tool only when told to, since
    # this helper doesn't run in a terminal.
    return subprocess.run(
        [cli, *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=dict(os.environ, TAILSCALE_BE_CLI="true"),
        check=False,
    )


def tailscale_status(cli: str) -> dict | None:
    try:
        result = run_tailscale(cli, ["status", "--json"], TAILSCALE_STATUS_TIMEOUT)
        status = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return status if isinstance(status, dict) else None


def _claim_tailscale_up() -> bool:
    """Record a `tailscale up` attempt unless one ran in the last minute."""
    path = ROOT / "tailscale-up.last"
    now = time.time()
    try:
        last = float(path.read_text())
    except (OSError, ValueError):
        last = None
    if last is not None and 0 <= now - last < TAILSCALE_UP_INTERVAL:
        return False
    try:
        path.write_text("%f\n" % now)
    except OSError:
        return False
    return True


def wake_tailscale(host: str, log: IO[bytes]) -> bool:
    """Start Tailscale before connecting to a Tailscale host, if it's stopped.

    This runs a plain `tailscale up`, without sudo or flags, at most once a
    minute. It never touches Tailscale when it's running or in another state, and
    it does nothing if the tool is missing or fails. Returns whether it started
    Tailscale.
    """
    global _tailscale_health
    if not tailscale_host(host):
        return False
    cli = find_tailscale()
    if cli is None:
        return False
    status = tailscale_status(cli)
    if status is None:
        _log(log, "couldn't read Tailscale's status.")
        return False
    state = status.get("BackendState")
    if state == "Running":
        # A stuck client can still say Running. Quitting and reopening the
        # Tailscale app fixes that, which is too invasive to do automatically.
        health = status.get("Health") or []
        if health and health != _tailscale_health:
            _log(
                log,
                "found Tailscale running with warnings: %s"
                % "; ".join(str(item) for item in health),
            )
        _tailscale_health = health
        return False
    if state != "Stopped":
        _log(log, "found Tailscale in state %s; leaving it alone." % state)
        return False
    if not _claim_tailscale_up():
        _log(
            log,
            "found Tailscale stopped, but ran `tailscale up` less than a minute ago.",
        )
        return False
    _log(log, "found Tailscale stopped; running `tailscale up`.")
    try:
        result = run_tailscale(cli, ["up"], TAILSCALE_UP_TIMEOUT)
    except subprocess.TimeoutExpired:
        _log(log, "`tailscale up` didn't finish in %d seconds." % TAILSCALE_UP_TIMEOUT)
        return False
    except (OSError, subprocess.SubprocessError) as err:
        _log(log, "couldn't run `tailscale up`: %s" % err)
        return False
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).decode(errors="replace").strip()
        _log(
            log,
            "`tailscale up` failed with exit code %d: %s"
            % (result.returncode, detail[-500:]),
        )
        return False
    status = tailscale_status(cli) or {}
    _log(log, "started Tailscale; it's now %s." % status.get("BackendState", "unknown"))
    return True


def start_tunnel(log: IO[bytes]) -> subprocess.Popen | None:
    global _host_index, _started_at, _tailscale_woken
    _tailscale_woken = False
    hosts = ssh_hosts()
    if not hosts:
        log.write(b"LearnRecur has no SSH hosts in ssh-hosts.\n")
        log.flush()
        return None
    if _started_at and time.monotonic() - _started_at < STABLE_SECONDS:
        _host_index += 1
    host = hosts[_host_index % len(hosts)]
    _tailscale_woken = wake_tailscale(host, log)
    _started_at = time.monotonic()
    log.write(("LearnRecur SSH forwarding through %s.\n" % host).encode())
    log.flush()
    forwards = []
    for local, remote in zip(PORTS, REMOTE_PORTS):
        forwards += ["-L", "127.0.0.1:%d:127.0.0.1:%d" % (local, remote)]
    return subprocess.Popen(
        [
            "/usr/bin/ssh",
            "-i",
            str(SSH_KEY),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "UserKnownHostsFile=" + str(KNOWN_HOSTS),
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-N",
            *forwards,
            host,
        ],
        stdout=log,
        stderr=log,
    )


def supervise(control: socket.socket, log: IO[bytes]) -> None:
    """Own only our SSH child; EOF means the app quit or crashed."""
    tunnel = None
    with (ROOT / "launcher.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            control.sendall(b"existing\n")
            return
        try:
            existing = occupied()
            if existing and not reusable():
                control.sendall(b"error\n")
                return
            offline = not existing and not ssh_hosts()
            if offline:
                log.write(
                    b"LearnRecur has no SSH hosts in ssh-hosts; working offline.\n"
                )
                log.flush()
            elif not existing:
                tunnel = start_tunnel(log)
                until = time.monotonic() + (
                    WOKEN_WAIT_SECONDS if _tailscale_woken else READY_WAIT_SECONDS
                )
                while tunnel is not None and time.monotonic() < until:
                    if connected() or tunnel.poll() is not None:
                        break
                    if select.select([control], [], [], 0.1)[0] and not control.recv(1):
                        return
            control.sendall(b"ready\n")
            retry_at = 0.0
            while True:
                if select.select([control], [], [], 0.5)[0] and not control.recv(1):
                    return
                if tunnel is not None and tunnel.poll() is not None:
                    tunnel = None
                    retry_at = time.monotonic() + 5
                    log.write(
                        b"LearnRecur SSH forwarding stopped; retrying in five seconds.\n"
                    )
                    log.flush()
                if (
                    not existing
                    and not offline
                    and tunnel is None
                    and time.monotonic() >= retry_at
                ):
                    if not occupied():
                        tunnel = start_tunnel(log)
                    retry_at = time.monotonic() + 5
        finally:
            if tunnel is not None and tunnel.poll() is None:
                tunnel.terminate()
                try:
                    tunnel.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    tunnel.kill()
                    tunnel.wait()


def _point_output_at(path: Path) -> None:
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        for target in (1, 2):
            if descriptor != target:
                os.dup2(descriptor, target)
    finally:
        if descriptor not in (1, 2):
            os.close(descriptor)


def _rotate(path: Path) -> None:
    try:
        os.replace(str(path), str(path.with_name(path.name + ".1")))
    except FileNotFoundError:
        pass


def redirect_output(
    path: Path,
    limit: int = APP_LOG_LIMIT,
    check_seconds: float = APP_LOG_CHECK_SECONDS,
) -> None:
    """Send this process's stdout and stderr to a private log with one older copy.

    This covers Python output and native output from Qt and the Rust backend.
    A background thread moves the log to `.1` once it passes the limit, so the
    two files stay near twice the limit in total.
    """
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            try:
                stream.flush()
            except (OSError, ValueError):
                pass
    if path.exists() and path.stat().st_size >= limit:
        _rotate(path)
    _point_output_at(path)
    # sys.__stdout__ and sys.__stderr__ keep the original streams open.
    sys.stdout, sys.stderr = (
        open(
            descriptor,
            "w",
            buffering=1,
            encoding="utf-8",
            errors="backslashreplace",
            closefd=False,
        )
        for descriptor in (1, 2)
    )
    print(
        "LearnRecur Daily started at %s, process %d."
        % (time.strftime("%Y-%m-%d %H:%M:%S %z"), os.getpid()),
        flush=True,
    )

    def watch() -> None:
        while True:
            time.sleep(check_seconds)
            try:
                if os.fstat(2).st_size >= limit:
                    sys.stdout.flush()
                    sys.stderr.flush()
                    _rotate(path)
                    _point_output_at(path)
            except (OSError, ValueError):
                # Logging problems must not stop the app.
                pass

    threading.Thread(target=watch, name="LearnRecur Daily log", daemon=True).start()


def app_arguments(arguments: list[str], base: Path, profile: str) -> list[str]:
    """Pass through the app's arguments, with Daily storage taking precedence.

    `argparse` keeps the last value of a repeated option, so the fixed storage
    options go last. Mac process serial numbers (`-psn_...`) would otherwise
    parse as a profile name, so they are dropped.
    """
    passed = [arg for arg in arguments if not arg.startswith("-psn")]
    return [*passed, "-b", str(base), "-p", profile]


def hold_install_lock() -> IO[str]:
    """Take a shared lock the app keeps open, so the installer can't run meanwhile."""
    path = ROOT / INSTALL_LOCK
    lock = path.open("a")
    try:
        path.chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError as err:
        lock.close()
        raise RuntimeError(
            "LearnRecur Daily is being updated. Open it again when the update finishes."
        ) from err
    return lock


def profile_name() -> str:
    folder = json.loads((ROOT / "profile-ready.json").read_text())["profile"]
    name = Path(folder).name
    if name in ("", ".", ".."):
        raise ValueError("profile-ready.json doesn't name a profile folder.")
    return name


@contextmanager
def startup() -> Iterator[None]:
    redirect_output(ROOT / "app.log")
    base = ROOT / "desktop"
    if (base / ".learnrecur-data").read_text() != STORAGE_MARKER:
        raise ValueError("Daily LearnRecur storage marker is missing.")
    profile = profile_name()
    for name in list(os.environ):
        if name.startswith(("ANKI_", "OPENAI_")) or name in (
            "QT_ACCESSIBILITY",
            "QTWEBENGINE_CHROMIUM_FLAGS",
        ):
            os.environ.pop(name, None)
    lock = hold_install_lock()
    parent, child = socket.socketpair()
    process = None
    try:
        with (ROOT / "launcher.log").open("ab") as log:
            (ROOT / "launcher.log").chmod(0o600)
            process = subprocess.Popen(
                [
                    HELPER_PYTHON,
                    "-I",
                    str(Path(__file__).resolve()),
                    "--supervise",
                    str(child.fileno()),
                ],
                pass_fds=(child.fileno(),),
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        child.close()
        # Long enough for the helper to start Tailscale and wait for the tunnel.
        parent.settimeout(45)
        with parent.makefile("rb") as status:
            state = status.readline(64).strip()
        if state not in (b"ready", b"existing"):
            raise RuntimeError(
                "Daily connection setup failed. See the private launcher log."
            )
        os.environ.update(
            LEARNRECUR_BASE=str(base),
            LEARNRECUR_COMPANION_URL="http://127.0.0.1:%d" % PORTS[1],
            LEARNRECUR_COMPANION_TOKEN=(ROOT / "companion-token").read_text().strip(),
        )
        sys.argv = [sys.argv[0], *app_arguments(sys.argv[1:], base, profile)]
        if state == b"ready":
            (ROOT / "desktop.pid").write_text(str(os.getpid()))
        yield
    finally:
        child.close()
        parent.close()
        if process is not None:
            try:
                process.wait(timeout=7)
            except subprocess.TimeoutExpired:
                # Do not terminate an unknown process or a tunnel we don't own.
                pass
        lock.close()


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--supervise":
        raise SystemExit("Launch the LearnRecur Daily app.")
    configure()
    control = socket.socket(fileno=int(sys.argv[2]))
    with control, (ROOT / "launcher.log").open("ab") as log:
        supervise(control, log)
