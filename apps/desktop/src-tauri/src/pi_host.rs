use crate::desktop_settings::{DesktopSettings, DesktopSettingsStore};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub(crate) const HOST_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
pub(crate) const APP_EXIT_HOST_SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(unix)]
use std::sync::atomic::AtomicU8;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(crate) const MAX_HOST_STDOUT_LINE_BYTES: usize = 32 * 1024 * 1024;
const MAX_HOST_STDERR_LINE_BYTES: usize = 1024 * 1024;
const HOST_STDIN_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct HostLineTooLong {
    max_bytes: usize,
}

impl std::fmt::Display for HostLineTooLong {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "line exceeds {} byte limit", self.max_bytes)
    }
}

impl std::error::Error for HostLineTooLong {}

fn is_host_line_too_long(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .and_then(|source| source.downcast_ref::<HostLineTooLong>())
        .is_some()
}

async fn discard_through_newline<R>(reader: &mut R) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(());
        }
    }
}

pub(crate) async fn write_host_stdin<W>(
    writer: &mut W,
    payload: &[u8],
    deadline: Duration,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    match tokio::time::timeout(deadline, async {
        writer
            .write_all(payload)
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        writer.flush().await.map_err(|e| {
            format!(
                "flush stdin: {e} — Host process likely crashed. Check Settings → Restart Host after `pnpm build`."
            )
        })?;
        Ok(())
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "write stdin timed out after {} ms — Host is not reading requests; use Settings → Restart Host",
            deadline.as_millis()
        )),
    }
}

pub(crate) async fn read_bounded_utf8_line<R>(
    reader: &mut R,
    buffer: &mut String,
    max_bytes: usize,
) -> std::io::Result<usize>
where
    R: AsyncBufRead + Unpin,
{
    // Reuse the caller's allocation. `take(max + 1)` bounds this buffer; only
    // the remainder of an oversized line is discarded without allocation.
    let mut bytes = std::mem::take(buffer).into_bytes();
    bytes.clear();
    let bytes_read = {
        let mut limited = (&mut *reader).take((max_bytes as u64).saturating_add(1));
        limited.read_until(b'\n', &mut bytes).await?
    };
    if bytes_read > max_bytes {
        if bytes.last() != Some(&b'\n') {
            discard_through_newline(reader).await?;
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            HostLineTooLong { max_bytes },
        ));
    }
    *buffer = String::from_utf8(bytes).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("line is not valid UTF-8: {error}"),
        )
    })?;
    Ok(bytes_read)
}

pub(crate) async fn read_bounded_lossy_line<R>(
    reader: &mut R,
    buffer: &mut String,
    max_bytes: usize,
) -> std::io::Result<usize>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    let bytes_read = {
        let mut limited = (&mut *reader).take((max_bytes as u64).saturating_add(1));
        limited.read_until(b'\n', &mut bytes).await?
    };
    if bytes_read > max_bytes {
        if bytes.last() != Some(&b'\n') {
            discard_through_newline(reader).await?;
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            HostLineTooLong { max_bytes },
        ));
    }
    buffer.clear();
    buffer.push_str(&String::from_utf8_lossy(&bytes));
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

#[cfg(unix)]
const UNIX_HOST_GROUP_TERM_GRACE: std::time::Duration = std::time::Duration::from_millis(500);
#[cfg(unix)]
const UNIX_HOST_GROUP_CLEANUP_UNCLAIMED: u8 = 0;
#[cfg(unix)]
const UNIX_HOST_GROUP_CLEANUP_CLAIMED: u8 = 1;
#[cfg(unix)]
const UNIX_HOST_GROUP_CLEANUP_SIGNALED: u8 = 2;

#[cfg(unix)]
#[derive(Clone)]
pub(crate) struct UnixHostProcessGroup {
    id: libc::pid_t,
    cleanup_state: Arc<AtomicU8>,
}

#[cfg(unix)]
pub(crate) struct UnixHostGroupCleanup {
    id: libc::pid_t,
    cleanup_state: Arc<AtomicU8>,
    finished: bool,
}

#[cfg(unix)]
impl UnixHostProcessGroup {
    fn from_child_id(child_id: Option<u32>) -> Result<Self, String> {
        let child_id = child_id.ok_or_else(|| "Host exited before PID capture".to_string())?;
        let id = libc::pid_t::try_from(child_id)
            .map_err(|_| format!("Host PID {child_id} exceeds Unix pid_t"))?;
        if id <= 0 {
            return Err(format!("Host returned invalid Unix PID {id}"));
        }
        Ok(Self {
            id,
            cleanup_state: Arc::new(AtomicU8::new(UNIX_HOST_GROUP_CLEANUP_UNCLAIMED)),
        })
    }

    fn claim_cleanup(&self) -> Option<UnixHostGroupCleanup> {
        self.cleanup_state
            .compare_exchange(
                UNIX_HOST_GROUP_CLEANUP_UNCLAIMED,
                UNIX_HOST_GROUP_CLEANUP_CLAIMED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .ok()
            .map(|_| UnixHostGroupCleanup {
                id: self.id,
                cleanup_state: Arc::clone(&self.cleanup_state),
                finished: false,
            })
    }

    // A successful claim is not enough for a reaper: the owner must publish
    // that its final group signal has returned before the leader PID is freed.
    async fn wait_until_cleanup_signaled(&self) {
        while self.cleanup_state.load(Ordering::Acquire) != UNIX_HOST_GROUP_CLEANUP_SIGNALED {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }

    fn wait_until_cleanup_signaled_blocking(&self) {
        while self.cleanup_state.load(Ordering::Acquire) != UNIX_HOST_GROUP_CLEANUP_SIGNALED {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

#[cfg(unix)]
impl UnixHostGroupCleanup {
    fn finish(&mut self) {
        self.finished = true;
        self.cleanup_state
            .store(UNIX_HOST_GROUP_CLEANUP_SIGNALED, Ordering::Release);
    }

    fn signal(&self, signal: libc::c_int) -> Result<(), String> {
        if unsafe { libc::kill(-self.id, signal) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(format!(
            "signal Host process group {} with {signal}: {error}",
            self.id
        ))
    }

    fn exists(&self) -> bool {
        if unsafe { libc::kill(-self.id, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn force_kill(&mut self) {
        let _ = self.signal(libc::SIGKILL);
        self.finish();
    }

    #[allow(dead_code)] // synchronous HostChildSession test harness
    fn terminate_blocking(&mut self) {
        let _ = self.signal(libc::SIGTERM);
        let deadline = std::time::Instant::now() + UNIX_HOST_GROUP_TERM_GRACE;
        while std::time::Instant::now() < deadline {
            if !self.exists() {
                self.finish();
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        self.force_kill();
    }
}

#[cfg(unix)]
impl Drop for UnixHostGroupCleanup {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.signal(libc::SIGKILL);
            self.finish();
        }
    }
}

#[cfg(unix)]
fn force_cleanup_unix_host_group(group: &UnixHostProcessGroup) {
    if let Some(mut cleanup) = group.claim_cleanup() {
        cleanup.force_kill();
    }
}

#[cfg(unix)]
async fn force_cleanup_unix_host_group_slot_before_reap(slot: &mut Option<UnixHostProcessGroup>) {
    if let Some(group) = slot.take() {
        if let Some(mut cleanup) = group.claim_cleanup() {
            cleanup.force_kill();
        } else {
            group.wait_until_cleanup_signaled().await;
        }
    }
}

#[cfg(unix)]
fn force_cleanup_unix_host_group_slot_before_reap_blocking(
    slot: &mut Option<UnixHostProcessGroup>,
) {
    if let Some(group) = slot.take() {
        if let Some(mut cleanup) = group.claim_cleanup() {
            cleanup.force_kill();
        } else {
            group.wait_until_cleanup_signaled_blocking();
        }
    }
}

#[cfg(unix)]
async fn terminate_unix_host_group(cleanup: &mut UnixHostGroupCleanup) {
    let _ = cleanup.signal(libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + UNIX_HOST_GROUP_TERM_GRACE;
    while tokio::time::Instant::now() < deadline {
        if !cleanup.exists() {
            cleanup.finish();
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    cleanup.force_kill();
}

#[cfg(unix)]
fn configure_unix_host_command(command: &mut std::process::Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(unix)]
pub(crate) fn unix_child_exited_without_reaping(child_id: Option<u32>) -> Result<bool, String> {
    let child_id = child_id.ok_or_else(|| "Host exited before PID observation".to_string())?;
    let pid = libc::pid_t::try_from(child_id)
        .map_err(|_| format!("Host PID {child_id} exceeds Unix pid_t"))?;
    if pid <= 0 {
        return Err(format!("Host returned invalid Unix PID {pid}"));
    }
    let id =
        libc::id_t::try_from(pid).map_err(|_| format!("Host PID {child_id} exceeds Unix id_t"))?;

    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // WNOWAIT retains an exited group leader as a zombie, preventing PID
        // reuse until its process group has been signaled and Child::wait reaps it.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            let info = unsafe { info.assume_init() };
            let observed_pid = unsafe { info.si_pid() };
            return Ok(observed_pid == pid);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(format!(
            "observe Host PID {child_id} without reaping: {error}"
        ));
    }
}

#[cfg(unix)]
async fn wait_for_unix_child_exit_without_reaping(
    child_id: Option<u32>,
    timeout: std::time::Duration,
) -> Result<bool, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if unix_child_exited_without_reaping(child_id)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Manages the Node Pi Host sidecar process.
/// Rust owns process lifecycle only — no Pi business logic.
pub struct PiHostManager {
    app: AppHandle,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    agent_dir: PathBuf,
    /// Workspace the Host preloads before announcing ready, so the expensive
    /// first graph build overlaps WebView/frontend startup.
    initial_workspace: Option<PathBuf>,
    /// Last Session to reopen during that preload. Only set when it belongs to
    /// the preloaded workspace and restoreLastSession is on.
    initial_session: Option<PathBuf>,
    /// Reopen the most recent Session in the preloaded workspace when no
    /// explicit lastSessionPath is available.
    continue_recent: bool,
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
    #[cfg(unix)]
    unix_process_group: Option<UnixHostProcessGroup>,
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
    #[cfg(test)]
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
#[cfg(test)]
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
pub fn push_stderr_tail(logs: &mut Vec<String>, line: String, max: usize) {
    logs.push(line);
    if logs.len() > max {
        let drain = logs.len() - max;
        logs.drain(0..drain);
    }
}

/// Testable Host child session — process protocol used by PiHostManager.
/// Unit tests drive this type directly (no Tauri AppHandle required).
#[cfg(test)]
pub struct HostChildSession {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<std::io::BufReader<std::process::ChildStdout>>,
    pub host_instance_id: Option<String>,
    pub restart: AutoRestartEpoch,
    pub shutting_down: bool,
    #[cfg(unix)]
    unix_process_group: Option<UnixHostProcessGroup>,
}

#[cfg(test)]
impl HostChildSession {
    pub fn spawn_node_script(script: &str, auto_restart_once: bool) -> Result<Self, String> {
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
        let mut command = std::process::Command::new(node);
        command
            .arg("-e")
            .arg(script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        configure_unix_host_command(&mut command);
        let mut child = command.spawn().map_err(|e| format!("spawn fixture: {e}"))?;
        #[cfg(unix)]
        let unix_process_group = match UnixHostProcessGroup::from_child_id(Some(child.id())) {
            Ok(group) => group,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().map(std::io::BufReader::new);
        Ok(Self {
            child: Some(child),
            stdin,
            stdout,
            host_instance_id: None,
            restart: AutoRestartEpoch::new(auto_restart_once),
            shutting_down: false,
            #[cfg(unix)]
            unix_process_group: Some(unix_process_group),
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
        #[cfg(unix)]
        let unix_process_group = self.unix_process_group.take();
        #[cfg(unix)]
        let mut group_cleanup = unix_process_group
            .as_ref()
            .and_then(UnixHostProcessGroup::claim_cleanup);
        let send_error = self.send_line(&line).err();
        let mut wait_error = None;
        if let Some(mut child) = self.child.take() {
            let start = std::time::Instant::now();
            let mut needs_force = send_error.is_some();
            if !needs_force {
                loop {
                    #[cfg(unix)]
                    let exit_probe = unix_child_exited_without_reaping(Some(child.id()));
                    #[cfg(not(unix))]
                    let exit_probe = child
                        .try_wait()
                        .map(|status| status.is_some())
                        .map_err(|error| format!("wait: {error}"));
                    match exit_probe {
                        Ok(true) => break,
                        Ok(false) if start.elapsed() > std::time::Duration::from_secs(5) => {
                            needs_force = true;
                            break;
                        }
                        Ok(false) => std::thread::sleep(std::time::Duration::from_millis(20)),
                        Err(error) => {
                            wait_error = Some(error);
                            needs_force = true;
                            break;
                        }
                    }
                }
            }
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                cleanup.terminate_blocking();
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled_blocking();
            }
            if needs_force {
                let _ = child.kill();
            }
            if let Err(error) = child.wait() {
                wait_error.get_or_insert_with(|| format!("wait: {error}"));
            }
        } else {
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                cleanup.terminate_blocking();
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled_blocking();
            }
        }
        self.stdin = None;
        self.stdout = None;
        if let Some(error) = send_error.or(wait_error) {
            return Err(error);
        }
        Ok(())
    }

    pub fn kill_and_reap(&mut self) -> Result<std::process::ExitStatus, String> {
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
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
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.restart.on_unexpected_exit()
    }

    #[cfg(all(test, unix))]
    pub(crate) fn claim_unix_group_cleanup_for_test(&self) -> Option<UnixHostGroupCleanup> {
        self.unix_process_group.as_ref()?.claim_cleanup()
    }
}

#[cfg(test)]
impl Drop for HostChildSession {
    fn drop(&mut self) {
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl PiHostManager {
    pub fn new(app: AppHandle, settings: &DesktopSettingsStore) -> Self {
        Self {
            app,
            child: None,
            stdin: None,
            agent_dir: settings.resolved_agent_dir(),
            initial_workspace: Self::workspace_from_settings(&settings.settings),
            initial_session: Self::session_from_settings(&settings.settings),
            continue_recent: settings.settings.restore_last_session,
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
            #[cfg(unix)]
            unix_process_group: None,
        }
    }

    pub fn set_agent_dir(&mut self, dir: PathBuf) {
        self.agent_dir = dir;
    }

    fn workspace_from_settings(settings: &DesktopSettings) -> Option<PathBuf> {
        settings
            .default_workspace
            .clone()
            .or_else(|| settings.last_workspace.clone())
            .map(PathBuf::from)
    }

    fn settings_paths_equal(left: &str, right: &Path) -> bool {
        let normalize = |value: &str| value.replace('\\', "/").trim_end_matches('/').to_string();
        let left = normalize(left);
        let right = normalize(&right.to_string_lossy());
        if cfg!(windows) {
            left.eq_ignore_ascii_case(&right)
        } else {
            left == right
        }
    }

    fn session_from_settings(settings: &DesktopSettings) -> Option<PathBuf> {
        if !settings.restore_last_session {
            return None;
        }
        let session = settings.last_session_path.as_ref()?;
        let preload = Self::workspace_from_settings(settings)?;
        match settings.last_workspace.as_deref() {
            Some(last) if Self::settings_paths_equal(last, &preload) => {
                Some(PathBuf::from(session))
            }
            None => Some(PathBuf::from(session)),
            Some(_) => None,
        }
    }

    pub fn set_initial_workspace(&mut self, settings: &DesktopSettingsStore) {
        self.initial_workspace = Self::workspace_from_settings(&settings.settings);
        self.initial_session = Self::session_from_settings(&settings.settings);
        self.continue_recent = settings.settings.restore_last_session;
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
        // Tauri's resource_dir derives from a canonicalized exe path, which on
        // Windows is a \\?\ verbatim path. node.exe itself launches fine with
        // it, but the runtime directory also feeds the Host's controlled PATH,
        // where cmd.exe (npm.cmd and any batch shim) cannot resolve \\?\ paths
        // — npm installs then fail with "The system cannot find the path
        // specified". Always hand out stripped paths.
        if let Ok(res_dir) = app.path().resource_dir() {
            for candidate in node_runtime_candidates(&res_dir) {
                if is_executable_file(&candidate) {
                    return Ok(strip_verbatim_prefix(candidate));
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in node_runtime_candidates(dir) {
                    if is_executable_file(&candidate) {
                        return Ok(strip_verbatim_prefix(candidate));
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
            Ok(PathBuf::from(if cfg!(windows) {
                "node.exe"
            } else {
                "node"
            }))
        }

        #[cfg(not(debug_assertions))]
        {
            Err(
                "Release build: bundled Node not found under resource_dir. Re-run package:sidecar:with-node / prepare:runtime."
                    .into(),
            )
        }
    }

    #[cfg(not(windows))]
    fn resolve_portable_git(_app: &AppHandle) -> Result<Option<PathBuf>, String> {
        Ok(None)
    }

    #[cfg(windows)]
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
                // Same \\?\ concern as resolve_node: these directories go on
                // the Host's controlled PATH, which cmd.exe must understand.
                return Ok(Some(strip_verbatim_prefix(candidate)));
            }
        }

        if cfg!(debug_assertions) {
            Ok(None)
        } else {
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
        let host_cache_dir = strip_verbatim_prefix(
            self.app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("resolve app cache directory: {e}"))?
                .join("pi-host"),
        );
        let work_dir = entry
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // Ensure agentDir exists before spawn
        std::fs::create_dir_all(&agent_dir)
            .map_err(|e| format!("create agentDir {}: {e}", agent_dir.display()))?;
        std::fs::create_dir_all(&host_cache_dir).map_err(|e| {
            format!(
                "create Pi Host cache directory {}: {e}",
                host_cache_dir.display()
            )
        })?;

        eprintln!(
            "[pideck] starting host node={} entry={} cwd={} agentDir={} cacheDir={}",
            node.display(),
            entry.display(),
            work_dir.display(),
            agent_dir.display(),
            host_cache_dir.display()
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
        if let Some(ws) = self.initial_workspace.as_ref() {
            if ws.is_dir() {
                cmd.arg(format!("--initial-cwd={}", ws.display()));
            }
        }
        if self.continue_recent {
            cmd.arg("--continue-recent");
        }
        if let Some(session) = self.initial_session.as_ref() {
            if session.is_file() {
                cmd.arg(format!("--initial-session={}", session.display()));
            }
        }
        cmd.env("PI_CODING_AGENT_DIR", &agent_dir);
        cmd.env("PIDECK_HOST_CACHE_DIR", &host_cache_dir);

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
        #[cfg(not(windows))]
        if let Some(existing) = std::env::var_os("PATH") {
            controlled_path.extend(std::env::split_paths(&existing));
        }
        #[cfg(all(windows, debug_assertions))]
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

        #[cfg(unix)]
        configure_unix_host_command(cmd.as_std_mut());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn host failed (node={}): {e}", node.display()))?;

        #[cfg(unix)]
        let unix_process_group = match UnixHostProcessGroup::from_child_id(child.id()) {
            Ok(group) => group,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };

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
                match read_bounded_lossy_line(&mut reader, &mut line, MAX_HOST_STDERR_LINE_BYTES)
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
                    Err(error) if is_host_line_too_long(&error) => {
                        let message = format!("Pi Host stderr line truncated: {error}");
                        {
                            let mut logs = stderr_buf.lock().await;
                            push_stderr_tail(&mut logs, message.clone(), 50);
                        }
                        eprintln!("[pideck] {message}");
                        let _ = app_err.emit("pi-host-stderr", message);
                        continue;
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
        #[cfg(unix)]
        let unix_process_group_for_monitor = unix_process_group.clone();

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
                            let is_hello_response = payload.contains("\"method\":\"system.hello\"");
                            let emitted = app_out.emit("pi-host-stdout", payload);
                            if is_hello_response {
                                eprintln!(
                                    "[pideck] system.hello response emitted to WebView: {}",
                                    emitted.is_ok()
                                );
                            }
                        }
                        Err(error) if is_host_line_too_long(&error) => {
                            let message = format!("Pi Host stdout frame dropped: {error}");
                            eprintln!("[pideck] {message}");
                            let _ = app_out.emit("pi-host-stderr", message);
                            continue;
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
                    #[cfg(unix)]
                    force_cleanup_unix_host_group(&unix_process_group_for_monitor);
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
        #[cfg(unix)]
        {
            self.unix_process_group = Some(unix_process_group);
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
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap(&mut self.unix_process_group).await;
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
        #[cfg(unix)]
        if let Some(child) = self.child.as_ref() {
            let exited = unix_child_exited_without_reaping(child.id())
                .map_err(|error| format!("host wait error: {error}"))?;
            if exited {
                force_cleanup_unix_host_group_slot_before_reap(&mut self.unix_process_group).await;
                let status = self
                    .child
                    .as_mut()
                    .expect("Host child exists after exit observation")
                    .wait()
                    .await
                    .map_err(|error| format!("host wait error: {error}"))?;
                self.stdin = None;
                self.child = None;
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
        }
        #[cfg(not(unix))]
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

        let stdin = self.stdin.as_ref().cloned().ok_or_else(|| {
            "host not running — use Settings → Restart Host (ensure `pnpm build` first)".to_string()
        })?;
        let mut guard = stdin.lock().await;
        let payload = if line.ends_with('\n') {
            line
        } else {
            format!("{line}\n")
        };
        if payload.contains("\"method\":\"system.hello\"") {
            eprintln!("[pideck] writing system.hello request to Host");
        }
        let result =
            write_host_stdin(&mut *guard, payload.as_bytes(), HOST_STDIN_WRITE_TIMEOUT).await;
        drop(guard);
        if result.is_err() {
            self.stdin = None;
        }
        result
    }

    pub async fn shutdown(&mut self) {
        self.shutdown_with_grace(HOST_SHUTDOWN_GRACE).await;
    }

    pub async fn shutdown_for_app_exit(&mut self) {
        self.shutdown_with_grace(APP_EXIT_HOST_SHUTDOWN_GRACE).await;
    }

    async fn shutdown_with_grace(&mut self, graceful_timeout: Duration) {
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

        #[cfg(unix)]
        let unix_process_group = self.unix_process_group.take();
        #[cfg(unix)]
        let mut group_cleanup = unix_process_group
            .as_ref()
            .and_then(UnixHostProcessGroup::claim_cleanup);
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            // Child::wait reaps on Unix, so graceful exit must be observed
            // without releasing the PID needed for process-group cleanup.
            let needs_force = !matches!(
                wait_for_unix_child_exit_without_reaping(child.id(), graceful_timeout,).await,
                Ok(true)
            );
            #[cfg(not(unix))]
            let needs_force = {
                let wait = tokio::time::timeout(graceful_timeout, child.wait()).await;
                !matches!(wait, Ok(Ok(_)))
            };
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                terminate_unix_host_group(cleanup).await;
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled().await;
            }
            if needs_force {
                let _ = child.kill().await;
                #[cfg(not(unix))]
                {
                    let _ = child.wait().await;
                }
            }
            #[cfg(unix)]
            {
                let _ = child.wait().await;
            }
        } else {
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                terminate_unix_host_group(cleanup).await;
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled().await;
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
        #[cfg(unix)]
        if let Some(child) = self.child.as_ref() {
            match unix_child_exited_without_reaping(child.id()) {
                Ok(true) => {
                    force_cleanup_unix_host_group_slot_before_reap_blocking(
                        &mut self.unix_process_group,
                    );
                    if let Some(child) = self.child.as_mut() {
                        let _ = child.try_wait();
                    }
                    self.child = None;
                    self.stdin = None;
                    false
                }
                Ok(false) => true,
                Err(_) => false,
            }
        } else {
            false
        }
        #[cfg(not(unix))]
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

impl Drop for PiHostManager {
    fn drop(&mut self) {
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
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
            .and_then(|abs| abs.canonicalize().or(Ok(abs)))
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

pub(crate) fn node_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

pub(crate) fn node_runtime_candidates(base: &Path) -> [PathBuf; 2] {
    let executable = node_executable_name();
    [
        base.join("node").join(executable),
        base.join("resources").join("node").join(executable),
    ]
}

pub(crate) fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn which_node() -> Result<PathBuf, ()> {
    // Try PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(node_executable_name());
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
    }
    // Common nvm4w / fnm locations on this machine class
    #[cfg(windows)]
    {
        for candidate in [
            PathBuf::from(r"C:\nvm4w\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        ] {
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
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

#[cfg(test)]
mod preload_session_tests {
    use super::*;

    #[test]
    fn preloads_last_session_when_it_belongs_to_the_startup_workspace() {
        let settings = DesktopSettings {
            last_workspace: Some(r"C:\repo".into()),
            last_session_path: Some(r"C:\sessions\kept.jsonl".into()),
            ..DesktopSettings::default()
        };
        assert_eq!(
            PiHostManager::session_from_settings(&settings),
            Some(PathBuf::from(r"C:\sessions\kept.jsonl"))
        );
    }

    #[test]
    fn does_not_preload_a_session_from_another_workspace() {
        let settings = DesktopSettings {
            default_workspace: Some(r"C:\default".into()),
            last_workspace: Some(r"C:\repo".into()),
            last_session_path: Some(r"C:\sessions\kept.jsonl".into()),
            ..DesktopSettings::default()
        };
        assert_eq!(PiHostManager::session_from_settings(&settings), None);
    }

    #[test]
    fn skips_session_preload_when_restore_is_disabled() {
        let settings = DesktopSettings {
            restore_last_session: false,
            last_workspace: Some(r"C:\repo".into()),
            last_session_path: Some(r"C:\sessions\kept.jsonl".into()),
            ..DesktopSettings::default()
        };
        assert_eq!(PiHostManager::session_from_settings(&settings), None);
    }
}
