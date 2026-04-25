default:
    @just --list

# Run the app in dev mode (Tauri spawns Vite + the Rust binary, auto-reload).
dev:
    npm run tauri dev
