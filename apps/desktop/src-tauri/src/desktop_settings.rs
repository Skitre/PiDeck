use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "desktop-settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopSettings {
    pub theme: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_workspace: Option<String>,
    pub restore_last_session: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_dir: Option<String>,
    pub auto_restart_host_once: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub known_workspaces: Vec<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_workspace: None,
            restore_last_session: true,
            last_workspace: None,
            last_session_path: None,
            agent_dir: None,
            auto_restart_host_once: true,
            known_workspaces: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    schema_version: u32,
    settings: DesktopSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsSnapshot {
    pub schema_version: u32,
    pub settings: DesktopSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<String>,
}

pub struct DesktopSettingsStore {
    path: PathBuf,
    pub settings: DesktopSettings,
    warning: Option<String>,
    recovered_from: Option<PathBuf>,
}

impl DesktopSettingsStore {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let dir = match std::env::var_os("PIDECK_CONFIG_DIR") {
            Some(value) => {
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Err("PIDECK_CONFIG_DIR must be an absolute path".into());
                }
                path
            }
            None => app.path().app_config_dir().map_err(|e| e.to_string())?,
        };
        Self::load_from_dir(&dir)
    }

    fn load_from_dir(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join(SETTINGS_FILE_NAME);
        if !path.exists() {
            return Ok(Self {
                path,
                settings: DesktopSettings::default(),
                warning: None,
                recovered_from: None,
            });
        }

        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        match Self::parse_settings(&raw) {
            Ok((settings, legacy)) => {
                let store = Self {
                    path,
                    settings,
                    warning: legacy.then(|| {
                        "Desktop settings were migrated to the current versioned format".into()
                    }),
                    recovered_from: None,
                };
                if legacy {
                    store.save()?;
                }
                Ok(store)
            }
            Err(parse_error) => {
                let recovered_from = Self::quarantine_corrupt_file(&path)?;
                let store = Self {
                    path,
                    settings: DesktopSettings::default(),
                    warning: Some(format!(
                        "Desktop settings were corrupt and defaults were restored: {parse_error}"
                    )),
                    recovered_from: Some(recovered_from),
                };
                store.save()?;
                Ok(store)
            }
        }
    }

    fn parse_settings(raw: &str) -> Result<(DesktopSettings, bool), String> {
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        if value.get("schemaVersion").is_some() || value.get("settings").is_some() {
            let file: SettingsFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
            if file.schema_version != SETTINGS_SCHEMA_VERSION {
                return Err(format!(
                    "unsupported settings schema version {}",
                    file.schema_version
                ));
            }
            Ok((file.settings, false))
        } else {
            let settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
            Ok((settings, true))
        }
    }

    fn quarantine_corrupt_file(path: &Path) -> Result<PathBuf, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let backup = path.with_file_name(format!("desktop-settings.corrupt-{timestamp}.json"));
        fs::rename(path, &backup).map_err(|e| {
            format!(
                "could not preserve corrupt settings at {}: {e}",
                backup.display()
            )
        })?;
        Ok(backup)
    }

    fn write_settings(&self, settings: &DesktopSettings) -> Result<(), String> {
        let raw = serde_json::to_vec_pretty(&SettingsFile {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: settings.clone(),
        })
        .map_err(|e| e.to_string())?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "settings path has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temp = parent.join(format!(
            ".{SETTINGS_FILE_NAME}.{}.{}.tmp",
            std::process::id(),
            Uuid::new_v4()
        ));

        let write_result = (|| -> Result<(), String> {
            let mut file = File::create(&temp).map_err(|e| e.to_string())?;
            file.write_all(&raw).map_err(|e| e.to_string())?;
            file.write_all(b"\n").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            replace_file(&temp, &self.path)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        write_result
    }

    pub fn snapshot(&self) -> DesktopSettingsSnapshot {
        DesktopSettingsSnapshot {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: self.settings.clone(),
            warning: self.warning.clone(),
            recovered_from: self
                .recovered_from
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        self.write_settings(&self.settings)
    }

    pub fn patch(&mut self, patch: serde_json::Value) -> Result<DesktopSettings, String> {
        let mut current = serde_json::to_value(&self.settings).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(patch_object)) = (current.as_object_mut(), patch.as_object()) {
            for (key, value) in patch_object {
                obj.insert(key.clone(), value.clone());
            }
        }
        let next = serde_json::from_value(current).map_err(|e| e.to_string())?;
        self.write_settings(&next)?;
        self.settings = next;
        Ok(self.settings.clone())
    }

    pub fn resolved_agent_dir(&self) -> PathBuf {
        if let Some(ref dir) = self.settings.agent_dir {
            return PathBuf::from(dir);
        }
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".pi")
            .join("agent")
    }
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pideck-settings-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_versioned_settings_atomically_and_round_trips() {
        let dir = test_dir("roundtrip");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store
            .patch(serde_json::json!({ "theme": "dark", "lastWorkspace": "C:\\repo" }))
            .unwrap();

        let raw = fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["settings"]["theme"], "dark");
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, "dark");
        assert_eq!(loaded.settings.last_workspace.as_deref(), Some("C:\\repo"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_unversioned_settings() {
        let dir = test_dir("legacy");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"theme":"light","restoreLastSession":false}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, "light");
        assert!(!loaded.settings.restore_last_session);
        assert!(loaded.snapshot().warning.is_some());
        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(migrated["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quarantines_corrupt_settings_and_surfaces_recovery() {
        let dir = test_dir("corrupt");
        fs::write(dir.join(SETTINGS_FILE_NAME), b"{not-json").unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        let snapshot = loaded.snapshot();
        assert_eq!(loaded.settings.theme, "system");
        assert!(snapshot.warning.unwrap().contains("corrupt"));
        let backup = PathBuf::from(snapshot.recovered_from.unwrap());
        assert!(backup.exists());
        assert_eq!(fs::read_to_string(backup).unwrap(), "{not-json");
        let replacement: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(replacement["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        fs::remove_dir_all(dir).unwrap();
    }
}
