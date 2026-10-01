"""Download the pinned upstream wheel without using an installed Anki app."""

import hashlib
import json
import platform
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
WHEELS = {
    ("darwin", "arm64"): (
        "macosx_12_0_arm64",
        "99e7d706ff21c7feeb81b94c87e5539e91167fec8d4c5da387e17fe010df6062",
    ),
    ("darwin", "x86_64"): (
        "macosx_12_0_x86_64",
        "a55f3fe495e39aa208982b0bf5f08f0bab13f4a55f4003c7ef83fc3009f7f257",
    ),
    ("linux", "aarch64"): (
        "manylinux_2_35_aarch64",
        "d994c996dcb5a619049291d829500f5bb0bbae5fe36058f1d43daadd59b5b804",
    ),
    ("linux", "x86_64"): (
        "manylinux_2_35_x86_64",
        "7b3dcb6c9e06e8087ed66bb70f35356e5c60686f51e3bde25f6328433072132f",
    ),
    ("win32", "amd64"): (
        "win_amd64",
        "0ef53cf0da16df057041e412aaad0bf049f036867bb5d8185add1de159099800",
    ),
    ("win32", "arm64"): (
        "win_arm64",
        "7b4cb3b75154f44e603292eccb61af3725dca7f19d7b49d95be7fd0d599097a2",
    ),
}


def extract_upstream(destination: Path) -> None:
    tag, expected = WHEELS[(sys.platform, platform.machine().lower())]
    filename = f"anki-26.9.3-cp310-abi3-{tag}.whl"
    cache = ROOT / "out/learnrecur/upstream-wheels"
    cache.mkdir(parents=True, exist_ok=True)
    wheel = cache / filename
    if not wheel.exists():
        with urlopen("https://pypi.org/pypi/anki/26.9.3/json", timeout=30) as response:
            metadata = json.load(response)
        entry = next(
            entry for entry in metadata["urls"] if entry["filename"] == filename
        )
        assert entry["digests"]["sha256"] == expected
        url = urlsplit(entry["url"])
        assert url.scheme == "https" and url.hostname == "files.pythonhosted.org"
        with urlopen(entry["url"], timeout=30) as response:
            data = response.read(20 * 1024 * 1024 + 1)
        assert len(data) <= 20 * 1024 * 1024
        assert hashlib.sha256(data).hexdigest() == expected
        temporary = wheel.with_suffix(".download")
        temporary.write_bytes(data)
        temporary.replace(wheel)
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == expected
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(destination)
