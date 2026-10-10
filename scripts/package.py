#!/usr/bin/env python3
"""Build the allowlisted, deterministic DopaCopa release ZIP."""

import hashlib
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.1.0"
SOUNDS = (
    "insight.mp3",
    "chime.mp3",
    "dash.mp3",
    "item-2.mp3",
    "item-1.mp3",
    "spotlight.mp3",
    "boom.mp3",
    "clang.mp3",
    "transition.mp3",
    "sparkle-2.mp3",
    "sparkle-1.mp3",
    "explosion-2.mp3",
    "explosion-1.mp3",
    "shakiin-3.mp3",
    "shakiin-2.mp3",
    "shakiin-1.mp3",
)
FILES = (
    "extension.mjs",
    "events.mjs",
    "stage.mjs",
    "renderer.html",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
) + tuple(f"sounds/{name}" for name in SOUNDS)


def main():
    sound_files = {path.name for path in (ROOT / "sounds").iterdir()}
    if sound_files != set(SOUNDS):
        raise ValueError("sounds/ must contain exactly the 16 bundled MP3 files")

    inputs = []
    for name in FILES:
        path = ROOT / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing, empty, or non-regular distribution file: {name}")
        inputs.append((name, path.read_bytes()))

    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / f"DopaCopa-v{VERSION}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as package:
        for name, data in inputs:
            entry = zipfile.ZipInfo(f"copilot-arcade/{name}", (2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, data)

    checksum = f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n"
    (output / "SHA256SUMS").write_text(checksum, encoding="ascii")
    print(checksum, end="")


if __name__ == "__main__":
    main()
