#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/../src"
TO_SOURCE_DIR="$SCRIPT_DIR/src"
PACK_DIR="$SCRIPT_DIR/package"
ROOT_DIR="$SCRIPT_DIR/.."
LAST_TARBALL_FILE="$SCRIPT_DIR/.last-tarball"

install_publish_tools() {
    (cd "$SCRIPT_DIR" && npm install)
}

pack() {
    echo 'Clearing publish/src and publish/package...'
    "$SCRIPT_DIR/node_modules/.bin/rimraf" "$TO_SOURCE_DIR"
    "$SCRIPT_DIR/node_modules/.bin/rimraf" "$PACK_DIR"

    echo 'Copying src...'
    "$SCRIPT_DIR/node_modules/.bin/ncp" "$SOURCE_DIR" "$TO_SOURCE_DIR"

    echo 'Copying README and LICENSE into package source...'
    "$SCRIPT_DIR/node_modules/.bin/ncp" "$ROOT_DIR/LICENSE" "$TO_SOURCE_DIR/LICENSE"
    "$SCRIPT_DIR/node_modules/.bin/ncp" "$ROOT_DIR/README.md" "$TO_SOURCE_DIR/README.md"

    echo 'Installing dependencies and compiling TypeScript...'
    (
        cd "$TO_SOURCE_DIR"
        npm install
        npm run compile
    )

    for required_file in \
        "connectivity-manager-impl.android.js" \
        "connectivity-manager-impl.ios.js" \
        "connectivity-manager-impl.common.js" \
        "connectivity-manager-interface.js"
    do
        if [ ! -f "$TO_SOURCE_DIR/$required_file" ]; then
            echo "ERROR: Missing compiled runtime file: $required_file"
            exit 1
        fi
    done

    echo 'Creating package tarball...'
    mkdir -p "$PACK_DIR"
    TARBALL_NAME="$(cd "$PACK_DIR" && npm pack "$TO_SOURCE_DIR" | tail -n 1)"
    TARBALL_PATH="$PACK_DIR/$TARBALL_NAME"

    echo "Tarball created: $TARBALL_PATH"
    echo 'Tarball runtime extract check:'
    tar -tzf "$TARBALL_PATH" | grep -E 'package/(connectivity-manager-impl\.(android|ios|common)\.js|connectivity-manager-interface\.js|.*\.d\.ts)$' || true

    if ! tar -tzf "$TARBALL_PATH" | grep -q 'package/connectivity-manager-impl.android.js'; then
        echo 'ERROR: Tarball missing package/connectivity-manager-impl.android.js'
        exit 1
    fi

    if ! tar -tzf "$TARBALL_PATH" | grep -q 'package/connectivity-manager-impl.ios.js'; then
        echo 'ERROR: Tarball missing package/connectivity-manager-impl.ios.js'
        exit 1
    fi

    printf '%s\n' "$TARBALL_PATH" > "$LAST_TARBALL_FILE"
    echo "Saved tarball path to $LAST_TARBALL_FILE"

    "$SCRIPT_DIR/node_modules/.bin/rimraf" "$TO_SOURCE_DIR"
}

install_publish_tools
pack
