use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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

pub struct DesktopSettingsStore {
    path: PathBuf,
    pub settings: DesktopSettings,
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
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("desktop-settings.json");
        let settings = if path.exists() {
            let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            DesktopSettings::default()
        };
        Ok(Self { path, settings })
    }

    pub fn save(&self) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(&self.settings).map_err(|e| e.to_string())?;
        fs::write(&self.path, raw).map_err(|e| e.to_string())
    }

    pub fn patch(&mut self, patch: serde_json::Value) -> Result<DesktopSettings, String> {
        let mut current = serde_json::to_value(&self.settings).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                obj.insert(k.clone(), v.clone());
            }
        }
        self.settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
        self.save()?;
        Ok(self.settings.clone())
    }

    pub fn resolved_agent_dir(&self) -> PathBuf {
        if let Some(ref d) = self.settings.agent_dir {
            return PathBuf::from(d);
        }
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".pi")
            .join("agent")
    }
}
