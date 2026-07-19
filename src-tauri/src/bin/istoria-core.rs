//! Headless istoria core for the Electron shell — no window, serves the
//! frontend over HTTP + SSE. Electron spawns this as a sidecar.
fn main() {
    let cli = istoria_lib::cli::Cli::from_args();
    istoria_lib::headless::run_headless(cli);
}
