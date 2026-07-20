use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::Channel;
use uuid::Uuid;

const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 300;
const MAX_INPUT_BYTES: usize = 256 * 1024;
const READ_BUFFER_BYTES: usize = 32 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellTerminalEvent {
    Output { data: String },
    Exited { exit_code: Option<u32> },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellTerminalCreateResult {
    pub terminal_id: String,
    pub title: String,
    pub cwd: String,
}

struct ResolvedShell {
    executable: PathBuf,
    args: Vec<String>,
    label: String,
}

struct ShellTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    stopping: Arc<AtomicBool>,
    reader_thread: Option<JoinHandle<()>>,
    #[cfg(windows)]
    windows_job: WindowsPtyJob,
    #[cfg(unix)]
    process_group_id: Option<i32>,
}

impl ShellTerminalSession {
    fn spawn(
        cwd: &Path,
        cols: u16,
        rows: u16,
        on_event: Channel<ShellTerminalEvent>,
    ) -> Result<(Self, String), String> {
        let shell = resolve_default_shell()?;
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|error| format!("open PTY: {error}"))?;
        let mut command = CommandBuilder::new(&shell.executable);
        command.cwd(cwd);
        for arg in &shell.args {
            command.arg(arg);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("start {}: {error}", shell.label))?;
        drop(pair.slave);

        #[cfg(windows)]
        let windows_job = match child.as_raw_handle() {
            Some(process_handle) => match WindowsPtyJob::assign(process_handle) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            },
            None => {
                let _ = child.kill();
                return Err("Shell exited before process-tree assignment".into());
            }
        };
        #[cfg(unix)]
        let process_group_id = pair.master.process_group_leader();
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("clone PTY reader: {error}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("take PTY writer: {error}"));
            }
        };
        let child = Arc::new(Mutex::new(child));
        let stopping = Arc::new(AtomicBool::new(false));
        let reader_child = Arc::clone(&child);
        let reader_stopping = Arc::clone(&stopping);
        let reader_thread = match std::thread::Builder::new()
            .name("pideck-shell-reader".into())
            .spawn(move || {
                let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
                let mut decoder = Utf8StreamDecoder::default();
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            if let Some(data) = decoder.push(&buffer[..read]) {
                                let _ = on_event.send(ShellTerminalEvent::Output { data });
                            }
                        }
                        Err(error) => {
                            if !reader_stopping.load(Ordering::SeqCst) {
                                let _ = on_event.send(ShellTerminalEvent::Error {
                                    message: format!("read PTY: {error}"),
                                });
                            }
                            break;
                        }
                    }
                }
                if let Some(data) = decoder.finish() {
                    let _ = on_event.send(ShellTerminalEvent::Output { data });
                }
                let exit_code = reader_child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.wait().ok())
                    .map(|status| status.exit_code());
                let _ = on_event.send(ShellTerminalEvent::Exited { exit_code });
            }) {
            Ok(thread) => thread,
            Err(error) => {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
                return Err(format!("start PTY reader: {error}"));
            }
        };

        Ok((
            Self {
                master: pair.master,
                writer: Mutex::new(writer),
                child,
                stopping,
                reader_thread: Some(reader_thread),
                #[cfg(windows)]
                windows_job,
                #[cfg(unix)]
                process_group_id,
            },
            shell.label,
        ))
    }

    fn write(&self, data: &str) -> Result<(), String> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(format!("terminal input exceeds {MAX_INPUT_BYTES} bytes"));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "terminal writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("write PTY: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("flush PTY: {error}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(|error| format!("resize PTY: {error}"))
    }

    fn shutdown(mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            unsafe {
                libc::kill(-process_group_id, libc::SIGHUP);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        drop(self.writer);
        drop(self.master);
        #[cfg(windows)]
        drop(self.windows_job);
        if let Some(reader_thread) = self.reader_thread.take() {
            let _ = reader_thread.join();
        }
    }
}

pub struct ShellTerminalManager {
    sessions: HashMap<String, ShellTerminalSession>,
}

impl ShellTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn create(
        &mut self,
        raw_cwd: &str,
        cols: u16,
        rows: u16,
        on_event: Channel<ShellTerminalEvent>,
    ) -> Result<ShellTerminalCreateResult, String> {
        let cwd = validate_terminal_cwd(raw_cwd)?;
        let (session, shell_title) = ShellTerminalSession::spawn(
            &cwd,
            clamp(cols, MIN_COLS, MAX_COLS),
            clamp(rows, MIN_ROWS, MAX_ROWS),
            on_event,
        )?;
        let terminal_id = Uuid::new_v4().to_string();
        self.sessions.insert(terminal_id.clone(), session);
        Ok(ShellTerminalCreateResult {
            terminal_id,
            title: shell_title,
            cwd: cwd.to_string_lossy().into_owned(),
        })
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        self.sessions
            .get(terminal_id)
            .ok_or_else(|| "unknown shell terminal".to_string())?
            .write(data)
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.sessions
            .get(terminal_id)
            .ok_or_else(|| "unknown shell terminal".to_string())?
            .resize(
                clamp(cols, MIN_COLS, MAX_COLS),
                clamp(rows, MIN_ROWS, MAX_ROWS),
            )
    }

    pub fn close(&mut self, terminal_id: &str) -> bool {
        let Some(session) = self.sessions.remove(terminal_id) else {
            return false;
        };
        session.shutdown();
        true
    }

    pub fn shutdown_all(&mut self) {
        for (_, session) in self.sessions.drain() {
            session.shutdown();
        }
    }
}

impl Drop for ShellTerminalManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

fn clamp(value: u16, min: u16, max: u16) -> u16 {
    value.max(min).min(max)
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: clamp(cols, MIN_COLS, MAX_COLS),
        rows: clamp(rows, MIN_ROWS, MAX_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub(crate) fn validate_terminal_cwd(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("terminal cwd is empty".into());
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return Err("network (UNC) terminal directories are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("terminal cwd must be absolute".into());
    }
    let cwd = path
        .canonicalize()
        .map_err(|error| format!("terminal cwd is not accessible: {error}"))?;
    if !cwd.is_dir() {
        return Err("terminal cwd must be a directory".into());
    }
    #[cfg(windows)]
    let cwd = crate::pi_host::strip_verbatim_prefix(cwd);
    #[cfg(windows)]
    if cwd.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) terminal directories are not allowed".into());
    }
    Ok(cwd)
}

#[cfg(windows)]
fn resolve_default_shell() -> Result<ResolvedShell, String> {
    let mut candidates: Vec<(PathBuf, Vec<String>, &str)> = Vec::new();
    for var in ["ProgramW6432", "ProgramFiles"] {
        if let Some(root) = std::env::var_os(var) {
            candidates.push((
                PathBuf::from(root).join("PowerShell/7/pwsh.exe"),
                vec!["-NoLogo".into()],
                "PowerShell",
            ));
        }
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        candidates.push((
            PathBuf::from(&root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            vec!["-NoLogo".into()],
            "Windows PowerShell",
        ));
        candidates.push((
            PathBuf::from(root).join("System32/cmd.exe"),
            Vec::new(),
            "Command Prompt",
        ));
    }
    if let Some(comspec) = std::env::var_os("ComSpec") {
        candidates.push((PathBuf::from(comspec), Vec::new(), "Command Prompt"));
    }
    candidates
        .into_iter()
        .find(|(path, _, _)| path.is_file())
        .map(|(executable, args, label)| ResolvedShell {
            executable,
            args,
            label: label.into(),
        })
        .ok_or_else(|| "No supported Windows shell was found".into())
}

#[cfg(unix)]
fn resolve_default_shell() -> Result<ResolvedShell, String> {
    let configured = std::env::var_os("SHELL").map(PathBuf::from);
    let executable = configured
        .filter(|path| path.is_absolute() && path.is_file())
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
        })
        .ok_or_else(|| "No supported login shell was found".to_string())?;
    let label = executable
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Shell")
        .to_string();
    Ok(ResolvedShell {
        executable,
        args: vec!["-l".into()],
        label,
    })
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> Option<String> {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push_str(unsafe {
                            std::str::from_utf8_unchecked(&self.pending[..valid])
                        });
                        self.pending.drain(..valid);
                    }
                    if let Some(invalid_len) = error.error_len() {
                        output.push('\u{fffd}');
                        self.pending.drain(..invalid_len);
                    } else {
                        break;
                    }
                }
            }
        }
        (!output.is_empty()).then_some(output)
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(std::mem::take(&mut self.pending).as_slice()).into_owned())
    }
}

#[cfg(windows)]
struct WindowsPtyJob {
    handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl WindowsPtyJob {
    fn assign(process_handle: std::os::windows::io::RawHandle) -> Result<Self, String> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw_job.is_null() {
                return Err(format!(
                    "create Shell Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let job = Self {
                handle: OwnedHandle::from_raw_handle(raw_job),
            };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!(
                    "configure Shell Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if AssignProcessToJobObject(job.handle.as_raw_handle(), process_handle) == 0 {
                return Err(format!(
                    "assign Shell to Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(job)
        }
    }
}

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_pty_dimensions() {
        assert_eq!(pty_size(1, 1).cols, MIN_COLS);
        assert_eq!(pty_size(u16::MAX, u16::MAX).rows, MAX_ROWS);
    }

    #[test]
    fn validates_terminal_directories() {
        assert!(validate_terminal_cwd("").is_err());
        assert!(validate_terminal_cwd("relative").is_err());
        assert!(validate_terminal_cwd("//server/share").is_err());
        assert!(validate_terminal_cwd(std::env::temp_dir().to_string_lossy().as_ref()).is_ok());
    }

    #[test]
    fn decodes_utf8_split_across_pty_reads() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(&[0xe4, 0xbd]), None);
        assert_eq!(decoder.push(&[0xa0, 0xe5, 0xa5, 0xbd]), Some("你好".into()));
        assert_eq!(decoder.finish(), None);
    }
}
