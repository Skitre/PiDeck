use crate::browser_surface::{BrowserSurfaceBounds, BrowserSurfaceSnapshot};
use crate::desktop_settings::{DesktopSettings, DesktopSettingsSnapshot};
use crate::draft_store::{DraftApplyResult, DraftMutation, DraftWorkspaceSnapshot};
use crate::shell_terminal::{
    shell_profile_catalog, ShellProfileCatalog, ShellTerminalCreateResult, ShellTerminalEvent,
};
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{ipc::Channel, AppHandle, State};

#[tauri::command]
pub async fn desktop_settings_get(
    state: State<'_, AppState>,
) -> Result<DesktopSettingsSnapshot, String> {
    let store = state.settings.lock().await;
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn desktop_settings_patch(
    state: State<'_, AppState>,
    patch: Value,
) -> Result<DesktopSettings, String> {
    let mut store = state.settings.lock().await;
    let next = store.patch(patch)?;
    // Propagate agentDir / autoRestart to host manager
    let mut host = state.host.lock().await;
    host.set_agent_dir(store.resolved_agent_dir());
    host.set_auto_restart_once(store.settings.auto_restart_host_once);
    host.set_initial_workspace(&store);
    Ok(next)
}

#[tauri::command]
pub async fn desktop_drafts_get(
    state: State<'_, AppState>,
    canonical_cwd: String,
) -> Result<DraftWorkspaceSnapshot, String> {
    let mut store = state.drafts.lock().await;
    store.workspace_snapshot(&canonical_cwd)
}

#[tauri::command]
pub async fn desktop_drafts_apply(
    state: State<'_, AppState>,
    mutations: Vec<DraftMutation>,
) -> Result<DraftApplyResult, String> {
    let mut store = state.drafts.lock().await;
    store.apply(mutations)
}

#[tauri::command]
pub async fn desktop_open_path(path: String) -> Result<(), String> {
    let target = validate_open_path(&path)?;
    open_in_file_manager(target)
}

const MAX_SMALL_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SMALL_TEXT_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSmallFile {
    kind: &'static str,
    name: String,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[tauri::command]
pub fn desktop_read_small_file(path: String) -> Result<DesktopSmallFile, String> {
    read_small_file(&path)
}

fn read_small_file(raw: &str) -> Result<DesktopSmallFile, String> {
    let path = validate_local_file(raw)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("file is not accessible: {e}"))?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_SMALL_IMAGE_BYTES {
        return Err(format!(
            "file exceeds the {} MiB local-read limit",
            MAX_SMALL_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read file: {e}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "file name is not valid UTF-8".to_string())?
        .to_string();

    if let Some(media_type) = sniff_image_media_type(&bytes) {
        return Ok(DesktopSmallFile {
            kind: "image",
            name,
            size_bytes,
            media_type: Some(media_type),
            data: Some(BASE64_STANDARD.encode(bytes)),
            text: None,
        });
    }

    if size_bytes > MAX_SMALL_TEXT_BYTES {
        return Err(format!(
            "text file exceeds the {} KiB local-read limit",
            MAX_SMALL_TEXT_BYTES / 1024
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    if looks_binary_text(&text) {
        return Err("binary file type is not supported".to_string());
    }
    Ok(DesktopSmallFile {
        kind: "text",
        name,
        size_bytes,
        media_type: None,
        data: None,
        text: Some(text),
    })
}

fn validate_local_file(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("path does not exist: {e}"))?;
    let resolved = crate::pi_host::strip_verbatim_prefix(resolved);
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let metadata =
        std::fs::metadata(&resolved).map_err(|e| format!("file is not accessible: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    Ok(resolved)
}

fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn looks_binary_text(text: &str) -> bool {
    text.contains('\0')
}

#[tauri::command]
pub async fn pi_host_send(state: State<'_, AppState>, line: String) -> Result<(), String> {
    let mut host = state.host.lock().await;
    host.send_line(line).await
}

#[tauri::command]
pub async fn pi_host_restart(state: State<'_, AppState>) -> Result<(), String> {
    // Holds the host mutex only for spawn/commit, not across the ready-wait.
    crate::pi_host::start_unlocked(&state.host, crate::pi_host::StartKind::ManualRestart).await
}

#[tauri::command]
pub async fn pi_host_status(state: State<'_, AppState>) -> Result<bool, String> {
    let mut host = state.host.lock().await;
    Ok(host.is_running())
}

#[tauri::command]
pub async fn shell_terminal_create(
    state: State<'_, AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
    profile_id: String,
    on_event: Channel<ShellTerminalEvent>,
) -> Result<ShellTerminalCreateResult, String> {
    let mut terminals = state.terminals.lock().await;
    terminals.create(&cwd, cols, rows, &profile_id, on_event)
}

#[tauri::command]
pub async fn shell_terminal_profiles() -> Result<ShellProfileCatalog, String> {
    shell_profile_catalog()
}

#[tauri::command]
pub async fn shell_terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    // A completion may wait on PTY capacity; only enqueue while holding the manager lock.
    let completion = {
        let terminals = state.terminals.lock().await;
        terminals.enqueue_write(&terminal_id, data)?
    };
    completion
        .await
        .map_err(|_| "terminal writer stopped before completing input".to_string())?
}

#[tauri::command]
pub async fn shell_terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().await;
    terminals.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub async fn shell_terminal_close(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<bool, String> {
    let mut terminals = state.terminals.lock().await;
    Ok(terminals.close(&terminal_id))
}

#[tauri::command]
pub async fn browser_surface_create(
    app: AppHandle,
    state: State<'_, AppState>,
    surface_id: String,
    url: String,
    bounds: BrowserSurfaceBounds,
    visible: bool,
) -> Result<BrowserSurfaceSnapshot, String> {
    let mut browsers = state.browsers.lock().await;
    browsers.create(&app, &surface_id, &url, bounds, visible)
}

#[tauri::command]
pub async fn browser_surface_navigate(
    state: State<'_, AppState>,
    surface_id: String,
    url: String,
) -> Result<String, String> {
    let browsers = state.browsers.lock().await;
    browsers.navigate(&surface_id, &url)
}

#[tauri::command]
pub async fn browser_surface_control(
    state: State<'_, AppState>,
    surface_id: String,
    action: String,
) -> Result<(), String> {
    let browsers = state.browsers.lock().await;
    browsers.control(&surface_id, &action)
}

#[tauri::command]
pub async fn browser_surface_set_bounds(
    state: State<'_, AppState>,
    surface_id: String,
    bounds: BrowserSurfaceBounds,
) -> Result<(), String> {
    let mut browsers = state.browsers.lock().await;
    browsers.set_bounds(&surface_id, bounds)
}

#[tauri::command]
pub async fn browser_surface_set_visible(
    state: State<'_, AppState>,
    surface_id: String,
    visible: bool,
) -> Result<(), String> {
    let mut browsers = state.browsers.lock().await;
    browsers.set_visible(&surface_id, visible)
}

#[tauri::command]
pub async fn browser_surface_focus(
    state: State<'_, AppState>,
    surface_id: String,
) -> Result<(), String> {
    let browsers = state.browsers.lock().await;
    browsers.focus(&surface_id)
}

#[tauri::command]
pub async fn browser_surface_close(
    state: State<'_, AppState>,
    surface_id: String,
) -> Result<bool, String> {
    let mut browsers = state.browsers.lock().await;
    browsers.close(&surface_id)
}

/// What the file manager should do with a validated local path.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenTarget {
    /// Reveal (select) the directory in the platform file manager.
    Directory(PathBuf),
    /// Reveal (select) the file in its parent directory.
    Reveal(PathBuf),
}

/// The webview may only point the file manager at an existing local
/// directory or file. Anything else — relative paths, UNC/network paths,
/// non-existent paths — is rejected before the path is passed as an argument
/// to the platform file manager.
pub fn validate_open_path(raw: &str) -> Result<OpenTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    // Resolve symlinks/relative components; fails for non-existent paths.
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("path does not exist: {e}"))?;
    let resolved = crate::pi_host::strip_verbatim_prefix(resolved);
    // Re-check after canonicalize: a symlink may resolve to a network path
    // (\\?\UNC\... is rendered back as \\server\share by strip_verbatim_prefix).
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("path is not accessible: {e}"))?;
    if meta.is_dir() {
        Ok(OpenTarget::Directory(resolved))
    } else if meta.is_file() {
        Ok(OpenTarget::Reveal(resolved))
    } else {
        Err("path is neither a regular file nor a directory".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_open_args(target: &OpenTarget) -> Vec<std::ffi::OsString> {
    let path = match target {
        OpenTarget::Directory(dir) => dir,
        OpenTarget::Reveal(file) => file,
    };
    vec![
        std::ffi::OsString::from("-R"),
        path.as_os_str().to_os_string(),
    ]
}

fn open_in_file_manager(target: OpenTarget) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer.exe");
        match &target {
            OpenTarget::Directory(dir) => {
                cmd.arg(dir);
            }
            OpenTarget::Reveal(file) => {
                // `/select,` shows the file in its folder without opening/executing it.
                cmd.arg(format!("/select,{}", file.display()));
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.args(macos_open_args(&target));
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = match &target {
            OpenTarget::Directory(dir) => dir.clone(),
            OpenTarget::Reveal(file) => file
                .parent()
                .map(|p| p.to_path_buf())
                .ok_or_else(|| "file has no parent directory".to_string())?,
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pideck-small-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn rejects_empty_and_relative_paths() {
        assert!(validate_open_path("").is_err());
        assert!(validate_open_path("   ").is_err());
        assert!(validate_open_path("relative/dir").is_err());
        assert!(validate_open_path("./here").is_err());
    }

    #[test]
    fn rejects_unc_paths() {
        assert!(validate_open_path("\\\\attacker\\share\\evil.exe").is_err());
        assert!(validate_open_path("//attacker/share/evil.exe").is_err());
    }

    #[test]
    fn rejects_nonexistent_paths() {
        assert!(validate_open_path("C:\\definitely\\not\\a\\real\\path\\x9z").is_err());
    }

    #[test]
    fn accepts_existing_directory() {
        let dir = std::env::temp_dir();
        let target = validate_open_path(dir.to_str().unwrap()).unwrap();
        assert!(matches!(target, OpenTarget::Directory(_)));
    }

    #[test]
    fn files_are_revealed_not_opened() {
        let dir = std::env::temp_dir().join("pideck-open-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.exe");
        std::fs::write(&file, b"not really an exe").unwrap();
        let target = validate_open_path(file.to_str().unwrap()).unwrap();
        match target {
            OpenTarget::Reveal(p) => assert!(p.ends_with("sample.exe")),
            other => panic!("expected Reveal, got {other:?}"),
        }
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn macos_reveals_directories_and_files() {
        let app = PathBuf::from("/Applications/Example.app");
        assert_eq!(
            macos_open_args(&OpenTarget::Directory(app.clone())),
            vec![std::ffi::OsString::from("-R"), app.into_os_string()],
        );

        let file = PathBuf::from("/tmp/example.txt");
        assert_eq!(
            macos_open_args(&OpenTarget::Reveal(file.clone())),
            vec![std::ffi::OsString::from("-R"), file.into_os_string()],
        );
    }

    #[test]
    fn reads_small_utf8_text() {
        let path = temp_test_file("notes.txt", "hello 世界".as_bytes());
        let file = read_small_file(path.to_str().unwrap()).unwrap();
        assert_eq!(file.kind, "text");
        assert_eq!(file.name, "notes.txt");
        assert_eq!(file.text.as_deref(), Some("hello 世界"));
        assert!(file.data.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn sniffs_images_instead_of_trusting_extension() {
        let path = temp_test_file("not-an-image.txt", b"\x89PNG\r\n\x1a\nrest");
        let file = read_small_file(path.to_str().unwrap()).unwrap();
        assert_eq!(file.kind, "image");
        assert_eq!(file.media_type, Some("image/png"));
        assert!(file.data.as_deref().is_some_and(|value| !value.is_empty()));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rejects_binary_and_oversized_text() {
        let binary = temp_test_file("binary.dat", b"abc\0def");
        assert!(read_small_file(binary.to_str().unwrap()).is_err());
        let oversized = temp_test_file("large.txt", &vec![b'a'; MAX_SMALL_TEXT_BYTES as usize + 1]);
        assert!(read_small_file(oversized.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(binary.parent().unwrap());
        let _ = std::fs::remove_dir_all(oversized.parent().unwrap());
    }
}
