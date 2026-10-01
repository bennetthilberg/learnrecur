"""Finish native sync after a read-only skill check, including conflicts."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aqt import learnrecur_sync as ui


@pytest.mark.parametrize("conflict", [False, True])
def test_sync_finishes_after_validation_without_mutating_collection(
    monkeypatch, conflict
):
    query = MagicMock()
    factory = MagicMock(return_value=query)
    done = MagicMock()
    warning = MagicMock()
    mw = SimpleNamespace(col=object())
    monkeypatch.setattr(ui, "QueryOp", factory)
    monkeypatch.setattr(ui, "showWarning", warning)
    ui.finish_skill_sync(mw, done)
    arguments = factory.call_args.kwargs
    assert arguments["op"] is ui.validate_skill_links
    assert arguments["parent"] is mw
    if conflict:
        query.failure.call_args.args[0](ValueError("Duplicate skill cards"))
        warning.assert_called_once_with("Duplicate skill cards", parent=mw)
    else:
        arguments["success"](None)
        warning.assert_not_called()
    done.assert_called_once_with()
    query.failure.return_value.run_in_background.assert_called_once_with()
