default:
    @just --list

# Bootstrap a fresh worktree: install JS deps, leave Rust target/ to
# build cold on first `cargo run`. No sibling-worktree linking — they
# get deleted at any time, and absolute paths baked into target/ by
# tauri-build bind a clone to its source. sccache (rustc-wrapper)
# absorbs most of the cold-build cost via a global cache outside any
# worktree. Conductor invokes this on workspace creation.
bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -d node_modules ] || npm ci
    [ -d extension/node_modules ] || (cd extension && npm ci)

# Run the app in dev mode.
# - tty stdin: normal `tauri dev` with hot-reload of both rust + vite.
# - piped stdin (e.g. `cat log | just dev`): run vite + `cargo run`
#   directly so stdin reaches the binary instead of being captured
#   by the tauri-cli dev console.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -t 0 ]; then
        exec npm run tauri dev
    fi
    echo "[just dev] piped stdin → vite + cargo run" >&2
    npm run dev >/tmp/istoria-vite.log 2>&1 &
    VITE_PID=$!
    trap 'kill $VITE_PID 2>/dev/null || true' EXIT
    for _ in $(seq 1 100); do
        if curl -sf http://localhost:1420/ >/dev/null 2>&1; then
            break
        fi
        sleep 0.1
    done
    cargo run --manifest-path src-tauri/Cargo.toml --bin istoria

# Stream randomized fake logs to stdout. Pipe into `just dev` to
# exercise the UI: `just fakeLogs | just dev`.
fakeLogs *args:
    @node examples/generator/fake-logs.mjs {{args}}

# Build the Chrome extension and stage it into ~/.istoria/extension
# for `chrome://extensions` → Load unpacked. Also drops a versioned
# zip into dist/ for Web Store upload.
extension:
    #!/usr/bin/env bash
    set -euo pipefail
    cd extension
    if [ ! -d node_modules ]; then
        npm install --silent
    fi
    npm run build
    DEST="${HOME}/.istoria/extension"
    mkdir -p "$DEST"
    rsync -a --delete --exclude='.DS_Store' dist/ "$DEST/"
    echo "✓ ${DEST}"
    echo "  chrome://extensions → Developer mode → Load unpacked → ${DEST}"

# Re-render src-tauri/icons/source.svg into all per-platform icon
# artifacts. Touches build.rs so cargo picks up the new bytes on
# next build (macOS LaunchServices may still need an app reinstall).
icon:
    magick -background none -density 384 src-tauri/icons/source.svg -resize 1024x1024 -define png:color-type=6 src-tauri/icons/icon.png
    npm run tauri -- icon src-tauri/icons/icon.png
    touch src-tauri/build.rs

# Build a signed + notarized macOS .app for the host arch and pack
# it as dist/istoria-<version>-<target>.app.tar.gz with a sha256.
# Mirrors the CI release job for local smoke tests before tagging.
#
# Required env (load from a gitignored .envrc / direnv or export inline):
#   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: Name (TEAMID)"
#   APPLE_ID                Apple ID email
#   APPLE_PASSWORD          app-specific password
#   APPLE_TEAM_ID           Apple Developer team ID
#
# Signing cert must already be in your login keychain. No .p12 import
# is done locally — that path is only for CI.
release-mac:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${APPLE_SIGNING_IDENTITY:?missing — see recipe comment}"
    : "${APPLE_ID:?missing — see recipe comment}"
    : "${APPLE_PASSWORD:?missing — see recipe comment}"
    : "${APPLE_TEAM_ID:?missing — see recipe comment}"
    if [[ "$(uname -s)" != "Darwin" ]]; then
        echo "release-mac only runs on macOS" >&2
        exit 1
    fi
    case "$(uname -m)" in
        arm64)  TARGET="aarch64-apple-darwin" ;;
        x86_64) TARGET="x86_64-apple-darwin"  ;;
        *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
    esac
    VERSION="$(node -p "require('./package.json').version")"
    rustup target add "$TARGET" >/dev/null
    npm run tauri -- build --target "$TARGET" --bundles app
    BUNDLE_DIR="target/${TARGET}/release/bundle/macos"
    APP="${BUNDLE_DIR}/istoria.app"
    echo "[verify] codesign…"
    codesign --verify --deep --strict --verbose=2 "$APP"
    echo "[verify] gatekeeper…"
    spctl --assess --type execute --verbose=2 "$APP" || \
        echo "::warning:: spctl assess failed — notarization may not have stapled"
    mkdir -p dist
    ARTIFACT="istoria-${VERSION}-${TARGET}.app.tar.gz"
    # Wrap in parent dir so brew strips the wrapper, not the .app.
    STAGE="$(mktemp -d)"
    mkdir "$STAGE/istoria-${VERSION}"
    cp -R "$BUNDLE_DIR/istoria.app" "$STAGE/istoria-${VERSION}/"
    tar -czf "dist/${ARTIFACT}" -C "$STAGE" "istoria-${VERSION}"
    (cd dist && shasum -a 256 "$ARTIFACT" | tee "${ARTIFACT}.sha256")
    echo "✓ dist/${ARTIFACT}"

# Same as `release-mac` but pulls Apple secrets from 1Password
# (vault Private, item "istoria release") so you don't have to
# export anything to your shell. Requires the 1Password CLI (`op`)
# signed in (run `op signin` once per session).
release-mac-op:
    #!/usr/bin/env bash
    set -euo pipefail
    ITEM="op://Private/istoria release/release"
    export APPLE_SIGNING_IDENTITY="$(op read "${ITEM}/APPLE_SIGNING_IDENTITY")"
    export APPLE_ID="$(op read "${ITEM}/APPLE_ID")"
    export APPLE_PASSWORD="$(op read "${ITEM}/APPLE_PASSWORD")"
    export APPLE_TEAM_ID="$(op read "${ITEM}/APPLE_TEAM_ID")"
    exec just release-mac
