#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAST_TARBALL_FILE="$SCRIPT_DIR/.last-tarball"

publish() {
    if [ ! -f "$LAST_TARBALL_FILE" ]; then
        echo "ERROR: Missing $LAST_TARBALL_FILE. Run pack first."
        exit 1
    fi

    TARBALL_PATH="$(cat "$LAST_TARBALL_FILE")"
    if [ ! -f "$TARBALL_PATH" ]; then
        echo "ERROR: Tarball not found at $TARBALL_PATH"
        exit 1
    fi

    echo "Publishing to npm: $TARBALL_PATH"
    npm publish "$TARBALL_PATH" --access public
}

"$SCRIPT_DIR/pack.sh"
publish
