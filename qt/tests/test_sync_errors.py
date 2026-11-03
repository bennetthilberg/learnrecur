"""Sync errors remain visible before profile closing continues."""

from concurrent.futures import Future
from unittest.mock import MagicMock

import pytest

import anki.lang
from anki.errors import Interrupted, NetworkError, SyncError, SyncErrorKind
from anki.sync import SyncOutput
from aqt import dialogs, gui_hooks, sync
from aqt.mediasync import MediaSyncer
from aqt.qt import QApplication, QMessageBox, QWidget


@pytest.fixture
def app():
    anki.lang.set_lang("en_US")
    return QApplication.instance() or QApplication([])


@pytest.fixture
def mw(app):
    window = QWidget()
    window.pm = MagicMock()
    window.col = MagicMock()
    window.taskman = MagicMock()
    window.media_syncer = MagicMock()
    window.toolbar = MagicMock()
    window.reopen = MagicMock()
    window.reset = MagicMock()
    yield window
    window.close()
    window.deleteLater()
    app.processEvents()


@pytest.mark.parametrize("dismiss", ["ok", "escape", "close"])
def test_error_waits_for_acknowledgment(app, mw, dismiss):
    done = MagicMock()
    # The main window is disabled while a profile closes.
    mw.setEnabled(False)
    sync.handle_sync_error(mw, RuntimeError("Sync server unavailable"), done)
    app.processEvents()
    warning = mw.findChild(QMessageBox)
    assert warning.isVisible()
    assert warning.text() == "Sync server unavailable"
    done.assert_not_called()
    if dismiss == "ok":
        assert warning.buttons()[0].isEnabled()
        warning.buttons()[0].click()
    elif dismiss == "escape":
        warning.reject()
    else:
        warning.close()
    app.processEvents()
    assert not warning.isVisible()
    done.assert_called_once_with()


def test_auth_error_still_clears_credentials_before_acknowledgment(mw):
    done = MagicMock()
    error = SyncError("Sign in again", None, None, None, SyncErrorKind.AUTH)
    sync.handle_sync_error(mw, error, done)
    mw.pm.clear_sync_auth.assert_called_once_with()
    done.assert_not_called()
    mw.findChild(QMessageBox).accept()
    done.assert_called_once_with()


NETWORK_DETAILS = (
    "A network error occurred.\nError details: error sending request for url ()"
)


def test_network_error_says_what_to_do_and_logs_details(app, mw, capsys):
    done = MagicMock()
    error = NetworkError(NETWORK_DETAILS, None, None, None)
    sync.handle_sync_error(mw, error, done)
    warning = mw.findChild(QMessageBox)
    assert warning.text() == (
        "Couldn't reach your sync server. Your reviews are saved on this Mac. "
        "Check your connection, then press Sync."
    )
    assert "error sending request" in capsys.readouterr().out
    done.assert_not_called()
    warning.accept()
    done.assert_called_once_with()


@pytest.mark.parametrize(
    "kind", [SyncErrorKind.AUTH, SyncErrorKind.OTHER], ids=["auth", "other"]
)
def test_other_sync_errors_keep_their_message(mw, kind):
    error = SyncError("Server says no", None, None, None, kind)
    sync.handle_sync_error(mw, error, MagicMock())
    assert mw.findChild(QMessageBox).text() == "Server says no"


@pytest.mark.parametrize(
    "message",
    [
        "Your proxy requires authentication.",
        "A network error occurred.\n\nError details: Please force a one-way sync in the "
        "Preferences screen to bring your devices into sync. invalid type: map",
        "A network error occurred.\n\nError details: 500 Internal Server Error",
    ],
    ids=["proxy-auth", "invalid-response", "server-error"],
)
def test_network_errors_with_their_own_steps_keep_their_message(mw, message):
    sync.handle_sync_error(mw, NetworkError(message, None, None, None), MagicMock())
    assert mw.findChild(QMessageBox).text() == message


@pytest.mark.parametrize(
    "message",
    [
        "Please check your internet connection.\n\nError details: dns error",
        "Connection timed out. Please try again. If you see frequent timeouts, "
        "please try a different network connection.",
    ],
    ids=["offline", "timeout"],
)
def test_offline_and_timeout_say_what_to_do(mw, message):
    sync.handle_sync_error(mw, NetworkError(message, None, None, None), MagicMock())
    assert mw.findChild(QMessageBox).text() == sync.SYNC_SERVER_UNREACHABLE


def test_media_network_error_says_what_to_do(mw, media):
    media._handle_sync_error(NetworkError(NETWORK_DETAILS, None, None, None))
    (dialog,) = media._error_dialogs
    assert dialog.text() == sync.SYNC_SERVER_UNREACHABLE


def test_cancel_finishes_without_a_warning(mw):
    done = MagicMock()
    sync.handle_sync_error(mw, Interrupted("Cancelled", None, None, None), done)
    assert mw.findChild(QMessageBox) is None
    done.assert_called_once_with()


@pytest.mark.parametrize(
    "operation", ["sync_collection", "full_upload", "full_download"]
)
@pytest.mark.parametrize("failed", [False, True])
def test_sync_continuation_runs_once_after_error_or_success(
    monkeypatch, mw, operation, failed
):
    monkeypatch.setattr(sync, "tooltip", MagicMock())
    done = MagicMock()
    if operation == "sync_collection":
        sync.sync_collection(mw, done)
    else:
        getattr(sync, operation)(mw, None, done)
    callback = mw.taskman.with_progress.call_args.args[1]
    future = Future()
    if failed:
        future.set_exception(RuntimeError("Connection lost"))
    else:
        future.set_result(SyncOutput(required=SyncOutput.NO_CHANGES))
    callback(future)
    if failed:
        done.assert_not_called()
        mw.media_syncer.start_monitoring.assert_not_called()
        mw.findChild(QMessageBox).accept()
    done.assert_called_once_with()
    if not failed or operation == "full_download":
        mw.media_syncer.start_monitoring.assert_called_once_with()
    else:
        mw.media_syncer.start_monitoring.assert_not_called()
    if operation != "sync_collection":
        mw.reopen.assert_called_once_with(after_full_sync=True)


@pytest.fixture
def media(mw):
    syncer = MediaSyncer(mw)
    syncer._update_progress = MagicMock()
    yield syncer
    gui_hooks.media_sync_did_start_or_stop.remove(syncer._on_start_stop)


@pytest.mark.parametrize("during_sync", [False, True])
def test_media_error_also_delays_closing(monkeypatch, mw, media, during_sync):
    done = MagicMock()
    mw.setEnabled(False)
    monkeypatch.setattr(dialogs, "open", MagicMock())
    if during_sync:
        mw.progress = MagicMock()
        media._syncing = True
        media.show_diag_until_finished(done)
        check_finished = mw.progress.timer.call_args.args[1]
        future = Future()
        future.set_exception(RuntimeError("Media connection lost"))
        media._on_finished(future)
        check_finished()
    else:
        media._handle_sync_error(RuntimeError("Media connection lost"))
        media.show_diag_until_finished(done)
    done.assert_not_called()
    warning = mw.findChild(QMessageBox)
    assert warning.buttons()[0].isEnabled()
    warning.buttons()[0].click()
    done.assert_called_once_with()
    assert not media._error_dialogs


def test_multiple_media_errors_must_all_be_dismissed(mw, media):
    done = MagicMock()
    for _ in range(2):
        media._handle_sync_error(RuntimeError("Media connection lost"))
    media.show_diag_until_finished(done)
    first, second = list(media._error_dialogs)
    first.accept()
    done.assert_not_called()
    second.accept()
    done.assert_called_once_with()


@pytest.mark.parametrize("cancelled", [False, True])
def test_periodic_media_errors_and_cancellation_do_not_delay_close(
    mw, media, cancelled
):
    done = MagicMock()
    error = (
        Interrupted("Cancelled", None, None, None)
        if cancelled
        else RuntimeError("Offline")
    )
    media._handle_sync_error(error, is_periodic_sync=True)
    media.show_diag_until_finished(done)
    assert mw.findChild(QMessageBox) is None
    done.assert_called_once_with()
