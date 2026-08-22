use crate::extension_ui_settings::{deserialize_extension_ui_settings, ExtensionUiSettings};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "desktop-settings.json";
const PIDECK_DATA_DIR_NAME: &str = "pideck";
const DEFAULT_PROJECT_DIR_NAME: &str = "DefaultProject";
const DEFAULT_CONVERSATION_CONTENT_WIDTH: u32 = 668;
const MIN_CONVERSATION_CONTENT_WIDTH: u32 = 560;
const DEFAULT_CONVERSATION_FONT_SIZE: u32 = 14;
const MIN_CONVERSATION_FONT_SIZE: u32 = 12;
const MAX_CONVERSATION_FONT_SIZE: u32 = 18;
const DEFAULT_CODE_FONT_SIZE: u32 = 12;
const MIN_CODE_FONT_SIZE: u32 = 10;
const MAX_CODE_FONT_SIZE: u32 = 18;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopTheme {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopLanguage {
    System,
    En,
    Zh,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopThemeFamily {
    #[default]
    Pideck,
    Vercel,
    Apple,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopInterfaceDensity {
    Compact,
    #[default]
    Standard,
    Comfortable,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalProfileId {
    #[default]
    Auto,
    Pwsh,
    WindowsPowershell,
    Cmd,
    GitBash,
    WslDefault,
    Zsh,
    Bash,
    Fish,
    Sh,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionDecisionPresentation {
    LegacyModal,
    #[default]
    Auto,
    InlineFirst,
}

fn legacy_extension_decision_presentation() -> ExtensionDecisionPresentation {
    ExtensionDecisionPresentation::LegacyModal
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusySendBehavior {
    #[default]
    FollowUp,
    Steer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopSettings {
    pub theme: DesktopTheme,
    pub theme_family: DesktopThemeFamily,
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
    pub busy_send_behavior: BusySendBehavior,
    #[serde(default = "legacy_extension_decision_presentation")]
    pub extension_decision_presentation: ExtensionDecisionPresentation,
    pub terminal_profile: TerminalProfileId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<DesktopLanguage>,
    pub interface_density: DesktopInterfaceDensity,
    pub conversation_content_width: u32,
    pub conversation_font_size: u32,
    pub code_font_size: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub known_workspaces: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub shortcut_overrides: BTreeMap<String, Option<String>>,
    #[serde(default, deserialize_with = "deserialize_extension_ui_settings")]
    pub extension_ui: ExtensionUiSettings,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: DesktopTheme::System,
            theme_family: DesktopThemeFamily::Pideck,
            default_workspace: None,
            restore_last_session: true,
            last_workspace: None,
            last_session_path: None,
            agent_dir: None,
            auto_restart_host_once: true,
            busy_send_behavior: BusySendBehavior::FollowUp,
            extension_decision_presentation: ExtensionDecisionPresentation::Auto,
            terminal_profile: TerminalProfileId::Auto,
            language: None,
            interface_density: DesktopInterfaceDensity::Standard,
            conversation_content_width: DEFAULT_CONVERSATION_CONTENT_WIDTH,
            conversation_font_size: DEFAULT_CONVERSATION_FONT_SIZE,
            code_font_size: DEFAULT_CODE_FONT_SIZE,
            known_workspaces: Vec::new(),
            shortcut_overrides: BTreeMap::new(),
            extension_ui: ExtensionUiSettings::default(),
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
    fn recovery_defaults() -> DesktopSettings {
        DesktopSettings {
            extension_decision_presentation: ExtensionDecisionPresentation::LegacyModal,
            ..DesktopSettings::default()
        }
    }

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
                    settings: Self::recovery_defaults(),
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
        let (mut settings, legacy) = if value.get("schemaVersion").is_some()
            || value.get("settings").is_some()
        {
            let file: SettingsFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
            if file.schema_version != SETTINGS_SCHEMA_VERSION {
                return Err(format!(
                    "unsupported settings schema version {}",
                    file.schema_version
                ));
            }
            (file.settings, false)
        } else {
            let settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
            (settings, true)
        };
        settings.conversation_content_width = settings
            .conversation_content_width
            .max(MIN_CONVERSATION_CONTENT_WIDTH);
        settings.conversation_font_size = settings
            .conversation_font_size
            .clamp(MIN_CONVERSATION_FONT_SIZE, MAX_CONVERSATION_FONT_SIZE);
        settings.code_font_size = settings
            .code_font_size
            .clamp(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE);
        Ok((settings, legacy))
    }

    fn validate_settings(settings: &DesktopSettings) -> Result<(), String> {
        if settings.conversation_content_width < MIN_CONVERSATION_CONTENT_WIDTH {
            return Err(format!(
                "conversationContentWidth must be at least {MIN_CONVERSATION_CONTENT_WIDTH}"
            ));
        }
        if !(MIN_CONVERSATION_FONT_SIZE..=MAX_CONVERSATION_FONT_SIZE)
            .contains(&settings.conversation_font_size)
        {
            return Err(format!(
                "conversationFontSize must be between {MIN_CONVERSATION_FONT_SIZE} and {MAX_CONVERSATION_FONT_SIZE}"
            ));
        }
        if !(MIN_CODE_FONT_SIZE..=MAX_CODE_FONT_SIZE).contains(&settings.code_font_size) {
            return Err(format!(
                "codeFontSize must be between {MIN_CODE_FONT_SIZE} and {MAX_CODE_FONT_SIZE}"
            ));
        }
        Ok(())
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

    pub fn ensure_default_project_workspace(&mut self) -> Result<Option<PathBuf>, String> {
        let has_workspace = self
            .settings
            .default_workspace
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
            || self
                .settings
                .last_workspace
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty())
            || self
                .settings
                .known_workspaces
                .iter()
                .any(|path| !path.trim().is_empty());
        if has_workspace {
            return Ok(None);
        }

        let namespace_dir = self.resolved_agent_dir().join(PIDECK_DATA_DIR_NAME);
        let project_dir = namespace_dir.join(DEFAULT_PROJECT_DIR_NAME);
        create_private_directory(&namespace_dir)?;
        create_private_directory(&project_dir)?;

        let project_path = project_dir.to_string_lossy().into_owned();
        let mut next = self.settings.clone();
        next.default_workspace = None;
        next.last_workspace = Some(project_path.clone());
        next.known_workspaces = vec![project_path];
        self.write_settings(&next)?;
        self.settings = next;
        Ok(Some(project_dir))
    }

    pub fn patch(&mut self, patch: serde_json::Value) -> Result<DesktopSettings, String> {
        let mut current = serde_json::to_value(&self.settings).map_err(|e| e.to_string())?;
        let patch_object = patch
            .as_object()
            .ok_or_else(|| "desktop settings patch must be an object".to_string())?;
        for key in patch_object.keys() {
            if !matches!(
                key.as_str(),
                "theme"
                    | "themeFamily"
                    | "defaultWorkspace"
                    | "restoreLastSession"
                    | "lastWorkspace"
                    | "lastSessionPath"
                    | "agentDir"
                    | "autoRestartHostOnce"
                    | "busySendBehavior"
                    | "extensionDecisionPresentation"
                    | "terminalProfile"
                    | "language"
                    | "interfaceDensity"
                    | "conversationContentWidth"
                    | "conversationFontSize"
                    | "codeFontSize"
                    | "knownWorkspaces"
                    | "shortcutOverrides"
                    | "extensionUi"
            ) {
                return Err(format!("unknown desktop settings field: {key}"));
            }
        }
        let current_object = current
            .as_object_mut()
            .ok_or_else(|| "desktop settings must serialize as an object".to_string())?;
        if let Some(extension_ui) = patch_object.get("extensionUi") {
            if !extension_ui.is_object() && !extension_ui.is_null() {
                return Err("extensionUi must be an object".into());
            }
        }
        for (key, value) in patch_object {
            current_object.insert(key.clone(), value.clone());
        }
        let next = serde_json::from_value(current).map_err(|e| e.to_string())?;
        Self::validate_settings(&next)?;
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

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("create directory {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("set directory permissions {}: {error}", path.display()))?;
    }
    Ok(())
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
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pideck-settings-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn persists_the_language_preference_across_reloads() {
        let dir = test_dir("language");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store
            .patch(serde_json::json!({ "language": "zh" }))
            .unwrap();
        assert_eq!(store.settings.language, Some(DesktopLanguage::Zh));

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.language, Some(DesktopLanguage::Zh));

        let mut cleared = reloaded;
        cleared
            .patch(serde_json::json!({ "language": null }))
            .unwrap();
        assert_eq!(cleared.settings.language, None);
    }

    #[test]
    fn rejects_values_outside_the_desktop_settings_contract() {
        let dir = test_dir("contract-validation");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        let before = serde_json::to_value(&store.settings).unwrap();

        for patch in [
            serde_json::json!({ "theme": "neon" }),
            serde_json::json!({ "themeFamily": "neon" }),
            serde_json::json!({ "language": "fr" }),
            serde_json::json!({ "interfaceDensity": "dense" }),
            serde_json::json!({ "conversationFontSize": 11 }),
            serde_json::json!({ "codeFontSize": 19 }),
            serde_json::json!({ "terminalProfile": "nu" }),
            serde_json::json!({ "futureSetting": true }),
            serde_json::json!(["theme", "dark"]),
        ] {
            assert!(store.patch(patch).is_err());
            assert_eq!(serde_json::to_value(&store.settings).unwrap(), before);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_validates_and_persists_conversation_content_width() {
        let dir = test_dir("conversation-content-width");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.conversation_content_width,
            DEFAULT_CONVERSATION_CONTENT_WIDTH
        );

        store
            .patch(serde_json::json!({ "conversationContentWidth": 920 }))
            .unwrap();
        assert_eq!(store.settings.conversation_content_width, 920);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.conversation_content_width, 920);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "conversationContentWidth": 559 }))
            .unwrap_err()
            .contains("must be at least 560"));
        assert_eq!(invalid.settings.conversation_content_width, 920);
        fs::remove_dir_all(dir).unwrap();

        let stale_dir = test_dir("stale-conversation-content-width");
        fs::write(
            stale_dir.join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"settings":{"conversationContentWidth":500}}"#,
        )
        .unwrap();
        let normalized = DesktopSettingsStore::load_from_dir(&stale_dir).unwrap();
        assert_eq!(
            normalized.settings.conversation_content_width,
            MIN_CONVERSATION_CONTENT_WIDTH
        );
        fs::remove_dir_all(stale_dir).unwrap();
    }

    #[test]
    fn defaults_validates_and_persists_appearance_preferences() {
        let dir = test_dir("appearance-preferences");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.interface_density,
            DesktopInterfaceDensity::Standard
        );
        assert_eq!(store.settings.theme_family, DesktopThemeFamily::Pideck);
        assert_eq!(
            store.settings.conversation_font_size,
            DEFAULT_CONVERSATION_FONT_SIZE
        );
        assert_eq!(store.settings.code_font_size, DEFAULT_CODE_FONT_SIZE);

        store
            .patch(serde_json::json!({
                "themeFamily": "vercel",
                "interfaceDensity": "compact",
                "conversationFontSize": 17,
                "codeFontSize": 15
            }))
            .unwrap();
        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.interface_density,
            DesktopInterfaceDensity::Compact
        );
        assert_eq!(reloaded.settings.theme_family, DesktopThemeFamily::Vercel);
        assert_eq!(reloaded.settings.conversation_font_size, 17);
        assert_eq!(reloaded.settings.code_font_size, 15);

        let mut apple = reloaded;
        apple
            .patch(serde_json::json!({ "themeFamily": "apple" }))
            .unwrap();
        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.theme_family, DesktopThemeFamily::Apple);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "conversationFontSize": 19 }))
            .unwrap_err()
            .contains("between 12 and 18"));
        assert_eq!(invalid.settings.conversation_font_size, 17);
        assert!(invalid
            .patch(serde_json::json!({ "codeFontSize": 9 }))
            .unwrap_err()
            .contains("between 10 and 18"));
        assert_eq!(invalid.settings.code_font_size, 15);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_and_persists_shortcut_overrides() {
        let dir = test_dir("shortcut-overrides");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store
            .patch(serde_json::json!({
                "shortcutOverrides": {
                    "session.new": "mod+shift+n",
                    "chat.stop": null
                }
            }))
            .unwrap();
        assert_eq!(
            store
                .settings
                .shortcut_overrides
                .get("session.new")
                .and_then(|value| value.as_deref()),
            Some("mod+shift+n")
        );
        assert_eq!(
            store.settings.shortcut_overrides.get("chat.stop"),
            Some(&None)
        );

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.shortcut_overrides,
            store.settings.shortcut_overrides
        );

        let before = reloaded.settings.shortcut_overrides.clone();
        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({
                "shortcutOverrides": { "session.new": 42 }
            }))
            .is_err());
        assert_eq!(invalid.settings.shortcut_overrides, before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_and_persists_extension_decision_presentation() {
        let dir = test_dir("extension-decision-presentation");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::Auto
        );

        store
            .patch(serde_json::json!({
                "extensionDecisionPresentation": "inline-first"
            }))
            .unwrap();
        assert_eq!(
            store.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::InlineFirst
        );

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::InlineFirst
        );

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({
                "extensionDecisionPresentation": "automatic"
            }))
            .is_err());
        assert_eq!(
            invalid.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::InlineFirst
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_and_persists_busy_send_behavior() {
        let dir = test_dir("busy-send-behavior");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.busy_send_behavior,
            BusySendBehavior::FollowUp
        );

        store
            .patch(serde_json::json!({ "busySendBehavior": "steer" }))
            .unwrap();
        assert_eq!(store.settings.busy_send_behavior, BusySendBehavior::Steer);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.busy_send_behavior,
            BusySendBehavior::Steer
        );

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "busySendBehavior": "interrupt" }))
            .is_err());
        assert_eq!(invalid.settings.busy_send_behavior, BusySendBehavior::Steer);
        fs::remove_dir_all(dir).unwrap();
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
        assert_eq!(loaded.settings.theme, DesktopTheme::Dark);
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
        assert_eq!(loaded.settings.theme, DesktopTheme::Light);
        assert_eq!(loaded.settings.theme_family, DesktopThemeFamily::Pideck);
        assert!(!loaded.settings.restore_last_session);
        assert_eq!(
            loaded.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::LegacyModal
        );
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
        assert_eq!(loaded.settings.theme, DesktopTheme::System);
        assert_eq!(
            loaded.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::LegacyModal
        );
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

    #[test]
    fn initializes_and_persists_the_default_project_workspace() {
        let dir = test_dir("default-project");
        let agent_dir = dir.join("agent");
        let project_dir = agent_dir.join("pideck").join("DefaultProject");
        let project_path = project_dir.to_string_lossy().into_owned();
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store.settings.agent_dir = Some(agent_dir.to_string_lossy().into_owned());

        assert_eq!(
            store.ensure_default_project_workspace().unwrap(),
            Some(project_dir.clone())
        );
        assert!(project_dir.is_dir());
        assert_eq!(store.settings.default_workspace, None);
        assert_eq!(
            store.settings.last_workspace.as_deref(),
            Some(project_path.as_str())
        );
        assert_eq!(store.settings.known_workspaces, vec![project_path.clone()]);

        #[cfg(unix)]
        {
            let namespace_mode = fs::metadata(agent_dir.join("pideck"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let project_mode = fs::metadata(&project_dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(namespace_mode, 0o700);
            assert_eq!(project_mode, 0o700);
        }

        assert_eq!(store.ensure_default_project_workspace().unwrap(), None);
        assert_eq!(store.settings.known_workspaces, vec![project_path.clone()]);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.last_workspace.as_deref(),
            Some(project_path.as_str())
        );
        assert_eq!(reloaded.settings.known_workspaces, vec![project_path]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preserves_every_form_of_existing_workspace_configuration() {
        let cases = [
            DesktopSettings {
                default_workspace: Some("/projects/default".into()),
                ..DesktopSettings::default()
            },
            DesktopSettings {
                last_workspace: Some("/projects/recent".into()),
                ..DesktopSettings::default()
            },
            DesktopSettings {
                known_workspaces: vec!["/projects/known".into()],
                ..DesktopSettings::default()
            },
        ];

        for (index, settings) in cases.into_iter().enumerate() {
            let dir = test_dir(&format!("existing-workspace-{index}"));
            let agent_dir = dir.join("agent");
            let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
            store.settings = DesktopSettings {
                agent_dir: Some(agent_dir.to_string_lossy().into_owned()),
                ..settings
            };
            let before = serde_json::to_value(&store.settings).unwrap();

            assert_eq!(store.ensure_default_project_workspace().unwrap(), None);
            assert_eq!(serde_json::to_value(&store.settings).unwrap(), before);
            assert!(!agent_dir.join("pideck").join("DefaultProject").exists());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn loads_legacy_settings_without_extension_ui_as_v1_defaults() {
        let dir = test_dir("legacy-extension-ui");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"settings":{"theme":"light","restoreLastSession":true}}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, DesktopTheme::Light);
        assert_eq!(loaded.settings.extension_ui, ExtensionUiSettings::default());
        assert!(loaded.snapshot().warning.is_none());
        assert!(loaded.snapshot().recovered_from.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_extension_ui_version_resets_only_the_nested_field() {
        let dir = test_dir("unknown-extension-ui-version");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"settings":{"theme":"dark","extensionUi":{"version":2,"presentations":{"ext_a":{"widget":{"home":{"kind":"hidden"}}}}}}}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, DesktopTheme::Dark);
        assert_eq!(loaded.settings.extension_ui, ExtensionUiSettings::default());
        assert!(loaded.snapshot().recovered_from.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn drops_illegal_extension_ui_entries_without_quarantine() {
        let dir = test_dir("illegal-extension-ui-entry");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"settings":{"theme":"light","extensionUi":{"version":1,"presentations":{"ext_a":{"widget":{"home":{"kind":"hidden"}},"status":{"home":{"kind":"float","rect":{"x":0,"y":0,"width":1,"height":1}}}},"":{"widget":{"home":{"kind":"hidden"}}}},"dock":{"direction":"row","secondaryEnabled":false},"observedCapabilities":{"ext_a":{"families":["widget"],"lastSeenAt":10}}}}}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, DesktopTheme::Light);
        assert!(loaded.settings.extension_ui.presentations["ext_a"]
            .widget
            .is_some());
        assert!(loaded.settings.extension_ui.presentations["ext_a"]
            .status
            .is_none());
        assert!(!loaded.settings.extension_ui.presentations.contains_key(""));
        assert!(loaded.snapshot().recovered_from.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn non_object_extension_ui_on_disk_uses_defaults_without_corrupt_recovery() {
        let dir = test_dir("non-object-extension-ui");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"settings":{"theme":"dark","extensionUi":"oops"}}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, DesktopTheme::Dark);
        assert_eq!(loaded.settings.extension_ui, ExtensionUiSettings::default());
        assert!(loaded.snapshot().recovered_from.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn patches_a_complete_extension_ui_snapshot_and_rejects_non_objects() {
        let dir = test_dir("patch-extension-ui");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        let snapshot = serde_json::json!({
            "version": 1,
            "presentations": {
                "ext_review": {
                    "blockingDialog": { "home": { "kind": "inline" } }
                }
            },
            "dock": { "direction": "row", "secondaryEnabled": false },
            "observedCapabilities": {
                "ext_review": { "families": ["blockingDialog"], "lastSeenAt": 10 }
            }
        });
        store
            .patch(serde_json::json!({ "extensionUi": snapshot }))
            .unwrap();
        assert_eq!(
            store.settings.extension_ui.observed_capabilities["ext_review"].families,
            vec!["blockingDialog"]
        );

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.extension_ui.presentations["ext_review"]
                .blocking_dialog
                .as_ref()
                .map(|preference| &preference.home),
            Some(&crate::extension_ui_settings::PresentationHome::Inline)
        );

        let mut invalid = reloaded;
        let before = serde_json::to_value(&invalid.settings).unwrap();
        assert!(invalid
            .patch(serde_json::json!({ "extensionUi": "oops" }))
            .unwrap_err()
            .contains("must be an object"));
        assert_eq!(serde_json::to_value(&invalid.settings).unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }
}
