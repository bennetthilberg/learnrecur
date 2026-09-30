"""Keep upstream compatibility checks inside disposable storage."""

from pathlib import Path

import pytest

from tools import prepare_anki_compatibility_app as preparation


@pytest.fixture
def checkout(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "checkout"
    (root / "out/learnrecur").mkdir(parents=True)
    monkeypatch.setattr(preparation, "ROOT", root)
    return root


@pytest.mark.parametrize(
    "suffix", ["out/learnrecur", "out/other", "Anki2", "out/learnrecur/../other/test"]
)
def test_rejects_paths_outside_synthetic_storage(checkout, suffix):
    with pytest.raises(ValueError):
        preparation.synthetic_path(checkout / suffix)


def test_rejects_link_to_existing_profile(checkout, tmp_path):
    existing = tmp_path / "Anki2"
    existing.mkdir()
    sentinel = existing / "prefs21.db"
    sentinel.write_bytes(b"existing profile")
    link = checkout / "out/learnrecur/linked"
    link.symlink_to(existing, target_is_directory=True)
    with pytest.raises(ValueError, match="Symlinks"):
        preparation.synthetic_path(link / "test")
    assert sentinel.read_bytes() == b"existing profile"


def test_rejects_existing_work_directory_before_opening_inputs(checkout, monkeypatch):
    monkeypatch.setattr(preparation.sys, "platform", "darwin")
    work = checkout / "out/learnrecur/existing"
    work.mkdir()
    with pytest.raises(ValueError, match="fresh"):
        preparation.prepare(work / "missing.dmg", work / "missing.apkg", work)


def test_rejects_wrong_release_before_mounting(checkout, monkeypatch):
    monkeypatch.setattr(preparation.sys, "platform", "darwin")
    dmg = checkout / "out/learnrecur/wrong.dmg"
    dmg.write_bytes(b"wrong release")
    work = checkout / "out/learnrecur/new"

    def unexpected_mount(*args, **kwargs):
        pytest.fail("An unverified disk image must not be mounted")

    monkeypatch.setattr(preparation.subprocess, "run", unexpected_mount)
    with pytest.raises(ValueError, match="does not match"):
        preparation.prepare(dmg, dmg.with_suffix(".apkg"), work)
    assert not work.exists()
