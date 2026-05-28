"""
Filesystem locations shared across the app.

The GUI piggybacks on the existing `garmin/` folder (token cache, downloaded
data, DuckDB file). Keeping these in the repo for now since this is a personal
tool — when the user packages for a friend we can switch to `QStandardPaths`
(AppData on Windows, Application Support on Mac).
"""
from __future__ import annotations

from pathlib import Path

# Project root = repo containing pyproject.toml
REPO_ROOT = Path(__file__).resolve().parent.parent

GARMIN_DIR = REPO_ROOT / "garmin"
DATA_DIR = GARMIN_DIR / "data"
SESSIONS_DIR = DATA_DIR / "sessions"
MEAN_LINES_DIR = DATA_DIR / "mean_lines"

CONFIG_PATH = GARMIN_DIR / "config.json"
GARTH_TOKEN_DIR = GARMIN_DIR / ".garth"
CATALYST_TOKEN_CACHE = GARMIN_DIR / ".catalyst_token.json"
DB_PATH = DATA_DIR / "catalyst.duckdb"

LOTUS_DIR = REPO_ROOT / "lotus"
