#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let cli = istoria_lib::cli::Cli::from_args();
    istoria_lib::run(cli);
}
