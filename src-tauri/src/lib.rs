use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};
use tauri::ipc::Channel;
use tauri::Manager;

mod bedgraph_cache;
mod contact_matrix;

const LEGACY_APP_IDENTIFIER: &str = "org.stengelraskin.locusglide";
const APP_IDENTIFIER: &str = "org.arielraskin.gerafe";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileStat {
    size: u64,
    last_modified: u64,
    needs_hydration: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntrySummary {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent: Option<String>,
    drives: Vec<String>,
    entries: Vec<DirectoryEntrySummary>,
}

#[cfg(windows)]
fn logical_drives() -> Vec<String> {
    let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    (0..26)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| format!("{}:\\", (b'A' + bit as u8) as char))
        .collect()
}

#[cfg(not(windows))]
fn logical_drives() -> Vec<String> {
    vec!["/".to_string()]
}

fn directory_listing(path: Option<String>) -> Result<DirectoryListing, String> {
    let folder = path.map(std::path::PathBuf::from).or_else(|| {
        [dirs::document_dir(), dirs::home_dir(), std::env::current_dir().ok()]
            .into_iter().flatten().find(|candidate| candidate.is_dir())
    })
        .ok_or_else(|| "Could not find a starting folder.".to_string())?;
    let path_string = folder.to_string_lossy().to_string();
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(&folder).map_err(|error| format!("Could not open {path_string}: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not list {path_string}: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {path_string}: {error}"))?;
        entries.push(DirectoryEntrySummary {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirectoryListing {
        path: path_string,
        parent: folder
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        drives: logical_drives(),
        entries,
    })
}

#[tauri::command]
async fn list_directory(path: Option<String>) -> Result<DirectoryListing, String> {
    tokio::task::spawn_blocking(move || directory_listing(path))
        .await
        .map_err(|error| format!("Could not list folder: {error}"))?
}

#[cfg(windows)]
fn needs_hydration(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // Offline and recall-on-data-access indicate that a cloud provider has not
    // made all file bytes available locally. Recall-on-open is only reported by
    // directory enumeration and is not useful for this metadata call.
    metadata.file_attributes() & (0x0000_1000 | 0x0040_0000) != 0
}

#[cfg(not(windows))]
fn needs_hydration(_metadata: &fs::Metadata) -> bool {
    false
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
        needs_hydration: needs_hydration(&metadata),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHydrationProgress {
    bytes_read: u64,
    total_bytes: u64,
}

fn read_file_for_hydration(
    path: &str,
    mut progress: impl FnMut(FileHydrationProgress),
) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("Could not open {path}: {error}"))?;
    let total_bytes = file
        .metadata()
        .map_err(|error| format!("Could not inspect {path}: {error}"))?
        .len();
    let mut bytes_read = 0u64;
    let mut buffer = vec![0; 2 * 1024 * 1024];
    progress(FileHydrationProgress {
        bytes_read,
        total_bytes,
    });
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not download {path}: {error}"))?;
        if count == 0 {
            break;
        }
        bytes_read += count as u64;
        progress(FileHydrationProgress {
            bytes_read,
            total_bytes,
        });
    }
    if bytes_read != total_bytes {
        return Err(format!(
            "{path} changed size while being downloaded; please reopen it."
        ));
    }
    Ok(())
}

#[tauri::command]
async fn hydrate_file(
    path: String,
    on_progress: Channel<FileHydrationProgress>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        read_file_for_hydration(&path, |progress| {
            let _ = on_progress.send(progress);
        })
    })
    .await
    .map_err(|error| format!("Could not finish cloud download: {error}"))?
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

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    const MAX_WORKSPACE_BYTES: u64 = 16 * 1024 * 1024;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not access {path}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if metadata.len() > MAX_WORKSPACE_BYTES {
        return Err("Workspace files cannot exceed 16 MB".to_string());
    }
    fs::read_to_string(&path).map_err(|error| format!("Could not read {path}: {error}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|error| format!("Could not save {path}: {error}"))
}

fn cursor_dimension(value: u8) -> u16 {
    if value == 0 {
        256
    } else {
        value as u16
    }
}

fn extract_cursor_frame(bytes: &[u8], requested_size: u16) -> Result<Vec<u8>, String> {
    if bytes.len() < 6 || u16::from_le_bytes([bytes[2], bytes[3]]) != 2 {
        return Err("Windows cursor data has an invalid header".to_string());
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let directory_end = 6usize
        .checked_add(count.saturating_mul(16))
        .ok_or_else(|| "Windows cursor directory is too large".to_string())?;
    if bytes.len() < directory_end {
        return Err("Windows cursor directory is truncated".to_string());
    }

    let (_, entry_start) = (0..count)
        .filter_map(|index| {
            let start = 6 + index * 16;
            let width = cursor_dimension(bytes[start]);
            let height = cursor_dimension(bytes[start + 1]);
            (width == height).then_some((width.abs_diff(requested_size), start))
        })
        .min_by_key(|(distance, _)| *distance)
        .ok_or_else(|| "Windows cursor does not contain a square image".to_string())?;
    let data_size = u32::from_le_bytes(
        bytes[entry_start + 8..entry_start + 12]
            .try_into()
            .map_err(|_| "Windows cursor image size is invalid")?,
    ) as usize;
    let data_offset = u32::from_le_bytes(
        bytes[entry_start + 12..entry_start + 16]
            .try_into()
            .map_err(|_| "Windows cursor image offset is invalid")?,
    ) as usize;
    let data_end = data_offset
        .checked_add(data_size)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "Windows cursor image is truncated".to_string())?;

    let mut result = Vec::with_capacity(22 + data_size);
    result.extend_from_slice(&bytes[..4]);
    result.extend_from_slice(&1u16.to_le_bytes());
    result.extend_from_slice(&bytes[entry_start..entry_start + 12]);
    result.extend_from_slice(&22u32.to_le_bytes());
    result.extend_from_slice(&bytes[data_offset..data_end]);
    Ok(result)
}

#[cfg(windows)]
fn windows_registry_dword(subkey: &str, name: &str) -> Option<u32> {
    use std::{ffi::c_void, iter, ptr};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    let subkey: Vec<u16> = subkey.encode_utf16().chain(iter::once(0)).collect();
    let name: Vec<u16> = name.encode_utf16().chain(iter::once(0)).collect();
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&mut value as *mut u32).cast::<c_void>(),
            &mut size,
        )
    };
    (status == 0 && size == std::mem::size_of::<u32>() as u32).then_some(value)
}

#[tauri::command]
fn windows_cursor_asset(kind: String) -> Result<tauri::ipc::Response, String> {
    #[cfg(windows)]
    {
        let file_name = match kind.as_str() {
            "action" => "aero_link.cur",
            "resize-x" => "aero_ew.cur",
            "resize-y" => "aero_ns.cur",
            _ => return Err(format!("Unknown Windows cursor asset: {kind}")),
        };
        let windows_directory = std::env::var_os("WINDIR")
            .ok_or_else(|| "Windows did not provide its installation directory".to_string())?;
        let path = Path::new(&windows_directory)
            .join("Cursors")
            .join(file_name);
        let bytes = fs::read(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let cursor_size = windows_registry_dword("Control Panel\\Cursors", "CursorBaseSize")
            .unwrap_or(32)
            .clamp(32, 128) as u16;
        return Ok(tauri::ipc::Response::new(extract_cursor_frame(
            &bytes,
            cursor_size,
        )?));
    }

    #[cfg(not(windows))]
    {
        let _ = kind;
        Err("Windows cursor assets are only available on Windows".to_string())
    }
}

#[tauri::command]
fn windows_text_scale_percent() -> u32 {
    #[cfg(windows)]
    {
        return windows_registry_dword("Software\\Microsoft\\Accessibility", "TextScaleFactor")
            .unwrap_or(100)
            .clamp(100, 225);
    }

    #[cfg(not(windows))]
    100
}

#[tauri::command]
async fn prepare_bedgraph_cache(
    path: String,
    chromosome_sizes: Option<HashMap<String, u32>>,
) -> Result<bedgraph_cache::PreparedBedGraphCache, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bedgraph_cache::prepare(Path::new(&path), APP_IDENTIFIER, chromosome_sizes)
    })
    .await
    .map_err(|error| format!("The bedGraph indexer stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn contact_matrix_metadata(
    path: String,
    format: String,
) -> Result<contact_matrix::MatrixMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        contact_matrix::metadata(Path::new(&path), &format)
    })
    .await
    .map_err(|error| format!("The contact-matrix reader stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn query_contact_matrix(
    options: contact_matrix::MatrixQuery,
) -> Result<contact_matrix::MatrixQueryResult, String> {
    tauri::async_runtime::spawn_blocking(move || contact_matrix::query(options))
        .await
        .map_err(|error| format!("The contact-matrix reader stopped unexpectedly: {error}"))?
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

#[cfg(windows)]
fn set_windows_app_user_model_id() -> Result<(), Box<dyn std::error::Error>> {
    use std::iter;
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let app_id: Vec<u16> = APP_IDENTIFIER.encode_utf16().chain(iter::once(0)).collect();
    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
    if result < 0 {
        return Err(std::io::Error::other(format!(
            "could not set GeRAFE's Windows AppUserModelID (HRESULT {result:#010x})"
        ))
        .into());
    }
    Ok(())
}

#[cfg(windows)]
fn set_windows_taskbar_icon(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::{
            Shell::ExtractIconExW,
            WindowsAndMessaging::{SendMessageW, ICON_BIG, WM_SETICON},
        },
    };

    let window = app.get_webview_window("main").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "main GeRAFE window not found")
    })?;
    let executable = std::env::current_exe()?;
    let executable_wide: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let mut large_icon = ptr::null_mut();
    let extracted = unsafe {
        ExtractIconExW(
            executable_wide.as_ptr(),
            0,
            &mut large_icon,
            ptr::null_mut(),
            1,
        )
    };
    if extracted == 0 || large_icon.is_null() {
        return Err(std::io::Error::other("could not extract GeRAFE's embedded icon").into());
    }

    let hwnd = window.hwnd()?.0 as HWND;
    unsafe {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, large_icon as isize);
    }
    // The window uses this handle for its lifetime; Windows reclaims it when the process exits.
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    set_windows_app_user_model_id()
        .expect("could not establish GeRAFE's Windows application identity");

    if let Err(error) = migrate_legacy_app_data() {
        eprintln!("Could not migrate Locus Glide application data to GeRAFE: {error}");
    }
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            set_windows_taskbar_icon(app)?;
            app.get_webview_window("main")
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "main GeRAFE window not found",
                    )
                })?
                .show()?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            stat_file,
            list_directory,
            hydrate_file,
            read_file_range,
            read_text_file,
            write_text_file,
            windows_cursor_asset,
            windows_text_scale_percent,
            prepare_bedgraph_cache,
            contact_matrix_metadata,
            query_contact_matrix
        ])
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

    #[cfg(windows)]
    #[test]
    fn exposes_only_known_windows_cursor_assets() {
        assert!(windows_cursor_asset("action".to_string()).is_ok());
        assert!(windows_cursor_asset("resize-x".to_string()).is_ok());
        assert!(windows_cursor_asset("resize-y".to_string()).is_ok());
        assert!(windows_cursor_asset("arrow".to_string()).is_err());
        assert!((100..=225).contains(&windows_text_scale_percent()));
    }

    #[test]
    fn extracts_one_requested_cursor_frame() {
        let image = [7u8, 8, 9, 10];
        let mut source = vec![0, 0, 2, 0, 1, 0, 32, 32, 0, 0, 6, 0, 0, 0];
        source.extend_from_slice(&(image.len() as u32).to_le_bytes());
        source.extend_from_slice(&22u32.to_le_bytes());
        source.extend_from_slice(&image);

        let extracted = extract_cursor_frame(&source, 32).unwrap();
        assert_eq!(&extracted[..6], &[0, 0, 2, 0, 1, 0]);
        assert_eq!(cursor_dimension(extracted[6]), 32);
        assert_eq!(cursor_dimension(extracted[7]), 32);
        assert_eq!(&extracted[22..], &image);
    }

    #[test]
    fn hydration_reports_monotonic_bytes_and_rejects_missing_files() {
        use std::time::SystemTime;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("gerafe-hydration-{}-{unique}", std::process::id()));
        fs::write(&path, vec![7u8; 2 * 1024 * 1024 + 17]).unwrap();
        assert!(
            !stat_file(path.to_str().unwrap().to_string())
                .unwrap()
                .needs_hydration
        );
        let mut updates = Vec::new();
        read_file_for_hydration(path.to_str().unwrap(), |progress| updates.push(progress)).unwrap();
        assert_eq!(updates.first().unwrap().bytes_read, 0);
        assert_eq!(updates.last().unwrap().bytes_read, 2 * 1024 * 1024 + 17);
        assert!(updates
            .windows(2)
            .all(|pair| pair[0].bytes_read < pair[1].bytes_read));
        assert!(updates
            .iter()
            .all(|progress| progress.total_bytes == 2 * 1024 * 1024 + 17));
        fs::remove_file(&path).unwrap();
        assert!(read_file_for_hydration(path.to_str().unwrap(), |_| {}).is_err());
    }

    #[test]
    fn directory_browser_lists_names_without_opening_file_data() {
        use std::time::SystemTime;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gerafe-browser-{}-{unique}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("signal.bw"), b"not actually a bigwig").unwrap();
        let listing = directory_listing(Some(root.to_string_lossy().to_string())).unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert_eq!(listing.entries[0].name, "folder");
        assert!(listing.entries[0].is_directory);
        assert_eq!(listing.entries[1].name, "signal.bw");
        assert!(!listing.entries[1].is_directory);
        assert!(listing.parent.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
