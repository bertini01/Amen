use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Spawn a command on Windows without popping a console window.
/// Always pass arguments as an array — never via a shell string.
pub fn new_command(program: &Path) -> Command {
    // `mut` is only used by the Windows branch below; without this the Linux
    // build warns on every compile.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    // yt-dlp is a Python program: piped to us on Windows it writes in the
    // legacy ANSI code page, which cannot represent emoji or most non-Latin
    // titles. Those characters were silently dropped from the file paths it
    // printed, so history recorded paths that do not exist. Force UTF-8.
    // Harmless for non-Python tools such as FFmpeg.
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 0x08000000 == CREATE_NO_WINDOW
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Everything a finished (or timed-out) child produced.
#[derive(Debug, Clone, Default)]
pub struct CapturedOutput {
    pub stdout: String,
    pub stderr: String,
    /// `Some(true)` only for a clean zero exit. `None` when the process timed
    /// out or its status could not be read.
    pub success: Option<bool>,
    pub timed_out: bool,
}

/// Run a command with a timeout, capturing stdout and stderr separately.
/// Returns None if the process could not be spawned.
///
/// Both pipes are drained on their own threads: a child that fills an
/// undrained stderr pipe blocks on its next write and never exits, so only
/// reading stdout could hang a probe until the timeout.
pub fn run_capture_full(cmd: &mut Command, timeout_ms: u64) -> Option<CapturedOutput> {
    let mut child = match cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    let out_rx = drain(child.stdout.take());
    let err_rx = drain(child.stderr.take());

    let start = Instant::now();
    let mut success = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                success = Some(status.success());
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if start.elapsed().as_millis() > timeout_ms as u128 {
            // yt-dlp.exe is a launcher that runs the real program as a child
            // process; killing only the launcher leaves that child holding
            // the pipes open.
            #[cfg(windows)]
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Some(CapturedOutput {
        stdout: out_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        stderr: err_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        success,
        timed_out,
    })
}

/// Read a pipe to the end on a background thread.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        // Decode leniently: `read_to_string` discards the WHOLE output if a
        // single byte is not valid UTF-8.
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    rx
}

/// Run a command with a timeout and return its stdout (stderr is drained and
/// discarded). Returns None if the process could not be spawned.
pub fn run_capture(cmd: &mut Command, timeout_ms: u64) -> Option<String> {
    run_capture_full(cmd, timeout_ms).map(|o| o.stdout)
}

/// Kill a process and its entire child tree on Windows.
/// Uses `taskkill /PID <pid> /T /F` with structured arguments (no shell interpolation).
pub fn kill_tree(pid: u32) {
    let mut cmd = new_command(Path::new("taskkill"));
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}


#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn reports_exit_status_and_both_streams() {
        let mut cmd = new_command(Path::new("cmd"));
        cmd.args(["/C", "echo out & echo err 1>&2 & exit 3"]);
        let o = run_capture_full(&mut cmd, 20_000).expect("cmd runs");
        assert_eq!(o.success, Some(false));
        assert!(!o.timed_out);
        assert!(o.stdout.contains("out"));
        assert!(o.stderr.contains("err"));
    }

    #[test]
    fn a_full_stderr_pipe_does_not_block_the_child() {
        // ~2 MB to stderr: far beyond the pipe buffer. Undrained, the child
        // would block on write and only end at the timeout.
        let mut cmd = new_command(Path::new("powershell"));
        cmd.args([
            "-NoProfile",
            "-Command",
            "[Console]::Error.Write('x' * 2000000); exit 0",
        ]);
        let start = Instant::now();
        let o = run_capture_full(&mut cmd, 60_000).expect("powershell runs");
        assert!(!o.timed_out, "child blocked on a full stderr pipe");
        assert_eq!(o.success, Some(true));
        assert!(o.stderr.len() >= 2_000_000);
        assert!(start.elapsed() < Duration::from_secs(60));
    }
}
