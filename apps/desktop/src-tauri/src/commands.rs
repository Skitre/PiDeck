use crate::desktop_settings::DesktopSettings;
use crate::AppState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub async fn desktop_settings_get(state: State<'_, AppState>) -> Result<DesktopSettings, String> {
    let store = state.settings.lock().await;
    Ok(store.settings.clone())
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
    Ok(next)
}

#[tauri::command]
pub async fn desktop_open_path(path: String) -> Result<(), String> {
    let target = validate_open_path(&path)?;
    open_in_file_manager(target)
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

/// What the file manager should do with a validated local path.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenTarget {
    /// Open the directory itself.
    Directory(PathBuf),
    /// Reveal (select) the file in its parent directory — never executes it.
    Reveal(PathBuf),
}

/// The webview may only point the file manager at an existing local
/// directory or file. Anything else — relative paths, UNC/network paths,
/// non-existent paths — is rejected so a compromised renderer cannot use
/// this command to launch arbitrary programs.
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
    #[cfg(not(target_os = "windows"))]
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
        let dir = std::env::temp_dir().join("pi-desktop-open-path-test");
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
}
