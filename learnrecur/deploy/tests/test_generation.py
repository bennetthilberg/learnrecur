"""Keep paid deployment configuration explicit and separate from restored state."""

import json
from unittest.mock import Mock

import pytest

from learnrecur.companion.credentials import save_key
from learnrecur.deploy.manage import Deployment
from learnrecur.deploy.tests.test_backup import state

__all__ = ["state"]


@pytest.fixture
def deployment(state, tmp_path):
    credentials = tmp_path / "credentials"
    credentials.mkdir(mode=0o700)
    result = Deployment(state, credentials, "learnrecur:synthetic")
    save_key(result.openai_key(), "sk-synthetic-secret-for-tests-only")
    result.verify_containers = Mock()
    result.running = Mock(return_value=set())
    return result


def test_fixture_mode_does_not_inherit_openai_environment(deployment, monkeypatch):
    monkeypatch.setenv("LEARNRECUR_GENERATION_PROVIDER", "openai")
    run = Mock(return_value=Mock(stdout=""))
    monkeypatch.setattr("learnrecur.deploy.manage.subprocess.run", run)
    deployment.compose("config")
    assert run.call_args.kwargs["env"]["LEARNRECUR_GENERATION_PROVIDER"] == "fixture"
    assert not any("compose.openai" in arg for arg in run.call_args.args[0])


def test_provider_configuration_persists_without_exposing_the_key(
    deployment, monkeypatch
):
    run = Mock(return_value=Mock(stdout=""))
    monkeypatch.setattr("learnrecur.deploy.manage.subprocess.run", run)
    deployment.configure_openai(1000000)
    config = deployment.credentials / "generation.json"
    assert config.stat().st_mode & 0o777 == 0o600
    assert "sk-" not in config.read_text()
    restarted = Deployment(deployment.state, deployment.credentials, deployment.image)
    restarted.compose("config")
    call = run.call_args
    assert any("compose.openai.yaml" in arg for arg in call.args[0])
    assert call.kwargs["env"]["LEARNRECUR_GENERATION_LIMIT"] == "1000000"
    assert call.kwargs["env"]["LEARNRECUR_GENERATION_PROVIDER"] == "openai"
    assert "sk-" not in str(call)


@pytest.mark.parametrize(
    "reason",
    ["running", "restore", "paid_restore", "public_key", "over_budget", "no_budget"],
)
def test_unsafe_enablement_leaves_configuration_absent(deployment, reason):
    limit = 1000000
    if reason == "running":
        deployment.running.return_value = {"worker"}
    elif reason in {"restore", "paid_restore"}:
        name = ".restore-pending" if reason == "restore" else ".paid-restore-pending"
        (deployment.state / "companion" / name).write_text("paused")
    elif reason == "public_key":
        deployment.openai_key().chmod(0o644)
    elif reason == "over_budget":
        limit = 5000001
    else:
        limit = None
    deployment.compose = Mock()
    with pytest.raises(ValueError):
        deployment.configure_openai(limit)
    assert not (deployment.credentials / "generation.json").exists()
    deployment.compose.assert_not_called()


def test_restored_configuration_cannot_start_paid_worker(deployment):
    (deployment.credentials / "generation.json").write_text(
        json.dumps({"provider": "openai", "monthly_limit_microusd": 1000000})
    )
    (deployment.credentials / "generation.json").chmod(0o600)
    for name in ("sync-account", "companion-token"):
        path = deployment.credentials / name
        path.write_text("synthetic")
        path.chmod(0o600)
    (deployment.state / "companion/.paid-restore-pending").write_text("paused")
    deployment.compose = Mock()
    with pytest.raises(ValueError, match="paused"):
        deployment.start(worker=True)
    deployment.compose.assert_not_called()


def test_reconciliation_uses_only_the_recovery_command(deployment, monkeypatch):
    (deployment.state / "companion/.paid-restore-pending").write_text("paused")
    run = Mock()
    monkeypatch.setattr("learnrecur.deploy.manage.subprocess.run", run)
    deployment.reconcile_openai("synthetic-job", "resp_synthetic")
    args = run.call_args.args[0]
    assert "--reconcile-job" in args and "--response-id" in args
    assert "worker" not in args
    assert (deployment.state / "companion/.paid-restore-pending").exists()
    assert "sk-" not in str(run.call_args)
