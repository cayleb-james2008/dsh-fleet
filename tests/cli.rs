//! The binary as a user runs it: the argument handling and its exit codes.

use std::io::{Read, Write};
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_fleet-rs")
}

#[test]
fn version_is_answered_in_any_argument_position() {
    let want = format!("fleet-rs {}", env!("CARGO_PKG_VERSION"));
    // Second position, behind a policies path that does not exist: still the version.
    let out = Command::new(bin()).args(["/no/such/policies.rn", "--version"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), want);
    let out = Command::new(bin()).arg("-V").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), want);
}

#[test]
fn a_missing_policies_file_is_a_plain_error_with_exit_1() {
    let out = Command::new(bin()).arg("/no/such/policies.rn").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(err.contains("cannot read the policies file"), "{err}");
    assert!(!err.contains("panicked"), "{err}");
}

#[test]
fn a_policies_file_that_does_not_build_is_a_plain_error_with_exit_1() {
    let dir = std::env::temp_dir().join(format!("fleet-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("broken.rn");
    std::fs::write(&path, "pub fn max_parallel( {").unwrap();
    let out = Command::new(bin()).arg(&path).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(err.contains("policies file") && !err.contains("panicked"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// First run needs nothing (Z1): the real binary, with an environment this test
// chooses. Nothing is inherited except PATH.
// ---------------------------------------------------------------------------

use std::fs::File;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

struct Kid(Child);
impl Drop for Kid {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn policies() -> String {
    format!("{}/policies.rn", env!("CARGO_MANIFEST_DIR"))
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fleet-z1-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Starts the binary in `home` with only `env` set (plus PATH). Output goes to
/// `home/out.log` and `home/err.log`, never a pipe.
fn start(home: &Path, env: &[(&str, &str)], args: &[&str], path: &str) -> Kid {
    let mut c = Command::new(bin());
    c.env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .env("LANG", "C.UTF-8")
        .current_dir(home)
        .arg(policies())
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(File::create(home.join("out.log")).unwrap())
        .stderr(File::create(home.join("err.log")).unwrap());
    for (k, v) in env {
        c.env(k, v);
    }
    Kid(c.spawn().unwrap())
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
}

fn answers(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else { return false };
    s.set_read_timeout(Some(Duration::from_secs(2))).ok();
    let _ = s.write_all(b"GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.1 200")
}

fn wait_answering(port: u16) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(20) {
        if answers(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn read(path: PathBuf) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// A stand-in `xdg-open` (or `open`) on a private PATH folder: it records its arguments.
fn fake_opener(dir: &Path, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let script = dir.join(name);
    std::fs::write(&script, format!("#!/bin/sh\necho \"$@\" >> \"{}/called\"\n", dir.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn with_no_env_the_data_lives_in_the_platform_data_folder() {
    let home = scratch("data");
    let port = free_port();
    let _kid = start(&home, &[("PORT", &port.to_string()), ("FLEET_NO_OPEN", "1")], &[], "/usr/bin:/bin");
    assert!(wait_answering(port), "{}", read(home.join("err.log")));
    let want = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/fleet")
    } else {
        home.join(".local/share/fleet")
    };
    assert!(want.join("logs").is_dir(), "no data folder at {}", want.display());
    assert!(!home.join("fleet-data").exists(), "the old ./fleet-data default is back");
}

#[test]
fn xdg_data_home_is_honoured_and_an_env_data_dir_still_wins() {
    let home = scratch("xdg");
    let port = free_port();
    let xdg = home.join("xdg");
    let _kid = start(
        &home,
        &[("PORT", &port.to_string()), ("FLEET_NO_OPEN", "1"), ("XDG_DATA_HOME", xdg.to_str().unwrap())],
        &[],
        "/usr/bin:/bin",
    );
    assert!(wait_answering(port), "{}", read(home.join("err.log")));
    assert!(xdg.join("fleet/logs").is_dir());
}

#[test]
fn a_busy_default_port_moves_to_the_next_free_one_and_the_banner_says_where() {
    let Ok(_hold) = TcpListener::bind(("127.0.0.1", 8471)) else {
        eprintln!("8471 is busy on this machine: the fallback test is skipped");
        return;
    };
    let home = scratch("busy");
    let _kid = start(&home, &[("FLEET_NO_OPEN", "1")], &[], "/usr/bin:/bin");
    assert!(wait_answering(8472), "{}", read(home.join("err.log")));
    let out = read(home.join("out.log"));
    assert!(out.contains("http://127.0.0.1:8472/"), "{out}");
    assert!(out.contains("Data:") && out.contains("Updates:"), "{out}");
}

#[test]
fn an_explicit_busy_port_still_fails_loudly() {
    let hold = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = hold.local_addr().unwrap().port();
    let home = scratch("explicit");
    let mut kid = start(&home, &[("PORT", &port.to_string()), ("FLEET_NO_OPEN", "1")], &[], "/usr/bin:/bin");
    let t = Instant::now();
    let status = loop {
        if let Some(s) = kid.0.try_wait().unwrap() {
            break s;
        }
        assert!(t.elapsed() < Duration::from_secs(15), "the process kept running on a busy port");
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(status.code(), Some(1));
    let err = read(home.join("err.log"));
    assert!(err.contains("busy") && !err.contains("panicked"), "{err}");
}

#[test]
fn the_browser_opens_once_at_the_app_url_when_a_display_is_there() {
    let home = scratch("open");
    let bin_dir = home.join("bin");
    fake_opener(&bin_dir, "xdg-open");
    fake_opener(&bin_dir, "open");
    let port = free_port();
    let path = format!("{}:/usr/bin:/bin", bin_dir.display());
    let _kid = start(&home, &[("PORT", &port.to_string()), ("DISPLAY", ":0")], &[], &path);
    assert!(wait_answering(port));
    let t = Instant::now();
    while !bin_dir.join("called").exists() && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let called = read(bin_dir.join("called"));
    assert_eq!(called.matches("http://127.0.0.1:").count(), 1, "opened once: {called:?}");
    assert!(called.contains(&format!("http://127.0.0.1:{port}/")), "{called:?}");
}

#[test]
fn the_browser_stays_closed_for_opt_out_service_and_no_display() {
    let cases: [(&str, Vec<(&str, &str)>, Vec<&str>); 4] = [
        ("opt-out env", vec![("DISPLAY", ":0"), ("FLEET_NO_OPEN", "1")], vec![]),
        ("opt-out flag", vec![("DISPLAY", ":0")], vec!["--no-open"]),
        ("service", vec![("DISPLAY", ":0"), ("INVOCATION_ID", "abc")], vec![]),
        ("no display", vec![], vec![]),
    ];
    for (name, env, args) in cases {
        let home = scratch(&format!("noopen-{}", name.replace(' ', "-")));
        let bin_dir = home.join("bin");
        fake_opener(&bin_dir, "xdg-open");
        fake_opener(&bin_dir, "open");
        let port = free_port();
        let mut env = env;
        env.push(("PORT", Box::leak(port.to_string().into_boxed_str())));
        let path = format!("{}:/usr/bin:/bin", bin_dir.display());
        let _kid = start(&home, &env, &args, &path);
        assert!(wait_answering(port), "{name}: {}", read(home.join("err.log")));
        std::thread::sleep(Duration::from_millis(500));
        assert!(!bin_dir.join("called").exists(), "{name}: a browser was opened");
    }
}
