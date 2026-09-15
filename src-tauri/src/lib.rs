use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    time::UNIX_EPOCH,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileStat {
    size: u64,
    last_modified: u64,
}

#[tauri::command]
fn stat_file(path: String) -> Result<NativeFileStat, String> {
    let metadata = std::fs::metadata(&path).map_err(|error| format!("Could not access {path}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let last_modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    Ok(NativeFileStat {
        size: metadata.len(),
        last_modified,
    })
}

#[tauri::command]
fn read_file_range(path: String, offset: u64, length: usize) -> Result<tauri::ipc::Response, String> {
    const MAX_READ_BYTES: usize = 64 * 1024 * 1024;
    if length > MAX_READ_BYTES {
        return Err(format!("A single file read cannot exceed {} MB", MAX_READ_BYTES / 1024 / 1024));
    }
    let mut file = File::open(&path).map_err(|error| format!("Could not open {path}: {error}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("Could not seek in {path}: {error}"))?;
    let mut bytes = vec![0; length];
    let count = file.read(&mut bytes).map_err(|error| format!("Could not read {path}: {error}"))?;
    bytes.truncate(count);
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![stat_file, read_file_range])
        .run(tauri::generate_context!())
        .expect("error while running Locus Glide");
}
