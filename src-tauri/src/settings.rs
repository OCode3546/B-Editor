//! Settings and recent files, stored as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Empty = auto-detect on PATH / common install locations.
    pub clang: String,
    pub rustc: String,
    pub python: String,
    /// Ghidra install directory (the one containing `support/analyzeHeadless`).
    pub ghidra_dir: String,
    /// JDK home for Ghidra. Empty = auto-detect.
    pub java_home: String,
    pub tool_timeout_secs: u64,
    pub ghidra_timeout_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            clang: String::new(),
            rustc: String::new(),
            python: String::new(),
            ghidra_dir: String::new(),
            java_home: String::new(),
            tool_timeout_secs: 60,
            ghidra_timeout_secs: 600,
        }
    }
}

const MAX_RECENT: usize = 12;

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

pub fn load(app: &AppHandle) -> Settings {
    config_file(app, "settings.json")
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(config_file(&app, "settings.json")?, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent(app: AppHandle) -> Vec<String> {
    config_file(&app, "recent.json")
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists())
        .collect()
}

#[tauri::command]
pub fn add_recent(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut list = get_recent(app.clone());
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(MAX_RECENT);
    let json = serde_json::to_vec(&list).map_err(|e| e.to_string())?;
    std::fs::write(config_file(&app, "recent.json")?, json).map_err(|e| e.to_string())?;
    Ok(list)
}
