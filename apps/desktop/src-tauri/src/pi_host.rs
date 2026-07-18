use crate::desktop_settings::DesktopSettingsStore;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(crate) const MAX_HOST_STDOUT_LINE_BYTES: usize = 32 * 1024 * 1024;
const MAX_HOST_STDERR_LINE_BYTES: usize = 1024 * 1024;

pub(crate) async fn read_bounded_utf8_line<R>(
    reader: &mut R,
    buffer: &mut String,
    max_bytes: usize,
) -> std::io::Result<usize>
where
    R: AsyncBufRead + Unpin,
{
    buffer.clear();
    let mut limited = reader.take((max_bytes as u64).saturating_add(1));
    let bytes_read = limited.read_line(buffer).await?;
    if bytes_read > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("line exceeds {max_bytes} byte limit"),
        ));
    }
    Ok(bytes_read)
}

#[cfg(windows)]
pub(crate) struct WindowsHostJob {
    handle: OwnedHandle,
}

#[cfg(windows)]
impl WindowsHostJob {
    pub(crate) fn assign(child: &Child) -> Result<Self, String> {
        unsafe {
            let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw_job.is_null() {
                return Err(format!(
                    "create Host Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let job = Self {
                handle: OwnedHandle::from_raw_handle(raw_job),
            };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let job_handle = job.handle.as_raw_handle();
            if SetInformationJobObject(
                job_handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!(
                    "configure Host Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let process_handle = child
                .raw_handle()
                .ok_or_else(|| "Host exited before Job Object assignment".to_string())?;
            if AssignProcessToJobObject(job_handle, process_handle) == 0 {
                return Err(format!(
                    "assign Host to Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(job)
        }
    }
}

/// Manages the Node Pi Host sidecar process.
/// Rust owns process lifecycle only — no Pi business logic.
pub struct PiHostManager {
    app: AppHandle,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    agent_dir: PathBuf,
    /// Restarts performed for the current host epoch (reset after stable ready).
    restart_count: Arc<AtomicU32>,
    auto_restart_once: bool,
    shutting_down: Arc<AtomicBool>,
    last_stderr: Arc<Mutex<Vec<String>>>,
    /// Real hostInstanceId from host.ready / hello — never use "*" for shutdown.
    host_instance_id: Option<String>,
    /// When true, unexpected exit may auto-restart once this epoch.
    auto_restart_armed: Arc<AtomicBool>,
    /// Monotonic child generation used to retire delayed stdout/stderr monitors.
    child_generation: Arc<AtomicU32>,
    stdout_task: Option<JoinHandle<()>>,
    stderr_task: Option<JoinHandle<()>>,
    #[cfg(windows)]
    windows_job: Option<WindowsHostJob>,
}

/// Pure policy for one-shot auto-restart (unit-testable without Tauri).
pub fn should_auto_restart(auto_restart_once: bool, restart_count: u32) -> bool {
    auto_restart_once && restart_count == 0
}

pub fn is_current_child_generation(current: u32, captured: u32) -> bool {
    current == captured
}

pub(crate) async fn finish_monitor_task(slot: &mut Option<JoinHandle<()>>) {
    let Some(mut handle) = slot.take() else {
        return;
    };
    if tokio::time::timeout(std::time::Duration::from_secs(2), &mut handle)
        .await
        .is_err()
    {
        handle.abort();
        let _ = handle.await;
    }
}

/// Shared restart epoch state used by PiHostManager and tests.
#[derive(Debug, Clone)]
#[allow(dead_code)] // exercised by unit tests + PiHostManager restart path
pub struct AutoRestartEpoch {
    pub auto_restart_once: bool,
    pub restart_count: u32,
    pub armed: bool,
}

impl AutoRestartEpoch {
    pub fn new(auto_restart_once: bool) -> Self {
        Self {
            auto_restart_once,
            restart_count: 0,
            armed: true,
        }
    }

    /// On unexpected child exit: returns whether to auto-restart once.
    pub fn on_unexpected_exit(&mut self) -> bool {
        if should_auto_restart(self.auto_restart_once, self.restart_count) && self.armed {
            self.armed = false;
            self.restart_count = self.restart_count.saturating_add(1);
            true
        } else {
            false
        }
    }

    /// Manual restart begins a new epoch.
    pub fn on_manual_restart(&mut self) {
        self.restart_count = 0;
        self.armed = true;
    }
}

/// Build typed system.shutdown request line with exact hostInstanceId (never "*").
pub fn build_shutdown_line(host_instance_id: &str, request_id: &str) -> String {
    format!(
        r#"{{"protocolVersion":1,"id":"{request_id}","method":"system.shutdown","context":{{"expectedHostInstanceId":"{host_instance_id}"}},"params":null}}"#
    )
}

/// Split stdout stream into complete lines (same buffering logic as PiHostManager reader).
#[allow(dead_code)]
pub fn drain_complete_lines(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);
    let mut lines = Vec::new();
    while let Some(idx) = buffer.find('\n') {
        let mut line = buffer[..idx].to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        buffer.drain(..=idx);
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

/// Bound stderr ring buffer (matches PiHostManager 50-line cap).
#[allow(dead_code)]
pub fn push_stderr_tail(logs: &mut Vec<String>, line: String, max: usize) {
    logs.push(line);
    if logs.len() > max {
        let drain = logs.len() - max;
        logs.drain(0..drain);
    }
}

/// Testable Host child session — process protocol used by PiHostManager.
/// Unit tests drive this type directly (no Tauri AppHandle required).
#[allow(dead_code)]
pub struct HostChildSession {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<std::io::BufReader<std::process::ChildStdout>>,
    pub host_instance_id: Option<String>,
    pub restart: AutoRestartEpoch,
    pub shutting_down: bool,
    pub stderr_tail: Vec<String>,
    stdout_buf: String,
}

impl HostChildSession {
    pub fn spawn_node_script(script: &str, auto_restart_once: bool) -> Result<Self, String> {
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
        let mut child = std::process::Command::new(node)
            .arg("-e")
            .arg(script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn fixture: {e}"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().map(std::io::BufReader::new);
        Ok(Self {
            child: Some(child),
            stdin,
            stdout,
            host_instance_id: None,
            restart: AutoRestartEpoch::new(auto_restart_once),
            shutting_down: false,
            stderr_tail: Vec::new(),
            stdout_buf: String::new(),
        })
    }

    pub fn read_line_timeout(&mut self, timeout: std::time::Duration) -> Result<String, String> {
        use std::io::BufRead;
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if let Some(reader) = self.stdout.as_mut() {
                let mut line = String::new();
                // Blocking read — fixtures write promptly
                match reader.read_line(&mut line) {
                    Ok(0) => return Err("stdout closed".into()),
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if trimmed.contains("\"event\":\"host.ready\"")
                            || trimmed.contains("\"event\": \"host.ready\"")
                        {
                            if let Some(id) = extract_host_instance_id(&trimmed) {
                                self.host_instance_id = Some(id);
                            }
                        }
                        return Ok(trimmed);
                    }
                    Err(e) => return Err(format!("read stdout: {e}")),
                }
            } else {
                return Err("no stdout".into());
            }
        }
        Err("timeout waiting for line".into())
    }

    pub fn wait_ready(&mut self, timeout: std::time::Duration) -> Result<String, String> {
        let line = self.read_line_timeout(timeout)?;
        if !line.contains("host.ready") {
            return Err(format!("expected host.ready, got {line}"));
        }
        Ok(line)
    }

    pub fn send_line(&mut self, line: &str) -> Result<(), String> {
        use std::io::Write;
        let stdin = self.stdin.as_mut().ok_or("no stdin")?;
        let payload = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
        stdin.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    pub fn shutdown_exact(&mut self) -> Result<(), String> {
        self.shutting_down = true;
        let host_id = self
            .host_instance_id
            .clone()
            .unwrap_or_else(|| "unknown".into());
        let line = build_shutdown_line(&host_id, "shutdown");
        self.send_line(&line)?;
        if let Some(mut child) = self.child.take() {
            // Wait briefly then kill
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if start.elapsed() > std::time::Duration::from_secs(5) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                    Err(e) => return Err(format!("wait: {e}")),
                }
            }
        }
        self.stdin = None;
        self.stdout = None;
        Ok(())
    }

    pub fn kill_and_reap(&mut self) -> Result<std::process::ExitStatus, String> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            child.wait().map_err(|e| format!("reap: {e}"))
        } else {
            Err("no child".into())
        }
    }

    /// Simulate unexpected exit handling (same policy as PiHostManager stdout-close path).
    pub fn on_unexpected_exit(&mut self) -> bool {
        if self.shutting_down {
            return false;
        }
        self.restart.on_unexpected_exit()
    }
}

impl PiHostManager {
    pub fn new(app: AppHandle, settings: &DesktopSettingsStore) -> Self {
        Self {
            app,
            child: None,
            stdin: None,
            agent_dir: settings.resolved_agent_dir(),
            restart_count: Arc::new(AtomicU32::new(0)),
            auto_restart_once: settings.settings.auto_restart_host_once,
            shutting_down: Arc::new(AtomicBool::new(false)),
            last_stderr: Arc::new(Mutex::new(Vec::new())),
            host_instance_id: None,
            auto_restart_armed: Arc::new(AtomicBool::new(true)),
            child_generation: Arc::new(AtomicU32::new(0)),
            stdout_task: None,
            stderr_task: None,
            #[cfg(windows)]
            windows_job: None,
        }
    }

    pub fn set_agent_dir(&mut self, dir: PathBuf) {
        self.agent_dir = dir;
    }

    pub fn set_auto_restart_once(&mut self, v: bool) {
        self.auto_restart_once = v;
    }

    pub fn host_instance_id(&self) -> Option<&str> {
        self.host_instance_id.as_deref()
    }

    pub fn restart_count(&self) -> u32 {
        self.restart_count.load(Ordering::SeqCst)
    }

    pub fn note_host_ready_identity(&mut self, host_instance_id: String) {
        self.host_instance_id = Some(host_instance_id);
        // Stable ready: keep restart_count for epoch, re-arm is epoch-scoped
    }

    fn resolve_node(app: &AppHandle) -> Result<PathBuf, String> {
        // Release: only bundled runtime under resource_dir / next to exe — no PATH/global.
        if let Ok(res_dir) = app.path().resource_dir() {
            for candidate in [
                res_dir.join("node").join("node.exe"),
                res_dir.join("node").join("node"),
                res_dir.join("resources").join("node").join("node.exe"),
            ] {
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in [
                    dir.join("node").join("node.exe"),
                    dir.join("resources").join("node").join("node.exe"),
                ] {
                    if candidate.exists() {
                        return Ok(candidate);
                    }
                }
            }
        }

        // Dev only: PATH / monorepo tooling
        #[cfg(debug_assertions)]
        {
            if let Ok(path) = which_node() {
                return Ok(path);
            }
            return Ok(PathBuf::from(if cfg!(windows) {
                "node.exe"
            } else {
                "node"
            }));
        }

        #[cfg(not(debug_assertions))]
        {
            Err(
                "Release build: bundled Node not found under resource_dir. Re-run package:sidecar:with-node / prepare:runtime."
                    .into(),
            )
        }
    }

    fn resolve_portable_git(app: &AppHandle) -> Result<Option<PathBuf>, String> {
        let mut candidates = Vec::new();
        if let Ok(res_dir) = app.path().resource_dir() {
            candidates.push(res_dir.join("git").join("cmd"));
            candidates.push(res_dir.join("resources").join("git").join("cmd"));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("git").join("cmd"));
                candidates.push(dir.join("resources").join("git").join("cmd"));
            }
        }
        for candidate in candidates {
            if candidate.join("git.exe").exists() {
                return Ok(Some(candidate));
            }
        }

        #[cfg(debug_assertions)]
        {
            Ok(None)
        }
        #[cfg(not(debug_assertions))]
        {
            Err("Release build: bundled Portable Git not found under resource_dir. Re-run prepare:runtime.".into())
        }
    }

    fn resolve_host_entry(app: &AppHandle) -> Result<PathBuf, String> {
        // Dev first: monorepo built host (most reliable during tauri:dev)
        #[cfg(debug_assertions)]
        {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let dev_entry = manifest.join("../../../packages/pi-host/dist/main.js");
            if dev_entry.exists() {
                return Ok(canonicalize_path(dev_entry));
            }
            let staged = manifest.join("resources/pi-host/main.js");
            if staged.exists() && staged_host_is_runnable(&staged) {
                return Ok(canonicalize_path(staged));
            }
            let dev_src = manifest.join("../../../packages/pi-host/src/main.ts");
            if dev_src.exists() {
                return Ok(canonicalize_path(dev_src));
            }
        }

        // Release: only resource_dir — no monorepo fallback
        if let Ok(res_dir) = app.path().resource_dir() {
            for candidate in [
                res_dir.join("pi-host").join("main.js"),
                res_dir.join("pi-host").join("dist").join("main.js"),
                res_dir.join("resources").join("pi-host").join("main.js"),
            ] {
                if candidate.exists() {
                    return Ok(canonicalize_path(candidate));
                }
            }
        }

        Err(
            "Pi Host entry not found. Dev: run `pnpm build`. Release: stage resources via package:sidecar:with-node."
                .into(),
        )
    }

    pub async fn begin_start(&mut self) -> Result<PendingStart, String> {
        // Ensure previous instance is gone
        if self.child.is_some() {
            self.shutdown().await;
        } else {
            self.join_monitor_tasks().await;
        }

        let child_generation = self.child_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shutting_down.store(false, Ordering::SeqCst);
        {
            let mut logs = self.last_stderr.lock().await;
            logs.clear();
        }

        let node = Self::resolve_node(&self.app)?;
        let portable_git_cmd = Self::resolve_portable_git(&self.app)?;
        let entry = Self::resolve_host_entry(&self.app)?;
        let agent_dir = self.agent_dir.clone();
        let work_dir = entry
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // Ensure agentDir exists before spawn
        std::fs::create_dir_all(&agent_dir)
            .map_err(|e| format!("create agentDir {}: {e}", agent_dir.display()))?;

        eprintln!(
            "[pideck] starting host node={} entry={} cwd={} agentDir={}",
            node.display(),
            entry.display(),
            work_dir.display(),
            agent_dir.display()
        );

        let mut cmd = Command::new(&node);
        if entry.extension().and_then(|e| e.to_str()) == Some("ts") {
            // Dev TypeScript entry — requires tsx resolvable from monorepo
            cmd.arg("--import").arg("tsx").arg(&entry);
            // Prefer monorepo root for tsx resolution
            let monorepo_host =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/pi-host");
            if monorepo_host.exists() {
                cmd.current_dir(canonicalize_path(monorepo_host));
            } else {
                cmd.current_dir(&work_dir);
            }
        } else {
            cmd.arg(&entry);
            cmd.current_dir(&work_dir);
        }
        cmd.arg(format!("--agent-dir={}", agent_dir.display()));
        cmd.env("PI_CODING_AGENT_DIR", &agent_dir);

        let mut controlled_path = Vec::<PathBuf>::new();
        if let Some(node_dir) = node.parent() {
            controlled_path.push(node_dir.to_path_buf());
        }
        if let Some(git_cmd) = portable_git_cmd.as_ref() {
            controlled_path.push(git_cmd.clone());
            if let Some(git_root) = git_cmd.parent() {
                controlled_path.push(git_root.join("bin"));
                controlled_path.push(git_root.join("mingw64").join("bin"));
            }
        }
        if let Ok(system_root) = std::env::var("SystemRoot") {
            controlled_path.push(PathBuf::from(system_root).join("System32"));
        }
        #[cfg(debug_assertions)]
        if portable_git_cmd.is_none() {
            if let Some(existing) = std::env::var_os("PATH") {
                controlled_path.extend(std::env::split_paths(&existing));
            }
        }
        let controlled_path = std::env::join_paths(controlled_path)
            .map_err(|e| format!("build controlled Host PATH: {e}"))?;
        cmd.env("PATH", controlled_path);

        // Help Node resolve monorepo deps when running dist from packages/pi-host
        if let Some(host_pkg) = entry.parent().and_then(|p| p.parent()) {
            // packages/pi-host/dist -> packages/pi-host
            let nm = host_pkg.join("node_modules");
            if nm.exists() {
                cmd.env("NODE_PATH", nm);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Do NOT use kill_on_drop — premature drops were killing the host mid-handshake on Windows.

        #[cfg(windows)]
        {
            // Avoid flashing a console window under the GUI host
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn host failed (node={}): {e}", node.display()))?;

        #[cfg(windows)]
        let windows_job = match WindowsHostJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdin = Arc::new(Mutex::new(stdin));

        let stderr_buf = Arc::clone(&self.last_stderr);
        let app_err = self.app.clone();
        let stderr_generation = Arc::clone(&self.child_generation);
        self.stderr_task = Some(tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                match read_bounded_utf8_line(&mut reader, &mut line, MAX_HOST_STDERR_LINE_BYTES)
                    .await
                {
                    Ok(0) => break,
                    Ok(_) => {
                        if !is_current_child_generation(
                            stderr_generation.load(Ordering::SeqCst),
                            child_generation,
                        ) {
                            break;
                        }
                        let trimmed = line.trim_end().to_string();
                        {
                            let mut logs = stderr_buf.lock().await;
                            push_stderr_tail(&mut logs, trimmed.clone(), 50);
                        }
                        eprintln!("[pi-host] {trimmed}");
                        let _ = app_err.emit("pi-host-stderr", trimmed);
                    }
                    Err(error) => {
                        let message = format!("Pi Host stderr transport read failed: {error}");
                        {
                            let mut logs = stderr_buf.lock().await;
                            push_stderr_tail(&mut logs, message.clone(), 50);
                        }
                        eprintln!("[pideck] {message}");
                        let _ = app_err.emit("pi-host-stderr", message);
                        break;
                    }
                }
            }
        }));

        // Wait until host.ready or process exit (fail fast with stderr)
        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<Result<Option<String>, String>>();
        let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
        let app_out = self.app.clone();
        let stderr_for_exit = Arc::clone(&self.last_stderr);
        let shutting_down = Arc::clone(&self.shutting_down);
        let restart_count = Arc::clone(&self.restart_count);
        let auto_restart_armed = Arc::clone(&self.auto_restart_armed);
        let auto_restart_once = self.auto_restart_once;
        let app_for_restart = self.app.clone();
        let stdout_generation = Arc::clone(&self.child_generation);

        {
            let ready_tx = Arc::clone(&ready_tx);
            self.stdout_task = Some(tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                let mut read_failure = None;
                loop {
                    match read_bounded_utf8_line(&mut reader, &mut line, MAX_HOST_STDOUT_LINE_BYTES)
                        .await
                    {
                        Ok(0) => break,
                        Ok(_) => {
                            if !is_current_child_generation(
                                stdout_generation.load(Ordering::SeqCst),
                                child_generation,
                            ) {
                                break;
                            }
                            let payload = line.trim_end_matches(['\r', '\n']).to_string();
                            if payload.contains("\"event\":\"host.ready\"")
                                || payload.contains("\"event\": \"host.ready\"")
                            {
                                let hid = extract_host_instance_id(&payload);
                                if let Some(tx) = ready_tx.lock().await.take() {
                                    let _ = tx.send(Ok(hid));
                                }
                            }
                            let _ = app_out.emit("pi-host-stdout", payload);
                        }
                        Err(error) => {
                            let message = format!("Pi Host stdout transport read failed: {error}");
                            eprintln!("[pideck] {message}");
                            read_failure = Some(message);
                            break;
                        }
                    }
                }
                // stdout closed — only the active child generation may trigger recovery.
                if is_current_child_generation(
                    stdout_generation.load(Ordering::SeqCst),
                    child_generation,
                ) && !shutting_down.load(Ordering::SeqCst)
                {
                    let logs = stderr_for_exit.lock().await;
                    let tail = logs.iter().rev().take(8).cloned().collect::<Vec<_>>();
                    let mut tail = tail;
                    tail.reverse();
                    let detail = match (read_failure, tail.is_empty()) {
                        (Some(error), true) => error,
                        (Some(error), false) => format!("{error}. stderr: {}", tail.join(" | ")),
                        (None, true) => "Pi Host process exited (no stderr)".to_string(),
                        (None, false) => {
                            format!("Pi Host process exited. stderr: {}", tail.join(" | "))
                        }
                    };
                    if let Some(tx) = ready_tx.lock().await.take() {
                        let _ = tx.send(Err(detail.clone()));
                    }

                    // Same AutoRestartEpoch policy unit-tested via HostChildSession
                    let mut epoch = AutoRestartEpoch {
                        auto_restart_once,
                        restart_count: restart_count.load(Ordering::SeqCst),
                        armed: auto_restart_armed.load(Ordering::SeqCst),
                    };
                    let will_restart = epoch.on_unexpected_exit();
                    restart_count.store(epoch.restart_count, Ordering::SeqCst);
                    auto_restart_armed.store(epoch.armed, Ordering::SeqCst);

                    let msg = if will_restart {
                        format!("{detail} — auto-restarting Host once")
                    } else {
                        detail
                    };

                    let _ = app_out.emit(
                        "pi-host-stdout",
                        serde_json::json!({
                            "protocolVersion": 1,
                            "event": "host.fatal",
                            "sequence": 1,
                            "timestamp": chrono_like_now(),
                            "hostInstanceId": "00000000-0000-4000-8000-000000000002",
                            "workspaceId": null,
                            "workspaceRevision": 0,
                            "sessionId": null,
                            "sessionRevision": 0,
                            "packageRevision": 0,
                            "payload": {
                                "error": {
                                    "code": "INTERNAL_ERROR",
                                    "message": msg,
                                    "retryable": will_restart
                                }
                            }
                        })
                        .to_string(),
                    );

                    if will_restart {
                        // Request app-level restart via event (lib.rs listens)
                        let _ = app_for_restart.emit("pi-host-auto-restart", "once");
                    }
                }
            }));
        }

        self.stdin = Some(Arc::clone(&stdin));
        self.child = Some(child);
        #[cfg(windows)]
        {
            self.windows_job = Some(windows_job);
        }

        Ok(PendingStart {
            ready_rx,
            generation: child_generation,
            node,
            entry,
        })
    }

    /// Commit or roll back a startup whose ready-wait ran outside the manager lock.
    pub async fn complete_start(&mut self, done: CompletedStart) -> Result<(), String> {
        if !is_current_child_generation(
            self.child_generation.load(Ordering::SeqCst),
            done.generation,
        ) {
            // A newer start/shutdown superseded this attempt while the ready-wait
            // ran unlocked; that flow owns the child state now — don't touch it.
            return Err("host start superseded by a newer restart or shutdown".into());
        }
        match done.outcome {
            StartWaitOutcome::Ready(hid) => {
                eprintln!("[pideck] host.ready received");
                if let Some(id) = hid {
                    self.host_instance_id = Some(id);
                }
                // New process ready: re-arm only if this was a fresh epoch (restart_count reset on manual restart start)
                Ok(())
            }
            StartWaitOutcome::Failed(e) => {
                self.cleanup_dead_child().await;
                Err(e)
            }
            StartWaitOutcome::ChannelClosed => {
                self.cleanup_dead_child().await;
                Err("host ready channel closed".into())
            }
            StartWaitOutcome::TimedOut => {
                let tail = {
                    let logs = self.last_stderr.lock().await;
                    logs.join(" | ")
                };
                self.cleanup_dead_child().await;
                Err(format!(
                    "timeout waiting for host.ready (180s). node={} entry={} stderr={}",
                    done.node.display(),
                    done.entry.display(),
                    if tail.is_empty() { "(empty)" } else { &tail }
                ))
            }
        }
    }

    async fn join_monitor_tasks(&mut self) {
        finish_monitor_task(&mut self.stdout_task).await;
        finish_monitor_task(&mut self.stderr_task).await;
    }

    async fn cleanup_dead_child(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.child_generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.stdin = None;
        #[cfg(windows)]
        {
            self.windows_job = None;
        }
        self.join_monitor_tasks().await;
    }

    pub async fn send_line(&mut self, line: String) -> Result<(), String> {
        // Detect dead child before write
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.stdin = None;
                    self.child = None;
                    #[cfg(windows)]
                    {
                        self.windows_job = None;
                    }
                    let detail = {
                        let logs = self.last_stderr.lock().await;
                        if logs.is_empty() {
                            "(empty — run pnpm build and check packages/pi-host/dist)".to_string()
                        } else {
                            logs.join(" | ")
                        }
                    };
                    return Err(format!("Pi Host exited ({status}). stderr: {detail}"));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("host wait error: {e}")),
            }
        }

        let stdin = self.stdin.as_ref().ok_or_else(|| {
            "host not running — use Settings → Restart Host (ensure `pnpm build` first)".to_string()
        })?;
        let mut guard = stdin.lock().await;
        let payload = if line.ends_with('\n') {
            line
        } else {
            format!("{line}\n")
        };
        guard
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        guard
            .flush()
            .await
            .map_err(|e| {
                format!(
                    "flush stdin: {e} — Host process likely crashed. Check Settings → Restart Host after `pnpm build`."
                )
            })?;
        Ok(())
    }

    pub async fn shutdown(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.child_generation.fetch_add(1, Ordering::SeqCst);
        if self.stdin.is_some() {
            let host_id = self
                .host_instance_id
                .clone()
                .unwrap_or_else(|| "unknown".into());
            let line = build_shutdown_line(&host_id, "shutdown");
            if self.host_instance_id.is_none() {
                eprintln!(
                    "[pideck] shutdown without hostInstanceId — sending expectedHostInstanceId=unknown then terminate"
                );
            }
            let _ = self.send_line(line).await;
        }

        if let Some(mut child) = self.child.take() {
            let wait = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
            if wait.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.stdin = None;
        #[cfg(windows)]
        {
            self.windows_job = None;
        }
        self.join_monitor_tasks().await;
    }

    /// Manual restart: new host epoch — reset one-shot auto-restart arming.
    pub async fn begin_manual_restart(&mut self) -> Result<PendingStart, String> {
        self.shutdown().await;
        // Same epoch reset as AutoRestartEpoch::on_manual_restart
        let mut ep = AutoRestartEpoch {
            auto_restart_once: self.auto_restart_once,
            restart_count: self.restart_count.load(Ordering::SeqCst),
            armed: self.auto_restart_armed.load(Ordering::SeqCst),
        };
        ep.on_manual_restart();
        self.restart_count.store(ep.restart_count, Ordering::SeqCst);
        self.auto_restart_armed.store(ep.armed, Ordering::SeqCst);
        self.host_instance_id = None;
        self.begin_start().await
    }

    /// One-shot auto-restart after unexpected exit (does not reset epoch counter to 0).
    pub async fn begin_auto_restart_after_crash(&mut self) -> Result<PendingStart, String> {
        // Reap or terminate the previous child before starting the replacement epoch.
        self.cleanup_dead_child().await;
        self.host_instance_id = None;
        self.shutting_down.store(false, Ordering::SeqCst);
        self.begin_start().await
    }

    pub fn is_running(&mut self) -> bool {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.child = None;
                    self.stdin = None;
                    #[cfg(windows)]
                    {
                        self.windows_job = None;
                    }
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

/// A spawned host whose `host.ready` wait has not completed yet.
/// Await `wait_ready` WITHOUT holding the manager mutex, then pass the result
/// to `PiHostManager::complete_start` under a fresh (short) lock.
pub struct PendingStart {
    ready_rx: tokio::sync::oneshot::Receiver<Result<Option<String>, String>>,
    generation: u32,
    node: PathBuf,
    entry: PathBuf,
}

pub enum StartWaitOutcome {
    Ready(Option<String>),
    Failed(String),
    ChannelClosed,
    TimedOut,
}

pub struct CompletedStart {
    generation: u32,
    node: PathBuf,
    entry: PathBuf,
    outcome: StartWaitOutcome,
}

impl PendingStart {
    pub async fn wait_ready(self) -> CompletedStart {
        let outcome =
            match tokio::time::timeout(std::time::Duration::from_secs(180), self.ready_rx).await {
                Ok(Ok(Ok(hid))) => StartWaitOutcome::Ready(hid),
                Ok(Ok(Err(e))) => StartWaitOutcome::Failed(e),
                Ok(Err(_)) => StartWaitOutcome::ChannelClosed,
                Err(_) => StartWaitOutcome::TimedOut,
            };
        CompletedStart {
            generation: self.generation,
            node: self.node,
            entry: self.entry,
            outcome,
        }
    }
}

/// Which startup flow `start_unlocked` runs.
pub enum StartKind {
    Fresh,
    ManualRestart,
    AutoRestartAfterCrash,
}

/// Drive a full host start while holding the manager mutex only for the spawn
/// and commit phases — never across the (up to 180 s) host.ready wait, so IPC
/// commands and app exit stay responsive if the sidecar hangs.
pub async fn start_unlocked(
    host: &tokio::sync::Mutex<PiHostManager>,
    kind: StartKind,
) -> Result<(), String> {
    let pending = {
        let mut mgr = host.lock().await;
        match kind {
            StartKind::Fresh => mgr.begin_start().await?,
            StartKind::ManualRestart => mgr.begin_manual_restart().await?,
            StartKind::AutoRestartAfterCrash => mgr.begin_auto_restart_after_crash().await?,
        }
    };
    let done = pending.wait_ready().await;
    host.lock().await.complete_start(done).await
}

/// Make an absolute path safe to pass to Node on Windows.
///
/// `Path::canonicalize` on Windows returns `\\?\C:\...` extended paths.
/// Node treats those as broken entry points (`EISDIR: lstat 'C:'`) and exits
/// immediately — which surfaces in the UI as "flush stdin: pipe is being closed".
fn canonicalize_path(p: PathBuf) -> PathBuf {
    let resolved = if p.is_absolute() {
        p.canonicalize().unwrap_or(p)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&p))
            .and_then(|abs| abs.canonicalize().or_else(|_| Ok(abs)))
            .unwrap_or(p)
    };
    strip_verbatim_prefix(resolved)
}

/// Public for bridge unit tests.
pub fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    // \\?\C:\foo  or  \\?\UNC\server\share
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    p
}

/// Extract hostInstanceId from a host.ready JSON line (best-effort).
pub fn extract_host_instance_id(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("hostInstanceId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            v.get("payload")
                .and_then(|p| p.get("hostInstanceId"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
}

fn staged_host_is_runnable(main_js: &Path) -> bool {
    let dir = match main_js.parent() {
        Some(d) => d,
        None => return false,
    };
    dir.join("model-health.js").exists()
        && dir
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .exists()
}

fn which_node() -> Result<PathBuf, ()> {
    // Try PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in ["node.exe", "node"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    // Common nvm4w / fnm locations on this machine class
    for candidate in [
        PathBuf::from(r"C:\nvm4w\nodejs\node.exe"),
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

fn chrono_like_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
