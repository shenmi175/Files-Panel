#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import pathlib
import re
import shutil
import sys


MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)]+)\)")
REMOTE_SCHEMES = ("http://", "https://", "mailto:", "data:")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export repo-hosted wiki markdown into a GitHub Wiki checkout."
    )
    parser.add_argument("--repo-root", required=True, help="Repository root directory.")
    parser.add_argument("--source-dir", required=True, help="Source wiki directory inside the repo.")
    parser.add_argument("--output-dir", required=True, help="Checked-out .wiki.git directory.")
    parser.add_argument("--repository", required=True, help="GitHub repository in owner/name form.")
    parser.add_argument("--ref", required=True, help="Branch or ref name for blob links.")
    return parser.parse_args()


def clear_output_dir(output_dir: pathlib.Path) -> None:
    for child in output_dir.iterdir():
        if child.name == ".git":
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def copy_non_markdown_files(source_dir: pathlib.Path, output_dir: pathlib.Path) -> None:
    for source_path in source_dir.rglob("*"):
        if source_path.is_dir():
            continue
        relative_path = source_path.relative_to(source_dir)
        target_path = output_dir / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if source_path.suffix.lower() == ".md":
            continue
        shutil.copy2(source_path, target_path)


def should_keep_link(target: str) -> bool:
    if not target or target.startswith("#"):
        return True
    if target.startswith(REMOTE_SCHEMES):
        return True
    return False


def split_target(target: str) -> tuple[str, str]:
    if "#" in target:
        base, anchor = target.split("#", 1)
        return base, f"#{anchor}"
    return target, ""


def resolve_repo_relative_target(
    page_repo_relative: pathlib.PurePosixPath,
    target_base: str,
) -> pathlib.PurePosixPath:
    joined = page_repo_relative.parent.joinpath(pathlib.PurePosixPath(target_base))
    normalized = os.path.normpath(str(joined)).replace("\\", "/")
    return pathlib.PurePosixPath(normalized)


def rewrite_target(
    target: str,
    *,
    page_repo_relative: pathlib.PurePosixPath,
    source_repo_relative: pathlib.PurePosixPath,
    markdown_pages: set[pathlib.PurePosixPath],
    repository: str,
    ref_name: str,
) -> str:
    if should_keep_link(target):
        return target

    base, anchor = split_target(target)
    if not base:
        return target

    if base.startswith("/"):
        return target

    resolved = resolve_repo_relative_target(page_repo_relative, base)

    if resolved in markdown_pages:
        wiki_relative = resolved.relative_to(source_repo_relative)
        wiki_target = str(wiki_relative.with_suffix("")).replace("\\", "/")
        return f"{wiki_target}{anchor}"

    repo_blob_target = str(resolved).lstrip("/")
    return f"https://github.com/{repository}/blob/{ref_name}/{repo_blob_target}{anchor}"


def rewrite_markdown(
    text: str,
    *,
    page_repo_relative: pathlib.PurePosixPath,
    source_repo_relative: pathlib.PurePosixPath,
    markdown_pages: set[pathlib.PurePosixPath],
    repository: str,
    ref_name: str,
) -> str:
    def replace(match: re.Match[str]) -> str:
        label = match.group(1)
        target = match.group(2).strip()
        rewritten = rewrite_target(
            target,
            page_repo_relative=page_repo_relative,
            source_repo_relative=source_repo_relative,
            markdown_pages=markdown_pages,
            repository=repository,
            ref_name=ref_name,
        )
        return f"[{label}]({rewritten})"

    return MARKDOWN_LINK_RE.sub(replace, text)


def export_markdown_files(
    source_dir: pathlib.Path,
    output_dir: pathlib.Path,
    *,
    repo_root: pathlib.Path,
    repository: str,
    ref_name: str,
) -> None:
    markdown_files = sorted(source_dir.rglob("*.md"))
    markdown_pages = {
        pathlib.PurePosixPath(path.relative_to(repo_root).as_posix()) for path in markdown_files
    }
    source_repo_relative = pathlib.PurePosixPath(source_dir.relative_to(repo_root).as_posix())

    for source_path in markdown_files:
        repo_relative = pathlib.PurePosixPath(source_path.relative_to(repo_root).as_posix())
        relative_path = source_path.relative_to(source_dir)
        target_path = output_dir / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        rewritten = rewrite_markdown(
            source_path.read_text(encoding="utf-8"),
            page_repo_relative=repo_relative,
            source_repo_relative=source_repo_relative,
            markdown_pages=markdown_pages,
            repository=repository,
            ref_name=ref_name,
        )
        target_path.write_text(rewritten, encoding="utf-8")


def main() -> int:
    args = parse_args()

    repo_root = pathlib.Path(args.repo_root).resolve()
    source_dir = (repo_root / args.source_dir).resolve()
    output_dir = pathlib.Path(args.output_dir).resolve()

    if not source_dir.is_dir():
        print(f"Source wiki directory does not exist: {source_dir}", file=sys.stderr)
        return 1
    if not output_dir.is_dir():
        print(f"Output directory does not exist: {output_dir}", file=sys.stderr)
        return 1

    clear_output_dir(output_dir)
    copy_non_markdown_files(source_dir, output_dir)
    export_markdown_files(
        source_dir,
        output_dir,
        repo_root=repo_root,
        repository=args.repository,
        ref_name=args.ref,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
