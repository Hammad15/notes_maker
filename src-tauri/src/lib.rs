use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri_plugin_dialog::DialogExt;

fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
            format!("{home}\\AppData\\Local")
        });
        return PathBuf::from(base).join("Study Notes");
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Study Notes");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            format!("{home}/.local/share")
        });
        PathBuf::from(base).join("Study Notes")
    }
}

fn user_home() -> String {
    #[cfg(target_os = "windows")]
    {
        return std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    }
}

fn roots() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let mut found = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                found.push(root);
            }
        }
        if found.is_empty() {
            found.push("C:\\".into());
        }
        return found;
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["/".into()]
    }
}

fn io_message(path: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("That folder is not there: {path}")
    } else {
        error.to_string()
    }
}

fn require_str<'a>(request: &'a Value, key: &str) -> Result<&'a str, String> {
    request
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Missing {key}."))
}

fn read_text(path: &str) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Value::String(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(io_message(path, &error)),
    }
}

fn write_text(path: &str, text: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|error| io_message(path, &error))?;
    }
    fs::write(path, text).map_err(|error| io_message(path, &error))
}

fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|error| io_message(path, &error))?;
    }
    fs::write(path, bytes).map_err(|error| io_message(path, &error))
}

fn list_dir(path: &str) -> Result<Value, String> {
    let entries = fs::read_dir(path).map_err(|error| io_message(path, &error))?;
    let mut listed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = match fs::metadata(entry.path()) {
            Ok(meta) if meta.is_dir() => "dir",
            _ => "file",
        };
        listed.push(json!({ "name": name, "kind": kind }));
    }
    Ok(Value::Array(listed))
}

fn stat_path(path: &str) -> Result<Value, String> {
    match fs::metadata(path) {
        Ok(meta) => {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            Ok(json!({
                "size": meta.len(),
                "isDir": meta.is_dir(),
                "modifiedMs": modified_ms,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(io_message(path, &error)),
    }
}

fn set_hidden(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("attrib")
            .args(["+H", path])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Could not mark the study folder hidden.".into());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

fn probe_media(path: &str) -> Result<Value, String> {
    let meta = fs::metadata(path).map_err(|error| io_message(path, &error))?;
    if meta.is_dir() {
        return Err("That recording is not there anymore.".into());
    }
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_chapters",
            path,
        ])
        .output();
    let Ok(output) = output else {
        return Ok(json!({
            "size": meta.len(),
            "durationSeconds": null,
            "title": null,
            "chapters": [],
        }));
    };
    if !output.status.success() {
        return Ok(json!({
            "size": meta.len(),
            "durationSeconds": null,
            "title": null,
            "chapters": [],
        }));
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    let duration = parsed
        .pointer("/format/duration")
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<f64>().ok());
    let title = parsed
        .pointer("/format/tags/title")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut chapters = Vec::new();
    if let Some(items) = parsed.get("chapters").and_then(Value::as_array) {
        for chapter in items {
            let start = chapter
                .get("start_time")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<f64>().ok());
            let end = chapter
                .get("end_time")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<f64>().ok());
            if let (Some(start), Some(end)) = (start, end) {
                let title = chapter
                    .pointer("/tags/title")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                chapters.push(json!({ "start": start, "end": end, "title": title }));
            }
        }
    }
    Ok(json!({
        "size": meta.len(),
        "durationSeconds": duration,
        "title": title,
        "chapters": chapters,
    }))
}

fn file_path_string(file: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    file.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "That choice is not a file on this computer.".to_string())
}

#[tauri::command]
fn desktop_call(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    let op = require_str(&request, "op")?;
    match op {
        "appDataDir" => Ok(json!(app_data_dir().to_string_lossy())),
        "userHome" => Ok(json!(user_home())),
        "roots" => Ok(json!(roots())),
        "readText" => read_text(require_str(&request, "path")?),
        "writeText" => {
            write_text(require_str(&request, "path")?, request.get("text").and_then(Value::as_str).unwrap_or(""))?;
            Ok(Value::Null)
        }
        "writeBytes" => {
            let encoded = require_str(&request, "base64")?;
            let bytes = STANDARD.decode(encoded).map_err(|error| error.to_string())?;
            write_bytes(require_str(&request, "path")?, &bytes)?;
            Ok(Value::Null)
        }
        "exists" => Ok(json!(Path::new(require_str(&request, "path")?).exists())),
        "list" => list_dir(require_str(&request, "path")?),
        "mkdir" => {
            fs::create_dir_all(require_str(&request, "path")?).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "rename" => {
            fs::rename(require_str(&request, "from")?, require_str(&request, "to")?)
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "remove" => {
            let path = require_str(&request, "path")?;
            match fs::metadata(path) {
                Ok(meta) if meta.is_dir() => return Err("Refusing to remove a folder.".into()),
                Ok(_) => fs::remove_file(path).map_err(|error| error.to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            Ok(Value::Null)
        }
        "stat" => stat_path(require_str(&request, "path")?),
        "setHidden" => {
            set_hidden(require_str(&request, "path")?)?;
            Ok(Value::Null)
        }
        "probeMedia" => probe_media(require_str(&request, "path")?),
        "pickDirectory" => {
            let picked = app
                .dialog()
                .file()
                .set_title("Choose a folder")
                .blocking_pick_folder();
            match picked {
                Some(file) => Ok(Value::String(file_path_string(file)?)),
                None => Ok(Value::Null),
            }
        }
        "pickMedia" => {
            let mut dialog = app
                .dialog()
                .file()
                .set_title("Choose video or audio")
                .add_filter(
                    "Video or audio",
                    &[
                        "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "mp3", "wav",
                        "m4a", "aac", "flac", "ogg", "opus", "wma", "aif", "aiff",
                    ],
                );
            if let Some(directory) = request.get("directory").and_then(Value::as_str) {
                if !directory.is_empty() && Path::new(directory).is_dir() {
                    dialog = dialog.set_directory(directory);
                }
            }
            match dialog.blocking_pick_file() {
                Some(file) => Ok(Value::String(file_path_string(file)?)),
                None => Ok(Value::Null),
            }
        }
        other => Err(format!("Unknown request {other}.")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop_call])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
