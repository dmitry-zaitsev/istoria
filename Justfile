default:
    @just --list

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

# Re-render src-tauri/icons/source.svg into all per-platform icon
# artifacts. Touches build.rs so cargo picks up the new bytes on
# next build (macOS LaunchServices may still need an app reinstall).
icon:
    magick -background none -density 384 src-tauri/icons/source.svg -resize 1024x1024 -define png:color-type=6 src-tauri/icons/icon.png
    npm run tauri -- icon src-tauri/icons/icon.png
    touch src-tauri/build.rs
