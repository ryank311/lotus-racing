"""
Login dialog — collects Garmin SSO credentials.

We never persist the password to disk from the GUI. The user can either:
  (a) put email+password in garmin/config.json (already gitignored) — recommended
  (b) enter them here at sync time, in memory only.

Once login succeeds via the worker, the Catalyst token is cached for 90 days
in `.catalyst_token.json` and we never see the password again.
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QVBoxLayout,
)

from .. import state


class LoginDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Sign in to Garmin")
        self.setMinimumWidth(380)
        self._email_value: str | None = None
        self._password_value: str | None = None
        self._build()

    def _build(self) -> None:
        layout = QVBoxLayout(self)

        intro = QLabel(
            "Sign in once. The app exchanges your credentials with Garmin SSO "
            "for a Catalyst-scoped access token, then forgets the password. "
            "Token is cached for ~90 days."
        )
        intro.setWordWrap(True)
        intro.setStyleSheet("color: #aaa; font-size: 12px;")
        layout.addWidget(intro)

        form = QFormLayout()
        self._email = QLineEdit()
        self._email.setPlaceholderText("you@example.com")
        existing_email = state.read_account_email()
        if existing_email:
            self._email.setText(existing_email)

        self._password = QLineEdit()
        self._password.setEchoMode(QLineEdit.Password)

        self._show_pw = QCheckBox("Show password")
        self._show_pw.toggled.connect(
            lambda on: self._password.setEchoMode(
                QLineEdit.Normal if on else QLineEdit.Password
            )
        )

        form.addRow("Email", self._email)
        form.addRow("Password", self._password)
        form.addRow("", self._show_pw)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel
        )
        buttons.accepted.connect(self._accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _accept(self) -> None:
        self._email_value = self._email.text().strip()
        self._password_value = self._password.text()
        if not self._email_value or not self._password_value:
            return
        self.accept()

    @property
    def email(self) -> str | None:
        return self._email_value

    @property
    def password(self) -> str | None:
        return self._password_value
