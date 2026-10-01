"""The local launcher must not inherit Anki paths, users, or network bindings."""

import pytest

from learnrecur.deploy.run_sync_server import MARKER, VERSION, server_environment

ACCOUNT = "synthetic:synthetic-pass"


def test_explicit_loopback_storage_and_account_override_inherited_settings(
    tmp_path, monkeypatch
):
    for key, value in {
        "SYNC_HOST": "0.0.0.0",
        "SYNC_BASE": "Anki2",
        "SYNC_USER2": "other:other",
        "PASSWORDS_HASHED": "1",
        "ANKI_BASE": "Anki2",
        "ANKI_SYNC_ENDPOINT": "https://example.com/",
    }.items():
        monkeypatch.setenv(key, value)
    folder = tmp_path / "sync"
    env = server_environment(folder, 45331, ACCOUNT)
    assert env["SYNC_HOST"] == "127.0.0.1"
    assert env["SYNC_BASE"] == str(folder)
    assert env["SYNC_USER1"] == ACCOUNT
    assert env["SYNC_PORT"] == "45331"
    assert not (
        {"SYNC_USER2", "PASSWORDS_HASHED", "ANKI_BASE", "ANKI_SYNC_ENDPOINT"}
        & env.keys()
    )
    assert (folder / MARKER).read_text() == VERSION
    (folder / "synthetic.txt").write_text("Synthetic data")
    assert server_environment(folder, 45331, ACCOUNT) == env


@pytest.mark.parametrize("name", ["Anki", "Anki2", ".anki"])
def test_anki_paths_rejected_without_opening_them(tmp_path, name):
    folder = tmp_path / name
    with pytest.raises(ValueError):
        server_environment(folder, 45331, ACCOUNT)
    assert not folder.exists()


def test_nonempty_unowned_and_symlinked_folders_are_rejected(tmp_path):
    folder = tmp_path / "unowned"
    folder.mkdir()
    content = folder / "synthetic.txt"
    content.write_text("Keep")
    with pytest.raises(ValueError):
        server_environment(folder, 45331, ACCOUNT)
    assert content.read_text() == "Keep"
    link = tmp_path / "linked"
    link.symlink_to(folder, target_is_directory=True)
    with pytest.raises(ValueError):
        server_environment(link, 45331, ACCOUNT)
    owned = tmp_path / "owned"
    server_environment(owned, 45331, ACCOUNT)
    (owned / "linked").symlink_to(content)
    with pytest.raises(ValueError):
        server_environment(owned, 45331, ACCOUNT)
    assert content.read_text() == "Keep"


@pytest.mark.parametrize(
    "port,account",
    [(0, ACCOUNT), (65536, ACCOUNT), (45331, ""), (45331, "../x:pw"), (45331, "user:")],
)
def test_bad_parameters_create_no_storage(tmp_path, port, account):
    folder = tmp_path / "sync"
    with pytest.raises(ValueError):
        server_environment(folder, port, account)
    assert not folder.exists()
