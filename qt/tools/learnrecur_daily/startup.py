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

The helper keeps `launcher.lock` and `launcher.log` there, and the app writes
`desktop.pid` and its own output to `app.log`.
"""

from __future__ import annotations

import fcntl
import http.client
import json
import os
import select
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

# Set by configure() from the bundle's settings file.
ROOT: Path = Path()
SSH_KEY: Path = Path()
KNOWN_HOSTS: Path = Path()
PORTS: tuple[int, int] = DEFAULT_PORTS

_host_index = 0
_started_at = 0.0


def configure(path: Path = SETTINGS) -> None:
    """Read the configuration directory, SSH files, and ports from the settings file."""
    global ROOT, SSH_KEY, KNOWN_HOSTS, PORTS
    data = json.loads(path.read_text())
    paths = [Path(data[key]) for key in ("config_dir", "ssh_key", "known_hosts")]
    if not all(item.is_absolute() for item in paths):
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


def occupied() -> bool:
    result = []
    for port in PORTS:
        with socket.socket() as connection:
            result.append(connection.connect_ex(("127.0.0.1", port)) == 0)
    return any(result)


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


def start_tunnel(log: IO[bytes]) -> subprocess.Popen | None:
    global _host_index, _started_at
    hosts = ssh_hosts()
    if not hosts:
        log.write(b"LearnRecur has no SSH hosts in ssh-hosts.\n")
        log.flush()
        return None
    if _started_at and time.monotonic() - _started_at < STABLE_SECONDS:
        _host_index += 1
    host = hosts[_host_index % len(hosts)]
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
            if existing and not connected():
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
                until = time.monotonic() + 6
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
        parent.settimeout(15)
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
        sys.argv = [sys.argv[0], "-b", str(base), "-p", profile, *sys.argv[1:]]
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


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--supervise":
        raise SystemExit("Launch the LearnRecur Daily app.")
    configure()
    control = socket.socket(fileno=int(sys.argv[2]))
    with control, (ROOT / "launcher.log").open("ab") as log:
        supervise(control, log)
