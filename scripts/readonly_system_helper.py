from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path


def file_type_for(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if path.is_dir():
        return "directory"
    if path.is_file():
        return "file"
    return "other"


def list_entries(target: Path, *, show_hidden: bool) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    with os.scandir(target) as iterator:
        for entry in iterator:
            if not show_hidden and entry.name.startswith("."):
                continue
            entry_path = Path(entry.path)
            info = entry.stat(follow_symlinks=False)
            entries.append(
                {
                    "name": entry.name,
                    "path": str(entry_path),
                    "file_type": file_type_for(entry_path),
                    "size": int(info.st_size),
                    "mode": stat.filemode(info.st_mode),
                    "modified_epoch": int(info.st_mtime),
                }
            )
    entries.sort(key=lambda item: (item["file_type"] != "directory", str(item["name"]).lower()))
    return entries


def command_list(path: str, show_hidden: str) -> int:
    target = Path(path)
    if not target.exists():
        print("path not found", file=sys.stderr)
        return 2
    if not target.is_dir():
        print("path is not a directory", file=sys.stderr)
        return 2

    payload = {
        "entries": list_entries(target, show_hidden=show_hidden.lower() == "true"),
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    return 0


def command_read(path: str) -> int:
    target = Path(path)
    if not target.exists():
        print("file not found", file=sys.stderr)
        return 2
    if not target.is_file():
        print("path is not a file", file=sys.stderr)
        return 2

    with target.open("rb") as handle:
        sys.stdout.buffer.write(handle.read())
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: readonly_system_helper.py <list|read> <path> [show_hidden]", file=sys.stderr)
        return 2

    command = argv[1]
    path = argv[2]
    if command == "list":
        show_hidden = argv[3] if len(argv) > 3 else "false"
        return command_list(path, show_hidden)
    if command == "read":
        return command_read(path)

    print(f"unknown command: {command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
