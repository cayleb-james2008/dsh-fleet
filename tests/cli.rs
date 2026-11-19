//! The binary as a user runs it: the argument handling and its exit codes.

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
