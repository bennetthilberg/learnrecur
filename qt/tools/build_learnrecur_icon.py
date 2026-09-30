"""Render the seahorse SVG for Qt and the Mac app bundle."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QImage, QPainter
from PyQt6.QtSvg import QSvgRenderer

ROOT = Path(__file__).resolve().parents[2]


def render(renderer: QSvgRenderer, size: int, path: Path) -> None:
    image = QImage(size, size, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    renderer.render(painter)
    painter.end()
    if not image.save(str(path)):
        raise RuntimeError(f"Could not save {path}")


def main() -> None:
    renderer = QSvgRenderer(str(ROOT / "qt/icons/learnrecur.svg"))
    if not renderer.isValid():
        raise RuntimeError("Invalid seahorse SVG")
    render(renderer, 512, ROOT / "qt/aqt/data/qt/icons/learnrecur.png")
    with tempfile.TemporaryDirectory(prefix="learnrecur-icon-") as temp:
        iconset = Path(temp) / "learnrecur.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            render(renderer, size, iconset / f"icon_{size}x{size}.png")
            render(renderer, size * 2, iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(
            [
                "iconutil",
                "-c",
                "icns",
                "-o",
                str(ROOT / "qt/installer/app/resources/learnrecur.icns"),
                str(iconset),
            ],
            check=True,
        )


if __name__ == "__main__":
    main()
