# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import aqt
from anki.collection import GithubRelease
from aqt.learnrecur import DATA_MARKER, DATA_VERSION, ensure_data_folder
from aqt.package import download_github_update_and_install
from aqt.profiles import ProfileManager
from aqt.sync import sync_login
from aqt.update import (
    check_for_update,
    get_latest_release_op,
    prompt_and_install_github_update,
    prompt_to_update,
)


def test_default_storage_ignores_anki_settings(tmp_path, monkeypatch):
    personal = tmp_path / "personal-review"
    personal.mkdir()
    prefs = personal / "prefs21.db"
    prefs.write_bytes(b"synthetic Anki preferences")
    monkeypatch.setenv("ANKI_BASE", str(personal))
    monkeypatch.delenv("LEARNRECUR_BASE", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr("aqt.learnrecur.sys", SimpleNamespace(platform="darwin"))

    base = ProfileManager.get_created_base_folder(None)

    assert base == tmp_path / "Library/Application Support/LearnRecur"
    assert (base / DATA_MARKER).read_text() == DATA_VERSION
    assert not (base / "prefs21.db").exists()
    assert prefs.read_bytes() == b"synthetic Anki preferences"


def test_separate_folder_reopens_its_own_data(tmp_path, monkeypatch):
    base = tmp_path / "test-profile"
    monkeypatch.setenv("LEARNRECUR_BASE", str(base))
    assert ensure_data_folder() == base
    prefs = base / "prefs21.db"
    prefs.write_bytes(b"LearnRecur preferences")

    assert ensure_data_folder() == base
    assert prefs.read_bytes() == b"LearnRecur preferences"


@pytest.mark.parametrize(
    "source", ["Anki2", "anki2", ".anki", "Anki", "custom-profile"]
)
def test_existing_anki_folder_is_rejected_without_changing_it(tmp_path, source):
    personal = tmp_path / source
    personal.mkdir()
    prefs = personal / "prefs21.db"
    prefs.write_bytes(b"synthetic Anki preferences")

    with pytest.raises(ValueError):
        ProfileManager.get_created_base_folder(str(personal))

    assert list(personal.iterdir()) == [prefs]
    assert prefs.read_bytes() == b"synthetic Anki preferences"


def test_anki_folder_cannot_be_used_through_symlink(tmp_path):
    personal = tmp_path / "Anki2"
    personal.mkdir()
    alias = tmp_path / "review"
    alias.symlink_to(personal, target_is_directory=True)

    with pytest.raises(ValueError, match="Anki data folder"):
        ensure_data_folder(str(alias))

    assert not list(personal.iterdir())


@pytest.mark.parametrize(
    "target", ["profile", "collection", "media", "prefs", "addons"]
)
def test_storage_cannot_follow_links_outside_its_folder(tmp_path, target):
    base = ensure_data_folder(str(tmp_path / "learnrecur"))
    pm = ProfileManager(base)
    pm.name = "test"
    profile = base / "test"
    profile.mkdir()
    outside = tmp_path / "personal-review"
    outside.mkdir()
    paths = {
        "profile": profile,
        "collection": profile / "collection.anki2",
        "media": profile / "collection.media",
        "prefs": base / "prefs21.db",
        "addons": base / "addons21",
    }
    link = paths[target]
    if link.is_dir():
        link.rmdir()
    link.symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="inside its own folder"):
        if target == "prefs":
            pm.setupMeta()
        elif target == "addons":
            pm.addonFolder()
        else:
            pm.collectionPath()

    assert not list(outside.iterdir())


def test_upstream_updates_cannot_download_or_install(monkeypatch):
    mw = MagicMock()
    monkeypatch.setattr(aqt, "mw", mw)
    check_for_update()
    mw.backend.check_for_update.assert_not_called()
    mw.pm.meta = {"check_for_updates": True}
    assert not ProfileManager.check_for_updates(mw.pm)

    release = GithubRelease(tag_name="99.0", filename="Anki.dmg")
    for operation in (
        lambda: prompt_to_update(mw, "99.0"),
        lambda: prompt_and_install_github_update(mw, release),
        lambda: download_github_update_and_install(release),
        lambda: get_latest_release_op(mw, False, MagicMock()),
    ):
        with pytest.raises(RuntimeError, match="LearnRecur"):
            operation()


def test_sync_requires_a_separate_server(monkeypatch):
    mw = MagicMock()
    mw.pm.custom_sync_url.return_value = None
    mw.pm.profile = {"syncKey": "synthetic-old-key"}
    warning = MagicMock()
    monkeypatch.setattr("aqt.sync.showWarning", warning)

    assert ProfileManager.sync_auth(mw.pm) is None
    sync_login(mw, MagicMock())

    mw.col.sync_login.assert_not_called()
    mw.taskman.with_progress.assert_not_called()
    warning.assert_called_once()
