use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "istoria",
    version,
    about = "Local log viewer — pipe a process's stdout into a native window.",
    long_about = None,
)]
pub struct Cli {
    /// Override the auto-derived source name (e.g. `--name api`).
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,

    /// Disable tee — do not forward stdin to stdout.
    #[arg(long)]
    pub silent: bool,
}

impl Cli {
    pub fn from_args() -> Self {
        Self::parse()
    }
}
