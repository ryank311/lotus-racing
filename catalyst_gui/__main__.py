"""Entry point — run with `catalyst-gui` (or `python -m catalyst_gui`)."""
from __future__ import annotations

import sys

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from .app import MainWindow


def main() -> int:
    # HiDPI looks better on modern displays
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setApplicationName("Catalyst Coach")
    app.setOrganizationName("racing")  # for QSettings on Mac/Win
    app.setOrganizationDomain("local")

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
