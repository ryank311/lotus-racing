"""
Car profiles — toggle between the Lotus and Vette garages.

Each profile is a directory at the repo root containing a `Car.md` (required)
and any number of additional setup / guide markdown files. The current
selection is persisted via QSettings so it survives app restarts.

Adding a profile is intentionally trivial: drop a new `MyCar/` folder with a
`Car.md` inside next to `Lotus/` and `Vette/`, and it shows up automatically
in the dropdown. No code change needed.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QSettings

from . import paths


# Folders to ignore when scanning the repo root for profiles
_NON_PROFILE_DIRS = {
    "garmin", "catalyst_gui", "catalyst-apk-decompiled", "coaching",
    "tracks", "data", "logs", "build", "dist",
    "catalyst_coach.egg-info", "__pycache__", ".git", ".claude",
}


@dataclass(frozen=True)
class Profile:
    """A car profile = a directory + its Car.md path."""
    name: str           # display name, e.g. "Lotus", "Vette"
    dir: Path           # absolute path
    car_md: Path        # dir / "Car.md"

    @property
    def exists(self) -> bool:
        return self.car_md.exists()


def discover_profiles() -> list[Profile]:
    """
    Scan the repo root for directories containing a `Car.md`.

    Returns alphabetically-sorted profiles. If none exist, returns an empty
    list — the GUI shows a "no profiles" hint in that case.
    """
    out: list[Profile] = []
    for child in sorted(paths.REPO_ROOT.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        if child.name.startswith(".") or child.name in _NON_PROFILE_DIRS:
            continue
        car_md = child / "Car.md"
        if car_md.exists():
            out.append(Profile(name=child.name, dir=child, car_md=car_md))
    return out


def settings() -> QSettings:
    """Per-app settings store (Application Support on Mac, registry on Win)."""
    return QSettings()


def get_active_profile_name(default: str | None = None) -> str | None:
    """Read the saved profile name, falling back to `default` or the first one available."""
    saved = settings().value("active_profile", None)
    if saved:
        return str(saved)
    profiles = discover_profiles()
    if default and any(p.name == default for p in profiles):
        return default
    return profiles[0].name if profiles else None


def set_active_profile_name(name: str) -> None:
    settings().setValue("active_profile", name)


def get_active_profile() -> Profile | None:
    name = get_active_profile_name()
    if not name:
        return None
    for p in discover_profiles():
        if p.name == name:
            return p
    # Saved profile no longer exists (folder deleted) — fall back to first
    available = discover_profiles()
    return available[0] if available else None
