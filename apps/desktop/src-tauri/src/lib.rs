mod browser_surface;
mod commands;
mod desktop_settings;
mod draft_store;
mod extension_ui_settings;
mod pi_host;
#[cfg(test)]
mod pi_host_tests;
mod shell_terminal;
mod system_tray;

use desktop_settings::DesktopSettingsStore;
use draft_store::DraftStore;
use pi_host::PiHostManager;
use shell_terminal::ShellTerminalManager;
use tauri::{Emitter, Listener, Manager};
use tokio::sync::Mutex;

pub struct AppState {
    pub settings: Mutex<DesktopSettingsStore>,
    pub drafts: Mutex<DraftStore>,
    pub host: Mutex<PiHostManager>,
    pub terminals: Mutex<ShellTerminalManager>,
    pub browsers: Mutex<BrowserSurfaceManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            system_tray::install(app)?;

            let mut settings = DesktopSettingsStore::load(app.handle())?;
            settings.ensure_default_project_workspace()?;
            let drafts = DraftStore::load(app.handle());
            let host = PiHostManager::new(app.handle().clone(), &settings);
            app.manage(AppState {
                settings: Mutex::new(settings),
                drafts: Mutex::new(drafts),
                host: Mutex::new(host),
                terminals: Mutex::new(ShellTerminalManager::new()),
                browsers: Mutex::new(BrowserSurfaceManager::new()),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                // start_unlocked never holds the host mutex across the ready-wait,
                // so IPC commands and app exit stay responsive during startup.
                if let Err(e) =
                    pi_host::start_unlocked(&state.host, pi_host::StartKind::Fresh).await
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
                    if let Err(e) = pi_host::start_unlocked(
                        &state.host,
                        pi_host::StartKind::AutoRestartAfterCrash,
                    )
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
            commands::desktop_drafts_get,
            commands::desktop_drafts_apply,
            commands::desktop_open_path,
            commands::desktop_read_small_file,
            commands::pi_host_send,
            commands::pi_host_restart,
            commands::pi_host_status,
            commands::shell_terminal_create,
            commands::shell_terminal_profiles,
            commands::shell_terminal_write,
            commands::shell_terminal_resize,
            commands::shell_terminal_close,
            commands::browser_surface_create,
            commands::browser_surface_navigate,
            commands::browser_surface_control,
            commands::browser_surface_set_bounds,
            commands::browser_surface_set_visible,
            commands::browser_surface_focus,
            commands::browser_surface_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if system_tray::should_hide_on_close(&label) => {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
            tauri::RunEvent::Exit => {
                system_tray::remove(app_handle);
                let handle = app_handle.clone();
                tauri::async_runtime::block_on(async move {
                    let state = handle.state::<AppState>();
                    let mut browsers = state.browsers.lock().await;
                    browsers.shutdown_all();
                    drop(browsers);
                    let mut terminals = state.terminals.lock().await;
                    terminals.shutdown_all();
                    drop(terminals);
                    let mut host = state.host.lock().await;
                    host.shutdown_for_app_exit().await;
                });
            }
            _ => {}
        });
}
use browser_surface::BrowserSurfaceManager;
