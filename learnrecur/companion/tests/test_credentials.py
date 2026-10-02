"""Keys stay in private files outside collections and source control."""

import stat

import pytest

from learnrecur.companion.credentials import load_key, save_key

KEY = "sk-synthetic-key-for-tests-only"


def test_save_and_load_private_key_without_overwriting(tmp_path):
    path = tmp_path / "secrets/key"
    save_key(path, KEY)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert load_key(path) == KEY
    with pytest.raises(FileExistsError):
        save_key(path, "sk-other-synthetic-key-for-tests")
    assert load_key(path) == KEY


@pytest.mark.parametrize(
    "kind", ["file_mode", "folder_mode", "symlink", "hardlink", "fifo", "invalid"]
)
def test_unsafe_secret_file_is_refused(tmp_path, kind):
    path = tmp_path / "secrets/key"
    save_key(path, KEY)
    if kind == "file_mode":
        path.chmod(0o644)
    if kind == "folder_mode":
        path.parent.chmod(0o755)
    if kind == "symlink":
        alternate = path.with_name("alternate")
        path.rename(alternate)
        path.symlink_to(alternate)
    if kind == "hardlink":
        path.with_name("linked").hardlink_to(path)
    if kind == "fifo":
        import os

        path.unlink()
        os.mkfifo(path, 0o600)
    if kind == "invalid":
        path.write_text("not-a-key")
    with pytest.raises((ValueError, OSError)):
        load_key(path)


def test_invalid_key_is_never_saved(tmp_path):
    path = tmp_path / "secrets/key"
    with pytest.raises(ValueError):
        save_key(path, KEY + "\ninjected")
    assert not path.exists()


def test_existing_anki_path_is_refused_before_reading(tmp_path):
    with pytest.raises(ValueError):
        load_key(tmp_path / "Anki2/private")


def test_repository_path_is_refused_before_reading():
    from pathlib import Path

    with pytest.raises(ValueError):
        load_key(Path(__file__).resolve().parents[1] / "key")
