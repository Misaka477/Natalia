//! The POSIX PTY bridge — the repo's own byte path for every pane.
//!
//! Wire protocol (byte-identical to the Python bridge it replaces, and the
//! ConPTY helper on Windows, so neither side can tell them apart):
//!
//!   stdin  -> a JSON spec line `{"file","args","cwd","cols","rows","env"}`,
//!             then JSON control lines: `{"type":"input","data":"…"}`,
//!             `{"type":"resize","rows":N,"cols":N}`, `{"type":"kill"}`.
//!   stdout -> a `{"pid":N}` handshake line, then frames: `{kind} {len}\n`
//!             followed by exactly len raw bytes. `o` carries the child's
//!             output, `x` the decimal exit code as ASCII.
//!
//! Why this exists in Rust: this process touches every byte of every pane.
//! The Python bridge made `cat` of a large file, or a runaway `yes`, a
//! question of interpreter throughput; here the same traffic is one read and
//! one write per chunk. The spec line is the only JSON on the hot path, and
//! it is parsed once, at startup.
//!
//! Two behaviours copied deliberately from the predecessor, both learned the
//! hard way there:
//!   * the spec line and the first control line can arrive in ONE read (the
//!     host writes its first input the instant start() returns, before this
//!     process has finished booting), so stdin is line-buffered, not
//!     line-drained;
//!   * a shell line editor asks where the cursor is (DSR, ESC[6n) and blocks
//!     until a terminal answers. This bridge owns the pty, so it is the
//!     terminal: it answers with the window size (it forwards bytes and
//!     emulates no screen, so the extent is the honest answer) and consumes
//!     the query rather than forwarding it.

use std::collections::HashMap;
use std::ffi::{CString, OsString};
use std::io::{Read, Write};
use std::mem;
use std::os::unix::ffi::OsStringExt;

use serde::Deserialize;

const DSR_QUERY: &[u8] = b"\x1b[6n";
const READ_CHUNK: usize = 4 * 1024;

#[derive(Deserialize)]
struct Spec {
    file: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    rows: u16,
    cols: u16,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Control {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    data: String,
    #[serde(default)]
    rows: u16,
    #[serde(default)]
    cols: u16,
}

fn main() {
    let code = run();
    std::process::exit(code);
}

fn run() -> i32 {
    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    // 1. The spec line, read from a line buffer that outlives it: control
    //    lines that shared the spec's read stay pending for the loop.
    let mut lines = LineReader::new(&mut stdin);
    let spec_line = match lines.next_line() {
        Some(line) => line,
        None => return 2,
    };
    let spec: Spec = match serde_json::from_str(&spec_line) {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("natalia-pty-bridge: bad spec: {error}");
            return 2;
        }
    };

    // 2. The pseudo-terminal: openpty + fork, and in the child the login_tty
    //    dance (setsid, the slave as the controlling terminal, the slave as
    //    all three standard streams) before exec. The parent closes the
    //    slave and sets the requested grid on the master.
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if opened != 0 {
        eprintln!("natalia-pty-bridge: openpty failed");
        return 2;
    }
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        child_exec(&spec, master, slave);
        // Never returns.
    }
    unsafe {
        libc::close(slave);
    }
    set_winsize(master, spec.rows, spec.cols);

    // 3. The handshake. The host's PtyProcess adopts this pid as the pane's.
    let _ = writeln!(stdout, "{{\"pid\":{pid}}}");
    let _ = stdout.flush();

    // 4. The forward loop: stdin carries control, the master carries bytes.
    let stdin_fd = libc::STDIN_FILENO;
    let mut output = Vec::with_capacity(READ_CHUNK + 4096);
    let mut killed = false;
    loop {
        // Every complete line already buffered is handled FIRST, before
        // blocking in select — the drain the Python bridge does once before
        // its loop, here per iteration so it also covers a line split across
        // two reads. It is not an optimisation: the host writes its first
        // input the instant start() resolves, which can land in the SAME read
        // as the spec line. read_line hands the spec back and leaves that
        // control line in `pending`, and a loop that only reacts to NEW stdin
        // bytes never sees it again — nothing else will make stdin readable.
        // The predecessor's comment named this failure exactly: "the first
        // input of a freshly started terminal is silently dropped".
        while let Some(line) = lines.take_line() {
            if !handle_control(&line, master, pid, &mut killed) {
                break;
            }
        }
        if killed {
            // SIGTERM was delivered to the child; the exit frame comes from
            // the waitpid below, exactly as the predecessor does.
            break;
        }
        let mut readable: libc::fd_set = unsafe { mem::zeroed() };
        unsafe {
            libc::FD_SET(stdin_fd, &mut readable);
            libc::FD_SET(master, &mut readable);
        }
        let nfds = stdin_fd.max(master) + 1;
        let ready = unsafe {
            libc::select(
                nfds,
                &mut readable,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ready < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            break;
        }
        if unsafe { libc::FD_ISSET(stdin_fd, &readable) } {
            // Only READ here: the drain at the top of the next iteration
            // handles the lines this produces. Draining inline with `next_line`
            // would block for the NEXT line and sit on the pty's echo while
            // stdin and the master go readable together — with the EOF check
            // below breaking first, the echo is never read.
            match lines.pump() {
                Ok(true) => {}
                Ok(false) => break, // stdin closed: the host is gone.
                Err(_) => break,
            }
        }
        if unsafe { libc::FD_ISSET(master, &readable) } {
            let mut chunk = [0u8; READ_CHUNK];
            let read =
                unsafe { libc::read(master, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
            if read <= 0 {
                break; // The child closed the pty.
            }
            output.clear();
            output.extend_from_slice(&chunk[..read as usize]);
            answer_cursor_queries(master, &mut output);
            if write_frame(&mut stdout, b"o", &output).is_err() {
                break;
            }
        }
    }

    // 5. The exit frame: the child's status as a decimal ASCII payload.
    let mut status: libc::c_int = 0;
    let code = loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            break if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                1
            };
        }
        if waited < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        break 0; // ECHILD and friends: nothing to report, say zero.
    };
    let _ = write_frame(&mut stdout, b"x", code.to_string().as_bytes());
    let _ = stdout.flush();
    0
}

/// The child half of the fork: becomes the pane's process. Never returns.
fn child_exec(spec: &Spec, master: libc::c_int, slave: libc::c_int) -> ! {
    let program = match resolve_program(spec) {
        Some(program) => program,
        None => unsafe { libc::_exit(127) },
    };
    let argv: Vec<CString> = std::iter::once(spec.file.as_str())
        .chain(spec.args.iter().map(String::as_str))
        .map(|arg| CString::new(arg).unwrap_or_else(|_| unsafe { libc::_exit(126) }))
        .collect();
    let envp = child_env(spec);

    unsafe {
        libc::setsid();
        libc::ioctl(slave, libc::TIOCSCTTY, 0);
        libc::dup2(slave, 0);
        libc::dup2(slave, 1);
        libc::dup2(slave, 2);
        if slave > 2 {
            libc::close(slave);
        }
        libc::close(master);
        let cwd = CString::new(spec.cwd.clone()).unwrap_or_else(|_| libc::_exit(126));
        libc::chdir(cwd.as_ptr());
        // execve wants ARRAYS OF POINTERS, NUL-terminated — not the Vec<CString>
        // itself (whose buffer is an array of structs). The first version of
        // this file cast the Vec's buffer and execve read garbage; every pane
        // died at exec with 127 until this indirection existed.
        let argv_ptrs = null_terminated(&argv);
        let envp_ptrs = null_terminated(&envp);
        libc::execve(program.as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
    }
    // execve only returns on failure; report like a shell would.
    unsafe { libc::_exit(127) }
}

/// `["a", "b"]` as the `*const *const c_char` C wants: a pointer array with a
/// trailing NULL. The CStrings stay owned by the caller, so the pointers are
/// valid for the execve that follows immediately.
fn null_terminated(values: &[CString]) -> Vec<*const libc::c_char> {
    let mut pointers: Vec<*const libc::c_char> =
        values.iter().map(|value| value.as_ptr()).collect();
    pointers.push(std::ptr::null());
    pointers
}

/// execvpe's search: a path with a separator is used as given, anything else
/// is looked up in the merged environment's PATH — the same command the
/// Python predecessor ran.
fn resolve_program(spec: &Spec) -> Option<CString> {
    if spec.file.contains('/') {
        return CString::new(spec.file.clone()).ok();
    }
    let path = spec
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    for dir in path.split(':') {
        let dir = if dir.is_empty() { "." } else { dir };
        let candidate = format!("{dir}/{}", spec.file);
        if let Ok(program) = CString::new(candidate) {
            if unsafe { libc::access(program.as_ptr(), libc::X_OK) } == 0 {
                return Some(program);
            }
        }
    }
    None
}

/// The child's environment: this process's own, overlaid with the spec's.
fn child_env(spec: &Spec) -> Vec<CString> {
    let mut merged: HashMap<OsString, OsString> = std::env::vars_os().collect();
    for (key, value) in &spec.env {
        merged.insert(OsString::from(key), OsString::from(value));
    }
    merged
        .into_iter()
        .filter_map(|(key, value)| {
            let mut entry = key.into_vec();
            entry.push(b'=');
            entry.extend_from_slice(value.as_os_str().as_encoded_bytes());
            CString::new(entry).ok()
        })
        .collect()
}

/// One control line. Returns false when the loop must stop (kill).
fn handle_control(line: &str, master: libc::c_int, pid: libc::pid_t, killed: &mut bool) -> bool {
    let control: Control = match serde_json::from_str(line) {
        Ok(control) => control,
        Err(_) => return true, // A malformed line is not a crash; skip it.
    };
    match control.kind.as_str() {
        "input" => {
            write_all_fd(master, control.data.as_bytes());
            true
        }
        "resize" => {
            set_winsize(master, control.rows, control.cols);
            true
        }
        "kill" => unsafe {
            libc::kill(pid, libc::SIGTERM);
            *killed = true;
            false
        },
        _ => true,
    }
}

fn write_all_fd(fd: libc::c_int, bytes: &[u8]) {
    let mut written = 0;
    while written < bytes.len() {
        let n = unsafe {
            libc::write(
                fd,
                bytes[written..].as_ptr() as *const libc::c_void,
                bytes.len() - written,
            )
        };
        if n <= 0 {
            break;
        }
        written += n as usize;
    }
}

fn set_winsize(master: libc::c_int, rows: u16, cols: u16) {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(master, libc::TIOCSWINSZ, &size as *const libc::winsize);
    }
}

/// Answer a line editor's cursor-position query, and consume the query.
///
/// The reply goes to the pty MASTER — the child's input, where a terminal
/// emulator's answer belongs. The answer is the window size, because this
/// bridge forwards bytes and emulates no screen. Consumed rather than
/// forwarded: the host renders a screen and has no use for the request.
fn answer_cursor_queries(master: libc::c_int, chunk: &mut Vec<u8>) {
    if !contains(chunk, DSR_QUERY) {
        return;
    }
    let mut size = libc::winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(master, libc::TIOCGWINSZ, &mut size as *mut libc::winsize);
    }
    let reply = format!("\x1b[{};{}R", size.ws_row, size.ws_col);
    let mut replaced = Vec::with_capacity(chunk.len());
    let mut rest = &chunk[..];
    while let Some(index) = find(rest, DSR_QUERY) {
        replaced.extend_from_slice(&rest[..index]);
        rest = &rest[index + DSR_QUERY.len()..];
    }
    replaced.extend_from_slice(rest);
    write_all_fd(master, reply.as_bytes());
    *chunk = replaced;
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle).is_some()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn write_frame(out: &mut impl Write, kind: &[u8], payload: &[u8]) -> std::io::Result<()> {
    out.write_all(kind)?;
    out.write_all(b" ")?;
    out.write_all(payload.len().to_string().as_bytes())?;
    out.write_all(b"\n")?;
    if !payload.is_empty() {
        out.write_all(payload)?;
    }
    out.flush()
}

/// stdin, as lines, without ever dropping bytes that arrived early.
///
/// The predecessor reads 4096 at a time and keeps a `pending` buffer: the
/// spec line and the first control line can share one read, and a control
/// line can straddle two. This is the same machine with a bigger read.
struct LineReader<'a> {
    source: &'a mut std::io::Stdin,
    pending: Vec<u8>,
}

impl<'a> LineReader<'a> {
    fn new(source: &'a mut std::io::Stdin) -> Self {
        Self {
            source,
            pending: Vec::new(),
        }
    }

    /// Read more of stdin into the buffer. False means EOF.
    fn pump(&mut self) -> std::io::Result<bool> {
        let mut chunk = [0u8; READ_CHUNK];
        let read = self.source.read(&mut chunk)?;
        if read == 0 {
            return Ok(false);
        }
        self.pending.extend_from_slice(&chunk[..read]);
        Ok(true)
    }

    /// The next complete line, reading more of stdin when the buffer holds
    /// none yet (the spec line itself usually needs exactly that). None means
    /// EOF with no complete line left.
    fn next_line(&mut self) -> Option<String> {
        loop {
            if let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=index).collect();
                return Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
            }
            match self.pump() {
                Ok(true) => continue,
                _ => return None,
            }
        }
    }

    /// The next COMPLETE line already in the buffer, without reading more.
    ///
    /// The forward loop drains with this, not with `next_line`: a drain that
    /// blocks for the next line sits inside one select iteration while the
    /// pty's echo goes unread — and the iteration after the block sees stdin
    /// and the master together, with the stdin branch's EOF check breaking
    /// first, so the echo is never read. Measured: a pane that echoed the
    /// write and then went mute until the child exited. The predecessor's
    /// structure — drain what the read left, never wait for more — is the one
    /// that cannot do this.
    fn take_line(&mut self) -> Option<String> {
        let index = self.pending.iter().position(|byte| *byte == b'\n')?;
        let line: Vec<u8> = self.pending.drain(..=index).collect();
        Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned())
    }
}
