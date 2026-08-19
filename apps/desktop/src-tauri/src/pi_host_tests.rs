//! Rust bridge tests (R3) — drive shared HostChildSession / PiHostManager helpers.

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use crate::pi_host::WindowsHostJob;
    use crate::pi_host::{
        build_shutdown_line, bundled_bash_from_git, drain_complete_lines, extract_host_instance_id,
        finish_monitor_task, host_child_explicit_env, is_current_child_generation,
        node_executable_name, node_runtime_candidates, push_stderr_tail, read_bounded_lossy_line,
        read_bounded_utf8_line, resolve_node_from_dirs, resolve_portable_git_from_dirs,
        should_auto_restart, strip_verbatim_prefix, write_host_stdin, AutoRestartEpoch,
        HostChildSession, APP_EXIT_HOST_SHUTDOWN_GRACE, HOST_SHUTDOWN_GRACE,
        MAX_HOST_STDOUT_LINE_BYTES, PIDECK_BUNDLED_BASH, PIDECK_BUNDLED_GIT,
    };
    #[cfg(unix)]
    use crate::pi_host::{is_executable_file, unix_child_exited_without_reaping};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[cfg(unix)]
    struct UnixPidGuard(Vec<libc::pid_t>);

    #[cfg(unix)]
    impl Drop for UnixPidGuard {
        fn drop(&mut self) {
            for pid in self.0.drain(..) {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }

    #[cfg(unix)]
    fn unix_descendant_fixture(crash_host: bool) -> String {
        let parent_lifecycle = if crash_host {
            "setTimeout(() => process.exit(17), 75);"
        } else {
            "setInterval(() => {}, 1000);"
        };
        r#"
const { spawn } = require('child_process');
const descendant = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: 'ignore' }
);
process.stdout.write(String(process.pid) + ',' + String(descendant.pid) + '\n');
__PARENT_LIFECYCLE__
"#
        .replace("__PARENT_LIFECYCLE__", parent_lifecycle)
    }

    #[cfg(unix)]
    fn unix_graceful_descendant_fixture() -> String {
        r#"
const { spawn } = require('child_process');
const readline = require('readline');
const descendant = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: 'ignore' }
);
process.stdout.write(String(process.pid) + ',' + String(descendant.pid) + '\n');
readline.createInterface({ input: process.stdin }).once('line', () => process.exit(0));
setInterval(() => {}, 1000);
"#
        .to_string()
    }

    #[cfg(unix)]
    fn read_unix_fixture_pids(session: &mut HostChildSession) -> (libc::pid_t, libc::pid_t) {
        let line = session
            .read_line_timeout(Duration::from_secs(5))
            .expect("fixture PIDs");
        let mut fields = line.split(',');
        let host_pid = fields
            .next()
            .expect("Host PID")
            .parse::<libc::pid_t>()
            .expect("numeric Host PID");
        let descendant_pid = fields
            .next()
            .expect("descendant PID")
            .parse::<libc::pid_t>()
            .expect("numeric descendant PID");
        assert!(
            fields.next().is_none(),
            "unexpected fixture PID payload: {line}"
        );
        (host_pid, descendant_pid)
    }

    #[cfg(unix)]
    fn unix_process_exists(pid: libc::pid_t) -> bool {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(unix)]
    fn wait_for_unix_process_exit(pid: libc::pid_t, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !unix_process_exists(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !unix_process_exists(pid)
    }

    #[cfg(unix)]
    fn wait_for_unix_child_exit_without_reaping(pid: libc::pid_t, timeout: Duration) -> bool {
        let child_id = u32::try_from(pid).expect("positive child PID");
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            match unix_child_exited_without_reaping(Some(child_id)) {
                Ok(true) => return true,
                Ok(false) => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => panic!("probe child {pid} without reaping: {error}"),
            }
        }
        unix_child_exited_without_reaping(Some(child_id)).expect("final non-reaping child probe")
    }

    fn fixture_script() -> String {
        r#"
const rl = require('readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({
  protocolVersion:1,event:'host.ready',sequence:1,timestamp:Date.now(),
  hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
  sessionId:null,sessionRevision:0,packageRevision:0,
  payload:{hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,sessionId:null,sessionRevision:0,packageRevision:0,protocolVersion:1,sdkVersion:'0.82.1',nodeVersion:process.version,agentDir:'/tmp',phase:'waitingForWorkspace',capabilities:{packageUpdateCheck:false,extensionUi:true,sessionExport:false},modelConfigHealth:{state:'ok',source:'ModelRegistry.getError'}}
})+'\n');
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.method === 'system.hello') {
      process.stdout.write(JSON.stringify({
        protocolVersion:1,id:req.id,method:'system.hello',ok:true,
        hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
        sessionId:null,sessionRevision:0,packageRevision:0,
        result:{hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,sessionId:null,sessionRevision:0,packageRevision:0,protocolVersion:1,sdkVersion:'0.82.1',nodeVersion:process.version,agentDir:'/tmp',phase:'waitingForWorkspace',capabilities:{packageUpdateCheck:false,extensionUi:true,sessionExport:false},modelConfigHealth:{state:'ok',source:'ModelRegistry.getError'}}
      })+'\n');
    } else if (req.method === 'system.shutdown') {
      const expected = req.context && req.context.expectedHostInstanceId;
      if (expected !== 'test-host') {
        process.stdout.write(JSON.stringify({
          protocolVersion:1,id:req.id,method:'system.shutdown',ok:false,
          hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
          sessionId:null,sessionRevision:0,packageRevision:0,
          error:{code:'STALE_REVISION',message:'host mismatch',retryable:false}
        })+'\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        protocolVersion:1,id:req.id,method:'system.shutdown',ok:true,
        hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
        sessionId:null,sessionRevision:0,packageRevision:0,
        result:{accepted:true}
      })+'\n');
      process.exit(0);
    }
  } catch (e) {
    process.stderr.write(String(e)+'\n');
  }
});
"#
        .to_string()
    }

    #[test]
    fn auto_restart_epoch_exactly_once_then_fatal() {
        let mut ep = AutoRestartEpoch::new(true);
        assert!(ep.on_unexpected_exit()); // first crash → restart
        assert_eq!(ep.restart_count, 1);
        assert!(!ep.armed);
        assert!(!ep.on_unexpected_exit()); // second crash → stay fatal
        assert!(!should_auto_restart(true, 1));
        ep.on_manual_restart();
        assert_eq!(ep.restart_count, 0);
        assert!(ep.armed);
        assert!(ep.on_unexpected_exit());
    }

    #[test]
    fn delayed_monitor_is_retired_when_child_generation_advances() {
        assert!(is_current_child_generation(7, 7));
        assert!(!is_current_child_generation(8, 7));
    }

    #[test]
    fn auto_restart_disabled_never_restarts() {
        let mut ep = AutoRestartEpoch::new(false);
        assert!(!ep.on_unexpected_exit());
    }

    #[test]
    fn strip_verbatim_prefix_from_pi_host() {
        let p = strip_verbatim_prefix(PathBuf::from(r"\\?\C:\foo\bar.js"));
        assert_eq!(p, PathBuf::from(r"C:\foo\bar.js"));
        let unc = strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share"));
        assert_eq!(unc, PathBuf::from(r"\\server\share"));
    }

    #[test]
    fn stripped_bundled_git_executable_is_cmd_compatible() {
        // resource_dir on Windows is derived from a canonicalized (\\?\) exe
        // path. PIDECK_BUNDLED_GIT and later internal PATH entries must stay
        // cmd.exe-compatible — cmd cannot handle \\?\ paths.
        let node = strip_verbatim_prefix(PathBuf::from(
            r"\\?\C:\Users\Admin\AppData\Local\PiDeck\resources\node\node.exe",
        ));
        assert_eq!(
            node,
            PathBuf::from(r"C:\Users\Admin\AppData\Local\PiDeck\resources\node\node.exe"),
        );
        let node_dir = node.parent().expect("node dir");
        assert!(!node_dir.to_string_lossy().starts_with(r"\\?\"));
        let git_exe = strip_verbatim_prefix(PathBuf::from(
            r"\\?\C:\Users\Admin\AppData\Local\PiDeck\resources\git\cmd\git.exe",
        ));
        assert_eq!(
            git_exe,
            PathBuf::from(r"C:\Users\Admin\AppData\Local\PiDeck\resources\git\cmd\git.exe"),
        );
        assert!(!git_exe.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn host_child_explicit_env_omits_path_and_passes_bundled_git() {
        let agent = PathBuf::from(r"C:\Users\Admin\AppData\Roaming\PiDeck\agent");
        let cache = PathBuf::from(r"C:\Users\Admin\AppData\Local\PiDeck\cache\pi-host");
        let node_modules = PathBuf::from(r"C:\Program Files\PiDeck 中文\node_modules");
        let git = PathBuf::from(r"C:\Program Files\PiDeck 中文\git\cmd\git.exe");
        let bash = PathBuf::from(r"C:\Program Files\PiDeck 中文\git\bin\bash.exe");
        let env =
            host_child_explicit_env(&agent, &cache, Some(&node_modules), Some(&git), Some(&bash));
        let keys: Vec<String> = env
            .iter()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert!(!keys.iter().any(|key| key.eq_ignore_ascii_case("PATH")));
        assert!(keys.contains(&"PI_CODING_AGENT_DIR".to_string()));
        assert!(keys.contains(&"PIDECK_HOST_CACHE_DIR".to_string()));
        assert!(keys.contains(&"NODE_PATH".to_string()));
        assert!(keys.contains(&PIDECK_BUNDLED_GIT.to_string()));
        assert!(keys.contains(&PIDECK_BUNDLED_BASH.to_string()));
        let git_value = env
            .iter()
            .find(|(key, _)| key == PIDECK_BUNDLED_GIT)
            .map(|(_, value)| value.to_string_lossy().into_owned())
            .expect("bundled git");
        assert_eq!(git_value, git.to_string_lossy());
        assert!(git_value.contains("PiDeck 中文"));
        assert!(git_value.contains("Program Files"));
        let bash_value = env
            .iter()
            .find(|(key, _)| key == PIDECK_BUNDLED_BASH)
            .map(|(_, value)| value.to_string_lossy().into_owned())
            .expect("bundled bash");
        assert_eq!(bash_value, bash.to_string_lossy());
        assert!(bash_value.contains("PiDeck 中文"));
    }

    #[test]
    fn host_child_explicit_env_omits_bundled_git_when_absent() {
        let env = host_child_explicit_env(
            Path::new("/tmp/agent"),
            Path::new("/tmp/cache"),
            None,
            None,
            None,
        );
        assert!(env.iter().all(|(key, _)| key != PIDECK_BUNDLED_GIT
            && key != PIDECK_BUNDLED_BASH
            && !key.eq_ignore_ascii_case("PATH")));
    }

    fn runtime_fixture_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pideck-host-runtime-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("runtime fixture root");
        root
    }

    fn write_executable_fixture(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent");
        }
        std::fs::write(path, b"fixture").expect("write fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .expect("make fixture executable");
        }
    }

    #[test]
    fn release_missing_bundled_node_is_fatal() {
        let empty = runtime_fixture_root("empty-node");
        let error = resolve_node_from_dirs(Some(&empty), Some(&empty), false)
            .expect_err("release must require bundled Node");
        assert!(error.contains("bundled Node not found"));
        let _ = std::fs::remove_dir_all(empty);
    }

    #[test]
    fn debug_missing_bundled_node_falls_back() {
        let empty = runtime_fixture_root("debug-node");
        let resolved = resolve_node_from_dirs(Some(&empty), Some(&empty), true)
            .expect("debug may fall back to PATH node");
        assert!(!resolved.as_os_str().is_empty());
        let _ = std::fs::remove_dir_all(empty);
    }

    #[test]
    fn resolve_node_strips_verbatim_and_accepts_spaces_and_non_ascii() {
        let root = runtime_fixture_root("node-unicode");
        let resource = root.join("Program Files").join("PiDeck 中文");
        write_executable_fixture(&resource.join("node").join(node_executable_name()));
        let resolved = resolve_node_from_dirs(Some(&resource), None, false).expect("bundled node");
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
        assert!(resolved.ends_with(node_executable_name()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn debug_missing_bundled_git_falls_back_to_none() {
        let empty = runtime_fixture_root("debug-git");
        let resolved = resolve_portable_git_from_dirs(Some(&empty), Some(&empty), true)
            .expect("debug git fallback");
        assert!(resolved.is_none());
        let _ = std::fs::remove_dir_all(empty);
    }

    #[cfg(windows)]
    #[test]
    fn release_missing_bundled_git_is_fatal_on_windows() {
        let empty = runtime_fixture_root("empty-git");
        let error = resolve_portable_git_from_dirs(Some(&empty), Some(&empty), false)
            .expect_err("release Windows must require bundled Git");
        assert!(error.contains("bundled Portable Git not found"));
        let _ = std::fs::remove_dir_all(empty);
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_has_no_bundled_portable_git() {
        let empty = runtime_fixture_root("unix-git");
        assert_eq!(
            resolve_portable_git_from_dirs(Some(&empty), Some(&empty), false).expect("unix git"),
            None
        );
        let _ = std::fs::remove_dir_all(empty);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_portable_git_returns_stripped_git_exe() {
        let root = runtime_fixture_root("git-unicode");
        let resource = root.join("Program Files").join("PiDeck 中文");
        let git_exe = resource.join("git").join("cmd").join("git.exe");
        write_executable_fixture(&git_exe);
        let resolved = resolve_portable_git_from_dirs(Some(&resource), None, false)
            .expect("bundled git")
            .expect("git.exe path");
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("git.exe")
        );
        assert!(resolved.to_string_lossy().contains("PiDeck 中文"));
        assert!(resolved.to_string_lossy().contains("Program Files"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_bash_from_git_returns_stripped_bash_exe() {
        let root = runtime_fixture_root("bash-unicode");
        let resource = root.join("Program Files").join("PiDeck 中文");
        let git_exe = resource.join("git").join("cmd").join("git.exe");
        let bash_exe = resource.join("git").join("bin").join("bash.exe");
        write_executable_fixture(&git_exe);
        write_executable_fixture(&bash_exe);
        let resolved = bundled_bash_from_git(&git_exe).expect("bundled bash");
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("bash.exe")
        );
        assert!(resolved.to_string_lossy().contains("PiDeck 中文"));
        assert!(resolved.to_string_lossy().contains("Program Files"));
        assert_eq!(resolved, strip_verbatim_prefix(bash_exe));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_bash_from_git_is_absent_when_bash_is_missing() {
        let root = runtime_fixture_root("bash-missing");
        let git_exe = root.join("git").join("cmd").join("git.exe");
        write_executable_fixture(&git_exe);
        assert_eq!(bundled_bash_from_git(&git_exe), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_node_candidates_match_the_target_platform() {
        let expected = if cfg!(windows) { "node.exe" } else { "node" };
        assert_eq!(node_executable_name(), expected);
        for candidate in node_runtime_candidates(std::path::Path::new("runtime")) {
            assert_eq!(
                candidate.file_name().and_then(|name| name.to_str()),
                Some(expected)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_node_candidate_must_be_executable() {
        use std::os::unix::fs::PermissionsExt;

        let path =
            std::env::temp_dir().join(format!("pideck-node-candidate-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"fixture").expect("write candidate");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("make candidate non-executable");
        assert!(!is_executable_file(&path));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make candidate executable");
        assert!(is_executable_file(&path));

        std::fs::remove_file(path).expect("remove candidate");
    }

    #[test]
    fn extract_host_instance_id_from_ready_line() {
        let line = r#"{"protocolVersion":1,"event":"host.ready","hostInstanceId":"abc-123","payload":{"hostInstanceId":"abc-123"}}"#;
        assert_eq!(extract_host_instance_id(line).as_deref(), Some("abc-123"));
        assert!(extract_host_instance_id("not-json").is_none());
    }

    #[test]
    fn build_shutdown_uses_exact_host_id_not_star() {
        let line = build_shutdown_line("real-host-id", "shutdown");
        assert!(line.contains(r#""expectedHostInstanceId":"real-host-id""#));
        assert!(!line.contains(r#""*""#));
    }

    #[test]
    fn app_exit_uses_a_shorter_host_grace_period_than_restart() {
        assert_eq!(APP_EXIT_HOST_SHUTDOWN_GRACE, Duration::from_secs(1));
        assert!(APP_EXIT_HOST_SHUTDOWN_GRACE < HOST_SHUTDOWN_GRACE);
    }

    #[test]
    fn drain_complete_lines_partial_buffering() {
        let mut buf = String::new();
        let mut lines = drain_complete_lines(&mut buf, r#"{"event":"ho"#);
        assert!(lines.is_empty());
        assert!(!buf.is_empty());
        lines = drain_complete_lines(&mut buf, r#"st.ready","hostInstanceId":"x"}"#);
        assert!(lines.is_empty()); // still no newline
        lines = drain_complete_lines(&mut buf, "\n{\"b\":2}\n");
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("host.ready"));
        assert!(lines[1].contains("\"b\":2"));
        assert!(buf.is_empty());
    }

    #[test]
    fn stderr_tail_bounded() {
        let mut logs = Vec::new();
        for i in 0..60 {
            push_stderr_tail(&mut logs, format!("line{i}"), 50);
        }
        assert_eq!(logs.len(), 50);
        assert_eq!(logs[0], "line10");
    }

    #[tokio::test]
    async fn bounded_jsonl_reader_accepts_limit_and_rejects_oversize_line() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let write_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer
                .write_all(b"12345678\n123456789\nok\n")
                .await
                .unwrap();
        });
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();

        assert_eq!(
            read_bounded_utf8_line(&mut reader, &mut line, 9)
                .await
                .unwrap(),
            9
        );
        assert_eq!(line, "12345678\n");

        let error = read_bounded_utf8_line(&mut reader, &mut line, 8)
            .await
            .expect_err("oversize JSONL line must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("8 byte limit"));

        assert_eq!(
            read_bounded_utf8_line(&mut reader, &mut line, 8)
                .await
                .unwrap(),
            3
        );
        assert_eq!(line, "ok\n");
        write_task.await.unwrap();
    }

    #[tokio::test]
    async fn bounded_stderr_reader_replaces_invalid_utf8_and_keeps_reading() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer
                .write_all(&[b'b', b'a', b'd', 0xff, b'\n', b'o', b'k', b'\n'])
                .await
                .unwrap();
        });
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();

        assert_eq!(
            read_bounded_lossy_line(&mut reader, &mut line, 16)
                .await
                .unwrap(),
            5
        );
        assert_eq!(line, "bad\u{fffd}\n");
        assert_eq!(
            read_bounded_lossy_line(&mut reader, &mut line, 16)
                .await
                .unwrap(),
            3
        );
        assert_eq!(line, "ok\n");
        write_task.await.unwrap();
    }

    #[tokio::test]
    async fn bounded_stderr_reader_rejects_oversize_line_and_keeps_reading() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer.write_all(b"123456789\nok\n").await.unwrap();
        });
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();

        let error = read_bounded_lossy_line(&mut reader, &mut line, 8)
            .await
            .expect_err("oversize stderr line must be reported");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("8 byte limit"));

        assert_eq!(
            read_bounded_lossy_line(&mut reader, &mut line, 8)
                .await
                .unwrap(),
            3
        );
        assert_eq!(line, "ok\n");
        write_task.await.unwrap();
    }

    #[tokio::test]
    async fn host_stdin_write_enforces_its_own_deadline() {
        let (mut writer, _idle_reader) = tokio::io::duplex(1);
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            write_host_stdin(&mut writer, b"blocked", Duration::from_millis(25)),
        )
        .await
        .expect("Host stdin writer must enforce its own deadline");

        let error = result.expect_err("stalled Host stdin must time out");
        assert!(error.contains("timed out"), "unexpected error: {error}");
    }

    #[test]
    fn stdout_jsonl_limit_is_large_but_finite() {
        assert_eq!(MAX_HOST_STDOUT_LINE_BYTES, 32 * 1024 * 1024);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_job_close_terminates_assigned_host() {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = tokio::process::Command::new("cmd.exe");
        command
            .args(["/C", "ping", "-t", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().expect("spawn job fixture");
        let job = WindowsHostJob::assign(&child).expect("assign fixture to Job Object");
        assert!(child.try_wait().expect("probe fixture").is_none());

        drop(job);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("Job Object should terminate child promptly")
            .expect("wait for fixture");
    }

    #[test]
    fn host_child_session_spawn_ready_hello_exact_shutdown() {
        let mut session =
            HostChildSession::spawn_node_script(&fixture_script(), true).expect("spawn");
        let ready = session.wait_ready(Duration::from_secs(5)).expect("ready");
        assert!(ready.contains("host.ready"));
        assert_eq!(session.host_instance_id.as_deref(), Some("test-host"));

        session
            .send_line(
                r#"{"protocolVersion":1,"id":"1","method":"system.hello","context":{},"params":{"clientName":"t","clientVersion":"0","protocolVersion":1}}"#,
            )
            .unwrap();
        let hello = session
            .read_line_timeout(Duration::from_secs(5))
            .expect("hello");
        assert!(hello.contains(r#""ok":true"#));
        assert!(hello.contains("test-host"));

        // Shutdown uses exact id via shared build_shutdown_line path
        session.shutdown_exact().expect("shutdown");
    }

    #[test]
    fn host_child_session_kill_timeout_reaps() {
        let mut session =
            HostChildSession::spawn_node_script("setInterval(()=>{}, 1000)", false).expect("spawn");
        std::thread::sleep(Duration::from_millis(50));
        let status = session.kill_and_reap().expect("reap");
        assert!(!status.success() || status.code().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_uses_an_isolated_session_and_process_group() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(false), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);
        let host_group = unsafe { libc::getpgid(host_pid) };
        let host_session = unsafe { libc::getsid(host_pid) };
        let descendant_group = unsafe { libc::getpgid(descendant_pid) };
        session.kill_and_reap().expect("reap Host fixture");

        assert_eq!(host_group, host_pid, "Host must lead its own process group");
        assert_eq!(
            host_session, host_pid,
            "Host must lead its own Unix session"
        );
        assert_eq!(
            descendant_group, host_pid,
            "descendant must inherit Host group"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_force_cleanup_terminates_descendants() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(false), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);

        session.kill_and_reap().expect("force cleanup");

        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived force cleanup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_exit_probe_preserves_group_leader_until_cleanup() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(true), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);

        assert!(
            wait_for_unix_child_exit_without_reaping(host_pid, Duration::from_secs(2)),
            "Host fixture {host_pid} did not exit"
        );
        assert!(
            unix_process_exists(host_pid),
            "non-reaping exit observation released Host PID {host_pid}"
        );
        assert!(
            unix_child_exited_without_reaping(Some(
                u32::try_from(host_pid).expect("positive Host PID")
            ))
            .expect("repeat non-reaping child probe"),
            "Host exit must remain observable until explicit reap"
        );
        assert_eq!(
            unsafe { libc::kill(-host_pid, 0) },
            0,
            "Host process-group target must still exist before cleanup"
        );

        session.kill_and_reap().expect("cleanup and reap Host");
        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived cleanup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reap_waits_for_claimed_group_cleanup_signal() {
        let mut session =
            HostChildSession::spawn_node_script("setInterval(()=>{}, 1000)", false).expect("spawn");
        let cleanup = session
            .claim_unix_group_cleanup_for_test()
            .expect("claim Unix group cleanup");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let reap_thread = std::thread::spawn(move || {
            started_tx.send(()).expect("announce reaper start");
            result_tx
                .send(session.kill_and_reap())
                .expect("publish reap result");
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reaper started");
        assert!(
            matches!(
                result_rx.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "reaper proceeded before the cleanup owner signaled the group"
        );

        drop(cleanup);
        result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reaper resumed after group signal")
            .expect("reap Host fixture");
        reap_thread.join().expect("join reaper");
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_graceful_shutdown_terminates_descendants() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_graceful_descendant_fixture(), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);

        session.shutdown_exact().expect("graceful shutdown");

        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived graceful shutdown"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_crash_cleanup_terminates_descendants_without_restart() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(true), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);
        std::thread::sleep(Duration::from_millis(150));

        assert!(!session.on_unexpected_exit(), "restart is disabled");
        let _ = session.kill_and_reap();

        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived Host crash cleanup"
        );
    }

    #[test]
    fn host_child_session_unexpected_exit_auto_restart_once() {
        let mut session =
            HostChildSession::spawn_node_script("process.exit(7)", true).expect("spawn");
        // child exits immediately
        std::thread::sleep(Duration::from_millis(100));
        let will = session.on_unexpected_exit();
        assert!(will, "first unexpected exit should auto-restart");
        let will2 = session.on_unexpected_exit();
        assert!(!will2, "second exit stays fatal");
    }

    #[test]
    fn host_child_session_graceful_flag_skips_auto_restart() {
        let mut session =
            HostChildSession::spawn_node_script(&fixture_script(), true).expect("spawn");
        let _ = session.wait_ready(Duration::from_secs(5));
        session.shutting_down = true;
        assert!(!session.on_unexpected_exit());
        let _ = session.kill_and_reap();
    }

    #[tokio::test]
    async fn retired_generation_monitor_exits_and_is_joined() {
        let generation = Arc::new(AtomicU32::new(7));
        let exited = Arc::new(AtomicBool::new(false));
        let task_generation = Arc::clone(&generation);
        let task_exited = Arc::clone(&exited);
        let mut task = Some(tokio::spawn(async move {
            while is_current_child_generation(task_generation.load(Ordering::SeqCst), 7) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            task_exited.store(true, Ordering::SeqCst);
        }));

        generation.store(8, Ordering::SeqCst);
        finish_monitor_task(&mut task).await;

        assert!(task.is_none());
        assert!(exited.load(Ordering::SeqCst));
    }

    #[test]
    fn invalid_json_does_not_panic() {
        assert!(extract_host_instance_id("{not").is_none());
        assert!(extract_host_instance_id("").is_none());
        let mut buf = String::new();
        let lines = drain_complete_lines(&mut buf, "not json\n");
        assert_eq!(lines.len(), 1);
    }
}
