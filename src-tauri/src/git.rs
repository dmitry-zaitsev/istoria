//! One process-wide budget for Git, including background analysis and previews.
//! The lock covers execution, reaping, and the cooldown: callers cannot overlap.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

pub const DEBOUNCE: Duration = Duration::from_secs(5);
const TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;

struct GitRunner {
    finished: Mutex<Option<Instant>>,
    cooldown: Duration,
    timeout: Duration,
}

impl GitRunner {
    fn output(&self, command: &mut Command) -> io::Result<Output> {
        let mut finished = self.finished.lock();
        if let Some(last) = *finished {
            std::thread::sleep(self.cooldown.saturating_sub(last.elapsed()));
        }
        let result = output_with_timeout(command, self.timeout);
        // Failures consume the budget too; a broken repo must not spin.
        *finished = Some(Instant::now());
        result
    }
}

pub fn run<I, S>(root: &Path, args: I) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    static RUNNER: OnceLock<GitRunner> = OnceLock::new();
    let mut command = Command::new("git");
    command
        .args(["-c", "core.fsmonitor=false", "--no-pager"])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    RUNNER
        .get_or_init(|| GitRunner {
            finished: Mutex::new(None),
            cooldown: DEBOUNCE,
            timeout: TIMEOUT,
        })
        .output(&mut command)
}

fn read_output(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(io::Error::other("Git output exceeded 16 MiB"));
    }
    Ok(bytes)
}

fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        // The child leads its own process group. Include helpers that may
        // still hold stdout/stderr open after Git itself has exited.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

fn output_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // Drain both pipes while waiting; a full pipe must not deadlock Git.
    let out = std::thread::spawn(move || read_output(stdout));
    let err = std::thread::spawn(move || read_output(stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) if out.is_finished() && err.is_finished() => break Ok(status),
            Err(error) => break Err(error),
            _ => {}
        }
        if started.elapsed() >= timeout {
            break Err(io::Error::new(io::ErrorKind::TimedOut, "Git timed out"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if status.is_err() {
        kill_group(&mut child);
    }
    // Always reap before releasing the global budget, even on timeout.
    let _ = child.wait();
    let stdout = out
        .join()
        .map_err(|_| io::Error::other("Git stdout reader panicked"))?;
    let stderr = err
        .join()
        .map_err(|_| io::Error::other("Git stderr reader panicked"))?;
    Ok(Output {
        status: status?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn concurrent_requests_wait_for_completion_and_cooldown() {
        let runner = Arc::new(GitRunner {
            finished: Mutex::new(None),
            cooldown: Duration::from_millis(80),
            timeout: Duration::from_secs(2),
        });
        let barrier = Arc::new(Barrier::new(4));
        let started = Instant::now();
        let jobs: Vec<_> = (0..3)
            .map(|_| {
                let runner = runner.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    runner.output(Command::new("sh").args(["-c", "sleep 0.08; printf done"]))
                })
            })
            .collect();
        barrier.wait();
        for job in jobs {
            assert_eq!(job.join().unwrap().unwrap().stdout, b"done");
        }
        assert!(started.elapsed() >= Duration::from_millis(400));
    }

    #[test]
    fn timeout_kills_helpers_reaps_child_and_allows_next_request() {
        let runner = GitRunner {
            finished: Mutex::new(None),
            cooldown: Duration::ZERO,
            timeout: Duration::from_millis(100),
        };
        let started = Instant::now();
        // Cover a live child, and a helper holding pipes after its parent exits.
        for script in ["exec sleep 30", "sleep 30 & exit 0"] {
            let error = runner
                .output(Command::new("sh").args(["-c", script]))
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(runner
            .output(&mut Command::new("true"))
            .unwrap()
            .status
            .success());
    }
}
