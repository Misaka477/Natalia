use mux::pane::PaneId;
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

const VERSION: u8 = 2;
const TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Serialize)]
struct Claim<'a> {
    version: u8,
    #[serde(rename = "type")]
    kind_type: &'static str,
    nonce: String,
    token: &'a str,
    #[serde(rename = "terminalID")]
    terminal_id: &'a str,
    #[serde(rename = "paneID")]
    pane_id: PaneId,
    kind: &'a str,
    #[serde(rename = "byteLength")]
    byte_length: usize,
}

#[derive(Deserialize)]
struct Decision {
    version: u8,
    #[serde(rename = "type")]
    decision_type: String,
    nonce: String,
    permit: bool,
}

/// This is immediately before the existing pane write. Input bytes stay in
/// WezTerm and reach the PTY through the unmodified upstream write path.
///
/// The claim is encoded and validated identically on every platform; only the
/// transport differs, because the broker listens on a Unix domain socket on
/// POSIX hosts and on a named pipe on Windows.
pub fn claim_before_pane_write(pane_id: PaneId, kind: &'static str, byte_length: usize) -> bool {
    let endpoint = match env::var("NATALIA_NATIVE_INPUT_ENDPOINT") {
        Ok(value) => value,
        Err(_) => return true,
    };
    let token = match env::var("NATALIA_NATIVE_INPUT_TOKEN") {
        Ok(value) => value,
        Err(_) => return deny("NATALIA_NATIVE_INPUT_TOKEN is missing"),
    };
    let nonce = format!("{:016x}{:016x}", fastrand::u64(..), fastrand::u64(..));
    let terminal_id = format!("pane_{pane_id}");
    let claim = Claim {
        version: VERSION,
        kind_type: "claim",
        nonce: nonce.clone(),
        token: &token,
        terminal_id: &terminal_id,
        pane_id,
        kind,
        byte_length: byte_length.max(1),
    };
    let frame = match serde_json::to_string(&claim) {
        Ok(frame) => format!("{frame}\n"),
        Err(error) => return deny(&format!("claim encoding failed: {error:#}")),
    };
    let response = match exchange(&endpoint, &frame) {
        Ok(response) => response,
        Err(reason) => return deny(&reason),
    };
    match serde_json::from_str::<Decision>(&response) {
        Ok(decision)
            if decision.version == VERSION
                && decision.decision_type == "decision"
                && decision.nonce == nonce
                && decision.permit => true,
        Ok(_) => deny("broker denied input"),
        Err(error) => deny(&format!("broker reply invalid: {error:#}")),
    }
}

/// Sends one claim frame and reads one decision line over a Unix domain socket.
#[cfg(unix)]
fn exchange(endpoint: &str, frame: &str) -> Result<String, String> {
    let mut stream =
        UnixStream::connect(endpoint).map_err(|error| format!("broker connect failed: {error:#}"))?;
    if stream.set_read_timeout(Some(TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(TIMEOUT)).is_err()
        || stream.write_all(frame.as_bytes()).is_err()
    {
        return Err("broker exchange failed".to_string());
    }
    let mut response = String::new();
    if BufReader::new(stream).read_line(&mut response).is_err() {
        return Err("broker did not reply".to_string());
    }
    Ok(response)
}

/// Sends one claim frame and reads one decision line over a Windows named pipe.
///
/// A named pipe is opened as a regular duplex file, which matches the byte mode
/// pipe the broker creates. Because that handle offers no per-operation timeout,
/// the whole exchange runs on a worker thread under a single deadline; blocking
/// here would otherwise stall the window's input path.
#[cfg(windows)]
fn exchange(endpoint: &str, frame: &str) -> Result<String, String> {
    use std::fs::OpenOptions;
    use std::sync::mpsc;
    use std::thread;

    // The deadline covers both directions, mirroring the per-operation budgets
    // used on POSIX.
    const BUDGET: Duration = Duration::from_millis(TIMEOUT.as_millis() as u64 * 2);
    const BUSY_ATTEMPTS: u32 = 5;
    const BUSY_BACKOFF: Duration = Duration::from_millis(20);

    let endpoint = endpoint.to_string();
    let frame = frame.to_string();
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("natalia-input-claim".to_string())
        .spawn(move || {
            let result = (|| {
                let mut last = String::from("broker connect failed");
                for attempt in 0..BUSY_ATTEMPTS {
                    match OpenOptions::new().read(true).write(true).open(&endpoint) {
                        Ok(mut pipe) => {
                            pipe.write_all(frame.as_bytes())
                                .map_err(|error| format!("broker exchange failed: {error:#}"))?;
                            pipe.flush()
                                .map_err(|error| format!("broker exchange failed: {error:#}"))?;
                            let mut response = String::new();
                            BufReader::new(pipe)
                                .read_line(&mut response)
                                .map_err(|error| format!("broker did not reply: {error:#}"))?;
                            return Ok(response);
                        }
                        Err(error) => {
                            // Every pipe instance may be serving another claim.
                            last = format!("broker connect failed: {error:#}");
                            if attempt + 1 < BUSY_ATTEMPTS {
                                thread::sleep(BUSY_BACKOFF);
                            }
                        }
                    }
                }
                Err(last)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| format!("broker thread failed: {error:#}"))?;
    match receiver.recv_timeout(BUDGET) {
        Ok(result) => result,
        Err(_) => Err("broker did not reply".to_string()),
    }
}

#[cfg(not(any(unix, windows)))]
fn exchange(_: &str, _: &str) -> Result<String, String> {
    // The broker endpoint is only ever published by Natalia, which does not run
    // on other platforms. Failing closed keeps the claim from being bypassed.
    Err("the native input broker transport is unavailable on this platform".to_string())
}

fn deny(reason: &str) -> bool {
    log::warn!("NATALIA native input denied: {reason}");
    false
}
