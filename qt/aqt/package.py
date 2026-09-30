# Copyright: Ankitects Pty Ltd and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""LearnRecur must never install an upstream Anki release."""

from anki.collection import GithubRelease


def download_github_update_and_install(release: GithubRelease) -> None:
    raise RuntimeError("LearnRecur does not install Anki updates.")
