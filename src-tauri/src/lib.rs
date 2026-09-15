use serde::Serialize;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

const LEGACY_APP_IDENTIFIER: &str = "org.stengelraskin.locusglide";
const APP_IDENTIFIER: &str = "org.arielraskin.gerafe";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileStat {
    size: u64,
    last_modified: u64,
}

#[tauri::command]
fn stat_file(path: String) -> Result<NativeFileStat, String> {
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("Could not access {path}: {error}"))?;
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
fn read_file_range(
    path: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    const MAX_READ_BYTES: usize = 64 * 1024 * 1024;
    if length > MAX_READ_BYTES {
        return Err(format!(
            "A single file read cannot exceed {} MB",
            MAX_READ_BYTES / 1024 / 1024
        ));
    }
    let mut file = File::open(&path).map_err(|error| format!("Could not open {path}: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not seek in {path}: {error}"))?;
    let mut bytes = vec![0; length];
    let count = file
        .read(&mut bytes)
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    bytes.truncate(count);
    Ok(tauri::ipc::Response::new(bytes))
}

fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn migrate_legacy_app_data_at(local_data: &Path) -> std::io::Result<bool> {
    let source = local_data.join(LEGACY_APP_IDENTIFIER);
    let destination = local_data.join(APP_IDENTIFIER);
    if !source.is_dir() || destination.exists() {
        return Ok(false);
    }
    copy_directory(&source, &destination)?;
    Ok(true)
}

fn migrate_legacy_app_data() -> std::io::Result<bool> {
    let Some(local_data) = dirs::data_local_dir() else {
        return Ok(false);
    };
    migrate_legacy_app_data_at(&local_data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = migrate_legacy_app_data() {
        eprintln!("Could not migrate Locus Glide application data to GeRAFE: {error}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![stat_file, read_file_range])
        .run(tauri::generate_context!())
        .expect("error while running GeRAFE");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn copies_legacy_profile_without_removing_it() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gerafe-migration-{}-{unique}", std::process::id()));
        let legacy_storage = root
            .join(LEGACY_APP_IDENTIFIER)
            .join("EBWebView/Default/Local Storage");
        fs::create_dir_all(&legacy_storage).unwrap();
        fs::write(legacy_storage.join("state.test"), b"persisted tracks").unwrap();

        assert!(migrate_legacy_app_data_at(&root).unwrap());
        assert_eq!(
            fs::read(
                root.join(APP_IDENTIFIER)
                    .join("EBWebView/Default/Local Storage/state.test")
            )
            .unwrap(),
            b"persisted tracks"
        );
        assert!(root
            .join(LEGACY_APP_IDENTIFIER)
            .join("EBWebView/Default/Local Storage/state.test")
            .exists());
        assert!(!migrate_legacy_app_data_at(&root).unwrap());

        fs::remove_dir_all(root).unwrap();
    }
}
