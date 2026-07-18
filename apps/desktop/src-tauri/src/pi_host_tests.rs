//! Rust bridge tests (R3) — drive shared HostChildSession / PiHostManager helpers.

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use crate::pi_host::WindowsHostJob;
    use crate::pi_host::{
        build_shutdown_line, drain_complete_lines, extract_host_instance_id, finish_monitor_task,
        is_current_child_generation, push_stderr_tail, read_bounded_utf8_line, should_auto_restart,
        strip_verbatim_prefix, AutoRestartEpoch, HostChildSession, MAX_HOST_STDOUT_LINE_BYTES,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn fixture_script() -> String {
        r#"
const rl = require('readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({
  protocolVersion:1,event:'host.ready',sequence:1,timestamp:Date.now(),
  hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
  sessionId:null,sessionRevision:0,packageRevision:0,
  payload:{hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,sessionId:null,sessionRevision:0,packageRevision:0,protocolVersion:1,sdkVersion:'0.80.7',nodeVersion:process.version,agentDir:'/tmp',phase:'waitingForWorkspace',capabilities:{packageUpdateCheck:false,extensionUi:true,projectTrust:true,sessionExport:false},modelConfigHealth:{state:'ok',source:'ModelRegistry.getError'}}
})+'\n');
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.method === 'system.hello') {
      process.stdout.write(JSON.stringify({
        protocolVersion:1,id:req.id,method:'system.hello',ok:true,
        hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
        sessionId:null,sessionRevision:0,packageRevision:0,
        result:{hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,sessionId:null,sessionRevision:0,packageRevision:0,protocolVersion:1,sdkVersion:'0.80.7',nodeVersion:process.version,agentDir:'/tmp',phase:'waitingForWorkspace',capabilities:{packageUpdateCheck:false,extensionUi:true,projectTrust:true,sessionExport:false},modelConfigHealth:{state:'ok',source:'ModelRegistry.getError'}}
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
            writer.write_all(b"12345678\n123456789").await.unwrap();
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
        write_task.await.unwrap();
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
