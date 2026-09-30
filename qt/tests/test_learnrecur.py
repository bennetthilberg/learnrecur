# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import requests

import anki.lang
import aqt
from anki.collection import Collection, GithubRelease
from anki.db import DB
from aqt.learnrecur import DATA_MARKER, DATA_VERSION, ensure_data_folder
from aqt.main import AnkiQt
from aqt.package import download_github_update_and_install
from aqt.profiles import ProfileManager
from aqt.qt import QApplication, QDialog, QDialogButtonBox, QLabel, QLineEdit, QWidget
from aqt.sync import get_id_and_pass_from_user, sync_login
from aqt.update import (
    check_for_update,
    check_system_clock,
    clock_offset,
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


@pytest.mark.parametrize(
    "target",
    [
        "profile",
        "collection.anki2",
        "collection.anki2-journal",
        "collection.anki2-wal",
        "collection.anki2-shm",
        "collection.media.db2",
    ],
)
def test_downgrade_rejects_external_storage_before_opening(
    tmp_path, monkeypatch, target
):
    base = ensure_data_folder(str(tmp_path / "learnrecur"))
    pm = ProfileManager(base)
    profile = base / "test"
    profile.mkdir()
    outside = tmp_path / "personal-review"
    outside.mkdir()
    collection = outside / "collection.anki2"
    collection.write_bytes(b"synthetic external collection")
    if target == "profile":
        profile.rmdir()
        profile.symlink_to(outside, target_is_directory=True)
    else:
        (profile / target).symlink_to(collection)
    database = MagicMock()
    backend = MagicMock()
    monkeypatch.setattr("aqt.profiles.DB", database)
    monkeypatch.setattr("aqt.profiles.Collection", backend)

    assert pm.downgrade(["test"]) == ["test"]

    database.assert_not_called()
    backend.assert_not_called()
    assert collection.read_bytes() == b"synthetic external collection"
    assert sorted(path.name for path in outside.iterdir()) == ["collection.anki2"]


def test_downgrade_still_converts_owned_collection(tmp_path):
    base = ensure_data_folder(str(tmp_path / "learnrecur"))
    pm = ProfileManager(base)
    pm.name = "test"
    path = pm.collectionPath()
    collection = Collection(path)
    collection.close()

    assert pm.downgrade(["test", "missing"]) == []
    with DB(path) as database:
        assert database.scalar("select ver from col") == 11
    assert not (base / "missing").exists()


def test_custom_server_dialog_uses_server_credentials():
    anki.lang.set_lang("en_US")
    app = QApplication.instance() or QApplication([])
    parent = QWidget()
    callback = MagicMock()
    get_id_and_pass_from_user(parent, callback, "server-user", "server-password")
    dialog = parent.findChild(QDialog)
    labels = [
        anki.lang.without_unicode_isolation(label.text())
        for label in dialog.findChildren(QLabel)
    ]
    assert labels == [
        "Sign in with your LearnRecur sync server account.",
        "Username",
        "Password:",
    ]
    assert not any("ankiweb" in label.lower() or "href=" in label for label in labels)
    fields = dialog.findChildren(QLineEdit)
    assert fields[1].echoMode() == QLineEdit.EchoMode.Password
    dialog.findChild(QDialogButtonBox).button(
        QDialogButtonBox.StandardButton.Ok
    ).click()
    callback.assert_called_once_with("server-user", "server-password")
    dialog.deleteLater()
    app.processEvents()


def test_startup_checks_clock_with_updates_disabled(monkeypatch):
    clock_check = MagicMock()
    update_check = MagicMock()
    monkeypatch.setattr("aqt.update.check_system_clock", clock_check)
    monkeypatch.setattr("aqt.update.check_for_update", update_check)
    mw = SimpleNamespace(pm=SimpleNamespace(check_for_updates=lambda: False))

    AnkiQt.setup_auto_update(mw, [])

    clock_check.assert_called_once_with(mw)
    update_check.assert_not_called()


def mock_clock_response(monkeypatch, headers=None, status=200):
    response = MagicMock()
    response.__enter__.return_value = response
    response.status_code = status
    response.headers = headers or {"Date": "Wed, 30 Sep 2026 20:00:00 GMT"}
    request = MagicMock(return_value=response)
    monkeypatch.setattr("aqt.update.requests.head", request)
    monkeypatch.setattr("aqt.update.time.monotonic", MagicMock(side_effect=[10, 12]))
    return request


@pytest.mark.parametrize("skew", [-600, 0, 600])
def test_clock_check_uses_verified_https_without_profile_data(monkeypatch, skew):
    request = mock_clock_response(monkeypatch)
    monkeypatch.setattr("aqt.update.time.time", lambda: 1790798400 + skew)

    assert clock_offset() == max(0, abs(skew) - 3)
    request.assert_called_once_with(
        "https://www.cloudflare.com/",
        headers={"Cache-Control": "no-cache"},
        timeout=5,
        allow_redirects=False,
        verify=True,
    )


def test_clock_check_accounts_for_cached_response_age(monkeypatch):
    mock_clock_response(
        monkeypatch, {"Date": "Wed, 30 Sep 2026 20:00:00 GMT", "Age": "600"}
    )
    monkeypatch.setattr("aqt.update.time.time", lambda: 1790799000)

    assert clock_offset() == 0


@pytest.mark.parametrize(
    "headers,status",
    [
        ({"Date": "invalid"}, 200),
        ({"Date": "Wed, 30 Sep 2026 20:00:00"}, 200),
        ({"Date": "Wed, 30 Sep 2026 20:00:00 GMT", "Age": "-1"}, 200),
        ({"Date": "Wed, 30 Sep 2026 20:00:00 GMT", "Age": "invalid"}, 200),
        ({"Date": "Wed, 30 Sep 2026 20:00:00 GMT"}, 302),
    ],
)
def test_clock_check_rejects_unusable_responses(monkeypatch, headers, status):
    mock_clock_response(monkeypatch, headers, status)
    with pytest.raises(ValueError):
        clock_offset()


@pytest.mark.parametrize("difference", [0, 300, 301])
def test_clock_warning_closes_app_only_for_excessive_skew(monkeypatch, difference):
    anki.lang.set_lang("en_US")
    query = MagicMock()
    query.failure.return_value = query
    query.without_collection.return_value = query
    operation = MagicMock(return_value=query)
    warning = MagicMock()
    mw = MagicMock()
    monkeypatch.setattr("aqt.update.QueryOp", operation)
    monkeypatch.setattr("aqt.update.show_warning", warning)
    monkeypatch.setattr("aqt.update.clock_offset", lambda: difference)

    check_system_clock(mw)
    assert operation.call_args.kwargs["op"](None) == difference
    operation.call_args.kwargs["success"](difference)

    query.without_collection.assert_called_once()
    query.run_in_background.assert_called_once()
    if difference > 300:
        warning.assert_called_once()
        warning.call_args.kwargs["callback"]()
        mw.app.closeAllWindows.assert_called_once()
    else:
        warning.assert_not_called()


def test_unavailable_clock_source_allows_offline_use(monkeypatch):
    query = MagicMock()
    query.failure.return_value = query
    query.without_collection.return_value = query
    monkeypatch.setattr("aqt.update.QueryOp", MagicMock(return_value=query))
    warning = MagicMock()
    monkeypatch.setattr("aqt.update.show_warning", warning)
    mw = MagicMock()

    check_system_clock(mw)
    query.failure.call_args.args[0](requests.Timeout())

    warning.assert_not_called()
    mw.app.closeAllWindows.assert_not_called()
