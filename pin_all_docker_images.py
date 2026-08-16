#!/usr/bin/env python3

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# Concrete Docker image reference with an explicit tag.
#
# Matches:
#   nginx:alpine
#   nginx:alpine@sha256:abc123...
#   ghcr.io/foo/bar:1.2.3
#   localhost:5000/foo/bar:test
#
# Deliberately does not match variable-driven references such as:
#   nginx:${TAG}
IMAGE_REF = r"(?P<ref>[A-Za-z0-9._/:+-]+:[A-Za-z0-9._-]+)(?:@sha256:[0-9A-Fa-f]+)?"

PATTERNS = [
    # Compose/YAML:
    #     image: nginx:alpine
    #     image: "nginx:alpine@sha256:..."
    re.compile(
        rf"(?m)^(?P<prefix>[ \t]*image:[ \t]*[\"']?){IMAGE_REF}"
    ),

    # Dockerfiles:
    #     FROM nginx:alpine
    #     FROM --platform=linux/amd64 nginx:alpine AS runtime
    re.compile(
        rf"(?m)^(?P<prefix>[ \t]*FROM[ \t]+(?:--\S+[ \t]+)*){IMAGE_REF}"
    ),
]

digest_cache = {}
failures = False


def resolve_digest(ref):
    """Resolve the current registry digest for a tagged image."""
    if ref in digest_cache:
        return digest_cache[ref]

    print(f"Resolving {ref} ...")

    result = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", ref],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    if result.returncode != 0:
        print(f"ERROR: unable to inspect {ref}", file=sys.stderr)
        print(result.stderr.rstrip(), file=sys.stderr)
        digest_cache[ref] = None
        return None

    match = re.search(
        r"(?m)^\s*Digest:\s*(sha256:[0-9A-Fa-f]{64})\s*$",
        result.stdout,
    )

    if not match:
        print(f"ERROR: no digest found for {ref}", file=sys.stderr)
        digest_cache[ref] = None
        return None

    digest = match.group(1).lower()
    digest_cache[ref] = digest
    return digest


def update_file(path):
    global failures

    try:
        original = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return

    updated = original

    def replace(match):
        global failures

        ref = match.group("ref")
        digest = resolve_digest(ref)

        if digest is None:
            failures = True
            return match.group(0)

        return f"{match.group('prefix')}{ref}@{digest}"

    for pattern in PATTERNS:
        updated = pattern.sub(replace, updated)

    if updated != original:
        print(f"Updating {path.relative_to(ROOT)}")
        path.write_text(updated, encoding="utf-8")


def main():
    if not ROOT.is_dir():
        print(f"ERROR: not a directory: {ROOT}", file=sys.stderr)
        return 1

    for directory, dirs, files in os.walk(ROOT):
        # Don't crawl repository metadata.
        dirs[:] = [
            d for d in dirs
            if d not in {".git"}
        ]

        for filename in files:
            update_file(Path(directory) / filename)

    if failures:
        print("\nOne or more image digests could not be resolved.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
