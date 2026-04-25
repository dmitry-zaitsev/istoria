pub mod cli;

use std::io::{self, IsTerminal, Read, Write};
use std::thread;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli: cli::Cli) {
    if cli.clear {
        // M2: purge the DuckDB store. No-op for now.
    }

    if !cli.silent && !io::stdin().is_terminal() {
        thread::spawn(|| {
            let mut buf = [0u8; 8 * 1024];
            let mut stdin = io::stdin().lock();
            let mut stdout = io::stdout().lock();
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stdout.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        let _ = stdout.flush();
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }

    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running istoria");
}
