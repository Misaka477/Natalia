//! `confinement-exec` — the exec primitive's front wrapper (sandbox study §6,
//! decision 25; Linux phase 1: landlock + the rlimit family, zero binary
//! dependencies).
//!
//! Two roles in one binary, mirroring dsh's `landlock-run` launcher
//! (`devref/deepseek-harness/packages/sandbox/sandbox-local/src/index.ts`):
//!
//! - `--probe`: report capability as JSON (kernel ABI + the supported rlimits).
//! - otherwise: apply the requested confinement to *this* process, then
//!   `exec` the target command in its place. Landlock rules and rlimits
//!   survive `execve`, so the wrapper needs no fork and the confined process
//!   is exactly the command the caller spawned.
//!
//! The wrapper is policy-agnostic: `--read-write <path>` (repeatable) is the
//! write allow-list exactly as composed by the caller — zero paths means
//! "may write nothing" (read-only), which is how the read-only mode is
//! spelled. `danger-full-access` never reaches this binary: the caller runs
//! that mode unconfined (the Windows-degradation story keeps danger working
//! when no backend exists, sandbox study §6).
//!
//! Failure is closed: if landlock is required and unavailable, or a rule or
//! limit cannot be applied, the wrapper exits 2 without running the command.
//! There is deliberately no path that runs unconstrained when confinement was
//! asked for (dsh: "Missing or unusable confinement fails closed rather than
//! returning the original argv").
//!
//! Every kernel constant below is read from the reference UAPI
//! (`devref/linux/include/uapi/linux/landlock.h`) and the official userspace
//! guide (`devref/linux/Documentation/userspace-api/landlock.rst`), not
//! remembered: the struct shape, the bit values, the ABI fallback chain, and
//! the `O_PATH` parent-fd pattern all follow those documents.

use std::env;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

// Syscall numbers: devref/linux/include/uapi/asm-generic/unistd.h 797-802.
const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;

// landlock.h: LANDLOCK_CREATE_RULESET_VERSION (1U << 0), rule type
// LANDLOCK_RULE_PATH_BENEATH = 1.
const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
const LANDLOCK_RULE_PATH_BENEATH: i32 = 1;

// Filesystem access rights (landlock.h, values 1<<1 .. 1<<14). The ruleset
// *handles* only the write family: the mode axis is "where may you WRITE",
// so read and execute rights stay unhandled (unrestricted) by construction.
const ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
const ACCESS_FS_REFER: u64 = 1 << 13; // ABI 2+
const ACCESS_FS_TRUNCATE: u64 = 1 << 14; // ABI 3+

const HANDLED_WRITE_ACCESSES: u64 = ACCESS_FS_WRITE_FILE
    | ACCESS_FS_REMOVE_DIR
    | ACCESS_FS_REMOVE_FILE
    | ACCESS_FS_MAKE_CHAR
    | ACCESS_FS_MAKE_DIR
    | ACCESS_FS_MAKE_REG
    | ACCESS_FS_MAKE_SOCK
    | ACCESS_FS_MAKE_FIFO
    | ACCESS_FS_MAKE_BLOCK
    | ACCESS_FS_MAKE_SYM
    | ACCESS_FS_REFER
    | ACCESS_FS_TRUNCATE;

/// landlock.h's `struct landlock_ruleset_attr`. All fields beyond the first
/// are part of the current UAPI (ABI 10); they stay zero because this wrapper
/// handles filesystem rights only. The official example passes
/// `sizeof(ruleset_attr)`, and the kernel's `copy_struct_from_user` accepts a
/// larger-than-known struct when the tail is zero — the documented evolution
/// mechanism, so an older kernel reads the prefix it knows.
#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
    quiet_access_fs: u64,
    quiet_access_net: u64,
    quiet_scoped: u64,
}

/// landlock.h's `struct landlock_path_beneath_attr`.
#[repr(C)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i64,
}

fn landlock_abi() -> i64 {
    // The documented capability probe: null attr + the VERSION flag returns
    // the highest supported ABI, or a negative errno (ENOSYS when absent).
    unsafe {
        libc::syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            std::ptr::null::<LandlockRulesetAttr>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    }
}

fn fail(message: &str) -> ! {
    eprintln!("confinement-exec: {message}");
    // Exit 2 is the refusal code (dsh's LAUNCHER_FAILURE_EXIT role): a spawn
    // classification layer tells "the runner refused" from "the command ran".
    std::process::exit(2);
}

fn probe() {
    let abi = landlock_abi();
    let abi = if abi > 0 { abi } else { 0 };
    println!(
        "{{\"landlockABI\":{},\"rlimits\":[\"as\",\"cpu\",\"fsize\",\"nproc\",\"nofile\"]}}",
        abi
    );
}

/// Apply the write allow-list: a ruleset handling the write family, one
/// `path_beneath` rule per writable root, then `restrict_self`. An empty list
/// grants no rule, so writes are denied everywhere (the read-only spelling).
fn confine_writes(write_roots: &[PathBuf]) {
    let abi = landlock_abi();
    if abi < 1 {
        fail("landlock is unavailable; refusing to run unconstrained (fail-closed)");
    }
    // landlock.rst's ABI fallback: REFER needs ABI 2, TRUNCATE needs ABI 3.
    let mut handled = HANDLED_WRITE_ACCESSES;
    if abi < 2 {
        handled &= !ACCESS_FS_REFER;
    }
    if abi < 3 {
        handled &= !ACCESS_FS_TRUNCATE;
    }
    let attr = LandlockRulesetAttr {
        handled_access_fs: handled,
        handled_access_net: 0,
        scoped: 0,
        quiet_access_fs: 0,
        quiet_access_net: 0,
        quiet_scoped: 0,
    };
    let ruleset_fd = unsafe {
        libc::syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const LandlockRulesetAttr,
            std::mem::size_of::<LandlockRulesetAttr>(),
            0u32,
        )
    };
    if ruleset_fd < 0 {
        fail("landlock_create_ruleset failed");
    }
    for root in write_roots {
        // The official example opens the rule target with O_PATH; the kernel
        // resolves the path once and compares the file identity afterwards.
        let croot = match CString::new(root.as_os_str().as_bytes()) {
            Ok(value) => value,
            Err(_) => fail("a writable root contains a NUL byte"),
        };
        let dir_fd = unsafe { libc::open(croot.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if dir_fd < 0 {
            fail(&format!("cannot open writable root {}", root.display()));
        }
        // fs.c `landlock_append_fs_rule`: a non-directory object only accepts
        // rights inside ACCESS_FILE (EXECUTE|WRITE|READ|TRUNCATE|...). The
        // write family for a file is WRITE_FILE (+TRUNCATE when handled);
        // handing a character device like /dev/null the directory mask would
        // be EINVAL.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(dir_fd, c"".as_ptr(), &mut stat, libc::AT_EMPTY_PATH) } != 0 {
            unsafe { libc::close(dir_fd) };
            fail(&format!("cannot stat writable root {}", root.display()));
        }
        let is_dir = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
        let allowed = if is_dir {
            handled
        } else {
            handled & (ACCESS_FS_WRITE_FILE | ACCESS_FS_TRUNCATE)
        };
        let rule = LandlockPathBeneathAttr {
            allowed_access: allowed,
            parent_fd: dir_fd as i64,
        };
        // Syscall order (landlock.h / syscalls.c): (ruleset_fd, rule_type,
        // rule_attr, flags) — the type comes BEFORE the attribute pointer.
        let added = unsafe {
            libc::syscall(
                SYS_LANDLOCK_ADD_RULE,
                ruleset_fd,
                LANDLOCK_RULE_PATH_BENEATH,
                &rule as *const LandlockPathBeneathAttr,
                0u32,
            )
        };
        unsafe { libc::close(dir_fd) };
        if added != 0 {
            fail(&format!("landlock_add_rule failed for {}", root.display()));
        }
    }
    // restrict_self requires no_new_privs (or CAP_SYS_ADMIN); setting it here
    // also keeps an exec'd setuid binary from growing past the confinement.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        fail("prctl(PR_SET_NO_NEW_PRIVS) failed");
    }
    if unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0u32) } != 0 {
        fail("landlock_restrict_self failed");
    }
    unsafe { libc::close(ruleset_fd as i32) };
}

/// Apply one resource limit before exec (the study's rlimit family — the
/// resource-exhaustion face dsh's model lacks).
fn apply_rlimit(name: &str, value: u64) {
    let resource = match name {
        "as" => libc::RLIMIT_AS,
        "cpu" => libc::RLIMIT_CPU,
        "fsize" => libc::RLIMIT_FSIZE,
        "nproc" => libc::RLIMIT_NPROC,
        "nofile" => libc::RLIMIT_NOFILE,
        _ => fail("unknown rlimit (expected as|cpu|fsize|nproc|nofile)"),
    };
    let limit = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    if unsafe { libc::setrlimit(resource, &limit) } != 0 {
        fail(&format!("setrlimit({name}) failed"));
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: confinement-exec --probe | [--read-write <path>]* [--rlimit <as|cpu|fsize|nproc|nofile>=<bytes>]* -- <command> [args...]"
    );
    std::process::exit(2);
}

fn main() {
    let mut args = env::args().skip(1);
    let mut write_roots: Vec<PathBuf> = Vec::new();
    let mut rlimits: Vec<(String, u64)> = Vec::new();
    let mut command: Vec<String> = Vec::new();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--probe" => {
                probe();
                return;
            }
            "--read-write" => write_roots.push(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            "--rlimit" => {
                let spec = args.next().unwrap_or_else(|| usage());
                let (name, value) = match spec.split_once('=') {
                    Some((name, value)) => (name.to_string(), value),
                    None => usage(),
                };
                let value: u64 = value.parse().unwrap_or_else(|_| usage());
                rlimits.push((name, value));
            }
            "--" => {
                command.extend(args);
                break;
            }
            _ => usage(),
        }
    }
    if command.is_empty() {
        usage();
    }

    // Limits first: cheap, and a failure must not leave a half-confined
    // process behind before the landlock step refuses.
    for (name, value) in &rlimits {
        apply_rlimit(name, *value);
    }
    confine_writes(&write_roots);

    let error = Command::new(&command[0]).args(&command[1..]).exec();
    fail(&format!("exec failed: {error}"));
}
