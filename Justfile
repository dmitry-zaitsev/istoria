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
    command -v sccache >/dev/null || brew install sccache
    [ -x /opt/homebrew/opt/lld/bin/ld64.lld ] || brew install lld

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

# Re-render src-tauri/icons/dmg-background.svg → dmg-background.png
# at native window size (660×400). Finder displays DMG backgrounds at
# native pixel size — a 2x retina PNG would get cropped to its top-left
# quadrant, hiding everything past x=660/y=400. Slight softness on
# retina is the tradeoff; the design is simple enough that degradation
# is minimal.
dmg-bg:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v rsvg-convert >/dev/null || { echo "install: brew install librsvg" >&2; exit 1; }
    rsvg-convert --width=660 --height=400 --format=png \
        src-tauri/icons/dmg-background.svg \
        -o src-tauri/icons/dmg-background.png
    echo "✓ src-tauri/icons/dmg-background.png"

# Build a signed + notarized macOS .app for the host arch and pack
# it as dist/istoria-<version>-<target>.app.tar.gz with a sha256.
# Also emits a .dmg, an updater signature, and latest.json — the full
# set of artifacts CI publishes. Mirrors the CI release job for local
# smoke tests before tagging.
#
# Required env (load from a gitignored .envrc / direnv or export inline):
#   APPLE_SIGNING_IDENTITY               "Developer ID Application: Name (TEAMID)"
#   APPLE_ID                             Apple ID email
#   APPLE_PASSWORD                       app-specific password
#   APPLE_TEAM_ID                        Apple Developer team ID
#   TAURI_SIGNING_PRIVATE_KEY            updater private key (file contents)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   password for that key
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
    : "${TAURI_SIGNING_PRIVATE_KEY:?missing — see recipe comment}"
    : "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?missing — see recipe comment}"
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
    npm run tauri -- build --target "$TARGET" --bundles app,dmg
    BUNDLE_DIR="target/${TARGET}/release/bundle/macos"
    APP="${BUNDLE_DIR}/istoria.app"
    DMG_SRC="$(ls target/${TARGET}/release/bundle/dmg/*.dmg | head -1)"
    echo "[verify] codesign (.app)…"
    codesign --verify --deep --strict --verbose=2 "$APP"
    echo "[verify] gatekeeper (.app)…"
    spctl --assess --type execute --verbose=2 "$APP" || \
        echo "::warning:: spctl assess failed — notarization may not have stapled"
    echo "[verify] gatekeeper + staple (.dmg)…"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_SRC" || \
        echo "::warning:: dmg spctl assess failed — notarization may not have stapled"
    stapler validate "$DMG_SRC" || \
        echo "::warning:: stapler validate failed on dmg"
    mkdir -p dist
    ARTIFACT="istoria-${VERSION}-${TARGET}.app.tar.gz"
    DMG_OUT="istoria-${VERSION}-${TARGET}.dmg"
    # Wrap in parent dir so brew strips the wrapper, not the .app.
    STAGE="$(mktemp -d)"
    mkdir "$STAGE/istoria-${VERSION}"
    cp -R "$BUNDLE_DIR/istoria.app" "$STAGE/istoria-${VERSION}/"
    tar -czf "dist/${ARTIFACT}" -C "$STAGE" "istoria-${VERSION}"
    cp "$DMG_SRC" "dist/${DMG_OUT}"
    cp "$DMG_SRC" "dist/istoria.dmg"
    # Sign our wrapped tarball (the bytes the updater downloads).
    npm run tauri -- signer sign "dist/${ARTIFACT}"
    SIG_CONTENT="$(cat "dist/${ARTIFACT}.sig")"
    PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat > dist/latest.json <<EOF
    {
      "version": "v${VERSION}",
      "notes": "Release v${VERSION}",
      "pub_date": "${PUB_DATE}",
      "platforms": {
        "darwin-aarch64": {
          "signature": "${SIG_CONTENT}",
          "url": "https://github.com/dmitry-zaitsev/istoria-releases/releases/download/v${VERSION}/${ARTIFACT}"
        }
      }
    }
    EOF
    (cd dist && shasum -a 256 "$ARTIFACT" "${ARTIFACT}.sig" "$DMG_OUT" istoria.dmg latest.json | tee "istoria-${VERSION}-${TARGET}.sha256")
    echo "✓ dist/${ARTIFACT}"
    echo "✓ dist/${ARTIFACT}.sig"
    echo "✓ dist/${DMG_OUT}"
    echo "✓ dist/istoria.dmg"
    echo "✓ dist/latest.json"

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
    export TAURI_SIGNING_PRIVATE_KEY="$(op read "${ITEM}/TAURI_SIGNING_PRIVATE_KEY")"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(op read "${ITEM}/TAURI_SIGNING_PRIVATE_KEY_PASSWORD")"
    exec just release-mac
