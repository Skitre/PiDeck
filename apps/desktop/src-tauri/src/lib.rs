mod commands;
mod desktop_settings;
mod pi_host;
#[cfg(test)]
mod pi_host_tests;

use desktop_settings::DesktopSettingsStore;
use pi_host::PiHostManager;
use tauri::{Emitter, Listener, Manager};
use tokio::sync::Mutex;

pub struct AppState {
    pub settings: Mutex<DesktopSettingsStore>,
    pub host: Mutex<PiHostManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let settings = DesktopSettingsStore::load(app.handle())?;
            let host = PiHostManager::new(app.handle().clone(), &settings);
            app.manage(AppState {
                settings: Mutex::new(settings),
                host: Mutex::new(host),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                // start_unlocked never holds the host mutex across the ready-wait,
                // so IPC commands and app exit stay responsive during startup.
                if let Err(e) = pi_host::start_unlocked(&state.host, pi_host::StartKind::Fresh).await
                {
                    eprintln!("[pideck] failed to start host: {e}");
                    // Surface to UI as host.fatal so the banner shows the real cause
                    let _ = handle.emit(
                        "pi-host-stdout",
                        serde_json::json!({
                            "protocolVersion": 1,
                            "event": "host.fatal",
                            "sequence": 1,
                            "timestamp": 0,
                            "hostInstanceId": "00000000-0000-4000-8000-000000000001",
                            "workspaceId": null,
                            "workspaceRevision": 0,
                            "sessionId": null,
                            "sessionRevision": 0,
                            "packageRevision": 0,
                            "payload": {
                                "error": {
                                    "code": "INTERNAL_ERROR",
                                    "message": e,
                                    "retryable": true
                                }
                            }
                        })
                        .to_string(),
                    );
                }
            });

            // One-shot auto-restart after unexpected Host exit (R3)
            let handle_ar = app.handle().clone();
            app.listen("pi-host-auto-restart", move |_event| {
                let handle = handle_ar.clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    eprintln!("[pideck] auto-restarting Host once after crash");
                    if let Err(e) =
                        pi_host::start_unlocked(&state.host, pi_host::StartKind::AutoRestartAfterCrash)
                            .await
                    {
                        eprintln!("[pideck] auto-restart failed: {e}");
                        let _ = handle.emit(
                            "pi-host-stdout",
                            serde_json::json!({
                                "protocolVersion": 1,
                                "event": "host.fatal",
                                "sequence": 1,
                                "timestamp": 0,
                                "hostInstanceId": "00000000-0000-4000-8000-000000000003",
                                "workspaceId": null,
                                "workspaceRevision": 0,
                                "sessionId": null,
                                "sessionRevision": 0,
                                "packageRevision": 0,
                                "payload": {
                                    "error": {
                                        "code": "INTERNAL_ERROR",
                                        "message": format!("Auto-restart failed: {e}"),
                                        "retryable": false
                                    }
                                }
                            })
                            .to_string(),
                        );
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_settings_get,
            commands::desktop_settings_patch,
            commands::desktop_open_path,
            commands::pi_host_send,
            commands::pi_host_restart,
            commands::pi_host_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let handle = app_handle.clone();
                tauri::async_runtime::block_on(async move {
                    let state = handle.state::<AppState>();
                    let mut host = state.host.lock().await;
                    host.shutdown().await;
                });
            }
        });
}
