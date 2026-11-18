mod bundle;
mod exe;
mod files;
mod settings;
mod tools;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            files::read_file,
            files::write_file,
            settings::get_settings,
            settings::save_settings,
            settings::get_recent,
            settings::add_recent,
            exe::parse_executable,
            tools::detect_tools,
            tools::compile_source,
            tools::python_bytecode,
            tools::python_dis_pyc,
            tools::ghidra_decompile,
            tools::ghidra_decompile_file,
            bundle::inspect_bundle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Binary Editor");
}
