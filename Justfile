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

# Run the Electron app in dev mode (Chromium renderer — no WKWebView ghost).
# Starts Vite, builds the headless Rust core, and launches Electron, which
# spawns the core as its sidecar. Works for both:
# - tty stdin: plain `just dev` — interactive, no piped logs.
# - piped stdin (`just fakeLogs | just dev`): Electron inherits the pipe and
#   passes it to the core, which ingests it straight into the window.
# Vite's stdin is detached (</dev/null) so it can't swallow the piped logs.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "[just dev] building istoria-core…" >&2
    cargo build --manifest-path src-tauri/Cargo.toml --bin istoria-core
    npm run dev >/tmp/istoria-vite.log 2>&1 </dev/null &
    VITE_PID=$!
    trap 'kill $VITE_PID 2>/dev/null || true' EXIT
    for _ in $(seq 1 200); do
        if curl -sf http://localhost:1420/ >/dev/null 2>&1; then
            break
        fi
        sleep 0.1
    done
    echo "[just dev] launching electron…" >&2
    # No `exec`: keep the bash parent alive so the EXIT trap tears down Vite
    # when Electron quits. Electron still inherits our (piped) stdin.
    ISTORIA_DEV_URL=http://localhost:1420 ./node_modules/.bin/electron electron/main.cjs

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

# Build a signed + notarized macOS app (arm64) via electron-builder and pack
# the full set of artifacts CI publishes: a signed/notarized/stapled .dmg, the
# electron-updater .zip + latest-mac.yml (+ .blockmaps), the Homebrew
# .app.tar.gz, and SHA256SUMS. Mirrors the CI release job for local smoke tests.
#
# Required env (load from a gitignored .envrc / direnv or export inline):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: Name (TEAMID)"
#   APPLE_ID                 Apple ID email
#   APPLE_PASSWORD           app-specific password (→ APPLE_APP_SPECIFIC_PASSWORD)
#   APPLE_TEAM_ID            Apple Developer team ID
#
# Signing cert must already be in your login keychain.
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
    if [[ "$(uname -m)" != "arm64" ]]; then
        echo "release-mac builds arm64 only" >&2
        exit 1
    fi
    VERSION="$(node -p "require('./package.json').version")"
    TARGET="aarch64-apple-darwin"
    APP="release/mac-arm64/istoria.app"
    DMG="release/istoria-${VERSION}-arm64.dmg"
    ZIP="release/istoria-${VERSION}-arm64-mac.zip"
    BREW_ARTIFACT="istoria-${VERSION}-${TARGET}.app.tar.gz"
    # Clean stale artifacts so exact names + SHA256SUMS can't pick up an old
    # version (electron-builder recreates release/).
    rm -rf release
    # electron-builder signs (Developer ID from the login keychain), notarizes +
    # staples the .app, and emits the dmg + zip + latest-mac.yml (+ .blockmaps)
    # into release/. Build-only — we upload via gh.
    #
    # codesign matches the identity by its common NAME, so the login keychain
    # must contain exactly ONE "Developer ID Application: …" cert for this team.
    # If it holds two, signing fails with "…: ambiguous"; remove the extra one
    # (Keychain Access → delete, or `security delete-identity -Z <sha1>`).
    npm run build:electron
    npm run core:build:release
    CSC_NAME="$APPLE_SIGNING_IDENTITY" \
    APPLE_APP_SPECIFIC_PASSWORD="$APPLE_PASSWORD" \
        npx electron-builder --publish never
    # electron-builder notarizes + staples the .app but leaves the .dmg CONTAINER
    # un-notarized — a downloaded .dmg would then trip Gatekeeper ("Apple cannot
    # check it…"). Sign + notarize + staple the dmg too (matches the Tauri flow).
    echo "[dmg] sign + notarize + staple…"
    codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG"
    xcrun notarytool submit "$DMG" \
        --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
        --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$DMG"
    echo "[verify] codesign + gatekeeper (.app)…"
    codesign --verify --deep --strict --verbose=2 "$APP"
    codesign --verify --verbose=2 "$APP/Contents/Resources/istoria-core"
    spctl --assess --type execute --verbose=2 "$APP"
    xcrun stapler validate "$APP"
    echo "[verify] gatekeeper + staple (.dmg)…"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" || \
        echo "::warning:: dmg spctl assess reported an issue (stapler validate is authoritative)"
    # Homebrew tarball: istoria.app wrapped in istoria-<version>/ so brew's
    # extract-and-chdir strips the wrapper, not the .app itself.
    STAGE="$(mktemp -d)"
    mkdir "$STAGE/istoria-${VERSION}"
    cp -R "$APP" "$STAGE/istoria-${VERSION}/"
    tar -czf "release/${BREW_ARTIFACT}" -C "$STAGE" "istoria-${VERSION}"
    (cd release && shasum -a 256 \
        "istoria-${VERSION}-arm64.dmg" "istoria-${VERSION}-arm64-mac.zip" \
        "${BREW_ARTIFACT}" latest-mac.yml \
        | tee "istoria-${VERSION}-${TARGET}.sha256" > SHA256SUMS)
    echo "✓ $DMG (signed + notarized + stapled)"
    echo "✓ $ZIP"
    echo "✓ release/${BREW_ARTIFACT}"
    echo "✓ release/latest-mac.yml"
    echo "✓ release/SHA256SUMS"

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
