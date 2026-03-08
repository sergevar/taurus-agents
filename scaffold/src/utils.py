"""Utility functions."""

import json
from pathlib import Path


def read_json(filepath: str) -> dict:
    return json.loads(Path(filepath).read_text())


def write_json(filepath: str, data: dict) -> None:
    Path(filepath).write_text(json.dumps(data, indent=2))


def count_lines(filepath: str) -> int:
    return len(Path(filepath).read_text().splitlines())
