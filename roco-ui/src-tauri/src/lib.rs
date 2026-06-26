use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewWindow, WindowEvent,
};

/// Comando de Tauri para cambiar dinámicamente el comportamiento de clics de la ventana.
/// Si `passive` es verdadero, la ventana ignorará todos los eventos del cursor (click-through).
/// Si es falso, la ventana volverá a ser interactiva.
#[tauri::command]
fn set_hud_mode(window: WebviewWindow, passive: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(passive).map_err(|e| e.to_string())
}

/// Comando para actualizar dinámicamente la lista de perfiles rápidos en el submenú de la bandeja.
#[tauri::command]
fn update_quick_profiles(app: tauri::AppHandle, profiles: Vec<String>) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let show = MenuItem::with_id(&app, "show", "Abrir Panel", true, None::<&str>).map_err(|e| e.to_string())?;
        let mic = CheckMenuItem::with_id(&app, "mic", "Activar Micrófono", true, false, None::<&str>).map_err(|e| e.to_string())?;
        
        // Crear submenú para perfiles rápidos
        let sub = Submenu::with_id(&app, "quick_profiles", "Perfil Rápido", true).map_err(|e| e.to_string())?;
        for profile in profiles {
            let item = MenuItem::with_id(&app, format!("profile_{}", profile), &profile, true, None::<&str>).map_err(|e| e.to_string())?;
            sub.append(&item).map_err(|e| e.to_string())?;
        }
        
        let exit = MenuItem::with_id(&app, "exit", "Salir", true, None::<&str>).map_err(|e| e.to_string())?;
        
        let menu = Menu::with_items(&app, &[&mic, &show, &sub, &exit]).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![set_hud_mode, update_quick_profiles])
        .setup(|app| {
            // Inicializar menú contextual nativo base
            let show = MenuItem::with_id(app, "show", "Abrir Panel", true, None::<&str>)?;
            let mic = CheckMenuItem::with_id(app, "mic", "Activar Micrófono", true, false, None::<&str>)?;
            
            // Submenú rápido inicial vacío
            let sub = Submenu::with_id(app, "quick_profiles", "Perfil Rápido", true)?;
            
            let exit = MenuItem::with_id(app, "exit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&mic, &show, &sub, &exit])?;

            // Obtener el icono predeterminado del sistema
            let icon = app.default_window_icon().cloned().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "No se encontró el icono por defecto")
            })?;

            // Construir el ícono de bandeja con ID "main"
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let id_str = event.id.as_ref();
                    if id_str.starts_with("profile_") {
                        let game_title = &id_str[8..];
                        let _ = app.emit("tray_switch_game", game_title);
                    } else {
                        match id_str {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                    let _ = window.set_ignore_cursor_events(false);
                                }
                            }
                            "exit" => {
                                app.exit(0);
                            }
                            "mic" => {
                                let _ = app.emit("tray_toggle_mic", ());
                            }
                            _ => {}
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Interceptar el evento de cierre de ventana y ocultar la ventana en su lugar
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicación tauri");
}
