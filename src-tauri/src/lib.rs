use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Read;
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

fn read_prefix(path: &str, limit: usize) -> Vec<u8> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let mut buf = vec![0u8; limit];
    let read = file.read(&mut buf).unwrap_or(0);
    buf.truncate(read);
    buf
}

fn u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn plausible_duration(seconds: f64) -> Option<f64> {
    if seconds.is_finite() && seconds > 0.0 && seconds <= 48.0 * 60.0 * 60.0 {
        Some(seconds)
    } else {
        None
    }
}

fn wav_duration(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    let mut sample_rate = 0u32;
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut data_size: Option<u32> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32_le(bytes, offset + 4)? as usize;
        let start = offset + 8;
        if id == b"fmt " && size >= 16 && start + 16 <= bytes.len() {
            channels = u16_le(bytes, start + 2).unwrap_or(0);
            sample_rate = u32_le(bytes, start + 4).unwrap_or(0);
            bits = u16_le(bytes, start + 14).unwrap_or(0);
        } else if id == b"data" {
            data_size = Some(size as u32);
            break;
        }
        offset = start + size + (size % 2);
    }
    let data_size = data_size?;
    if sample_rate == 0 || channels == 0 || bits == 0 {
        return None;
    }
    let bytes_per_second = f64::from(sample_rate) * f64::from(channels) * (f64::from(bits) / 8.0);
    if bytes_per_second == 0.0 {
        return None;
    }
    plausible_duration(f64::from(data_size) / bytes_per_second)
}

fn bitrate_kbps(version: u8, layer: u8, index: usize) -> u32 {
    const MPEG1_L1: [u32; 16] = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
    const MPEG1_L2: [u32; 16] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
    const MPEG1_L3: [u32; 16] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const MPEG2_L1: [u32; 16] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
    const MPEG2_L3: [u32; 16] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    let table: &[u32; 16] = if version == 3 {
        if layer == 3 {
            &MPEG1_L1
        } else if layer == 2 {
            &MPEG1_L2
        } else {
            &MPEG1_L3
        }
    } else if layer == 3 {
        &MPEG2_L1
    } else {
        &MPEG2_L3
    };
    table.get(index).copied().unwrap_or(0)
}

struct FrameInfo {
    offset: usize,
    bitrate: u32,
    sample_rate: u32,
    samples_per_frame: u32,
    xing_offset: usize,
}

fn frame_at(bytes: &[u8], offset: usize) -> Option<FrameInfo> {
    if offset + 4 > bytes.len() || bytes[offset] != 0xff || bytes[offset + 1] & 0xe0 != 0xe0 {
        return None;
    }
    let version = (bytes[offset + 1] >> 3) & 0x3;
    let layer = (bytes[offset + 1] >> 1) & 0x3;
    let bitrate_index = ((bytes[offset + 2] >> 4) & 0xf) as usize;
    let sample_index = (bytes[offset + 2] >> 2) & 0x3;
    if version == 1 || layer == 0 || bitrate_index == 0 || bitrate_index == 15 || sample_index == 3 {
        return None;
    }
    let mpeg1 = version == 3;
    let sample_rate = if mpeg1 {
        [44100, 48000, 32000][sample_index as usize]
    } else if version == 2 {
        [22050, 24000, 16000][sample_index as usize]
    } else {
        [11025, 12000, 8000][sample_index as usize]
    };
    let bitrate = bitrate_kbps(version, layer, bitrate_index) * 1000;
    if sample_rate == 0 || bitrate == 0 {
        return None;
    }
    let mono = ((bytes[offset + 3] >> 6) & 0x3) == 3;
    let samples_per_frame = if layer == 3 {
        384
    } else if layer == 1 && !mpeg1 {
        576
    } else {
        1152
    };
    let side_info = if layer == 1 {
        if mpeg1 {
            if mono { 17 } else { 32 }
        } else if mono {
            9
        } else {
            17
        }
    } else {
        0
    };
    Some(FrameInfo {
        offset,
        bitrate,
        sample_rate,
        samples_per_frame,
        xing_offset: 4 + side_info,
    })
}

fn mp3_duration(bytes: &[u8], file_size: u64) -> Option<f64> {
    let mut start = 0usize;
    if bytes.len() >= 10 && &bytes[0..3] == b"ID3" {
        let size = ((bytes[6] as usize & 0x7f) << 21)
            | ((bytes[7] as usize & 0x7f) << 14)
            | ((bytes[8] as usize & 0x7f) << 7)
            | (bytes[9] as usize & 0x7f);
        start = 10 + size + if bytes[5] & 0x10 != 0 { 10 } else { 0 };
    }
    let limit = bytes.len().saturating_sub(4).min(start.saturating_add(65536));
    let mut frame = None;
    let mut offset = start;
    while offset <= limit {
        if let Some(found) = frame_at(bytes, offset) {
            frame = Some(found);
            break;
        }
        offset += 1;
    }
    let frame = frame?;
    let mark = frame.offset + frame.xing_offset;
    if mark + 12 <= bytes.len() {
        let tag = &bytes[mark..mark + 4];
        if tag == b"Xing" || tag == b"Info" {
            let flags = u32_be(bytes, mark + 4).unwrap_or(0);
            if flags & 0x1 != 0 {
                if let Some(frames) = u32_be(bytes, mark + 8) {
                    if frames > 0 {
                        return plausible_duration(
                            f64::from(frames) * f64::from(frame.samples_per_frame)
                                / f64::from(frame.sample_rate),
                        );
                    }
                }
            }
        }
    }
    let audio_bytes = file_size.saturating_sub(frame.offset as u64);
    if audio_bytes == 0 {
        return None;
    }
    plausible_duration((audio_bytes as f64) * 8.0 / f64::from(frame.bitrate))
}

fn duration_from_header(bytes: &[u8], file_size: u64) -> Option<f64> {
    if let Some(duration) = wav_duration(bytes) {
        return Some(duration);
    }
    let looks_like_mp3 = bytes.len() >= 3 && &bytes[0..3] == b"ID3" || frame_at(bytes, 0).is_some();
    if looks_like_mp3 {
        return mp3_duration(bytes, file_size);
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_media_duration(path: &str) -> Option<f64> {
    use std::os::windows::process::CommandExt;
    let parent = Path::new(path).parent()?.to_string_lossy().replace('\'', "''");
    let name = Path::new(path).file_name()?.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$dir = '{parent}'; $name = '{name}'; $shell = New-Object -ComObject Shell.Application; $folder = $shell.NameSpace($dir); if ($null -eq $folder) {{ exit 2 }}; $item = $folder.ParseName($name); if ($null -eq $item) {{ exit 3 }}; $d = $item.ExtendedProperty('System.Media.Duration'); if ($null -eq $d) {{ exit 4 }}; Write-Output $d"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let raw: f64 = text.trim().parse().ok()?;
    if raw <= 0.0 {
        return None;
    }
    Some(raw / 10_000_000.0)
}

#[cfg(not(target_os = "windows"))]
fn windows_media_duration(path: &str) -> Option<f64> {
    let _ = path;
    None
}

fn probe_media(path: &str) -> Result<Value, String> {
    let meta = fs::metadata(path).map_err(|error| io_message(path, &error))?;
    if meta.is_dir() {
        return Err("That recording is not there anymore.".into());
    }
    let mut duration: Option<f64> = None;
    let mut title: Option<String> = None;
    let mut chapters = Vec::new();
    if let Ok(output) = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_chapters",
            path,
        ])
        .output()
    {
        if output.status.success() {
            let parsed: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
            duration = parsed
                .pointer("/format/duration")
                .and_then(|value| value.as_str())
                .and_then(|value| value.parse::<f64>().ok());
            title = parsed
                .pointer("/format/tags/title")
                .and_then(Value::as_str)
                .map(str::to_string);
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
                        let chapter_title = chapter
                            .pointer("/tags/title")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        chapters.push(json!({ "start": start, "end": end, "title": chapter_title }));
                    }
                }
            }
        }
    }
    if duration.is_none() {
        let prefix = read_prefix(path, 256 * 1024);
        duration = duration_from_header(&prefix, meta.len());
    }
    if duration.is_none() {
        duration = windows_media_duration(path);
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

#[cfg(test)]
mod duration_tests {
    use super::duration_from_header;
    use serde_json::json;

    fn wav(seconds: u32) -> Vec<u8> {
        let sample_rate = 8000u32;
        let data_size = sample_rate * seconds * 2;
        let mut bytes = vec![0u8; 44 + data_size as usize];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&(36 + data_size).to_le_bytes());
        bytes[8..16].copy_from_slice(b"WAVEfmt ");
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&sample_rate.to_le_bytes());
        bytes[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes());
        bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
        bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&data_size.to_le_bytes());
        bytes
    }

    fn xing(mono: bool, frames: u32) -> Vec<u8> {
        let side = if mono { 17 } else { 32 };
        let mut bytes = vec![0u8; 4 + side + 12];
        bytes[0] = 0xff;
        bytes[1] = 0xfb;
        bytes[2] = 0x90;
        bytes[3] = if mono { 0xc0 } else { 0 };
        let mark = 4 + side;
        bytes[mark..mark + 4].copy_from_slice(b"Xing");
        bytes[mark + 7] = 1;
        bytes[mark + 8..mark + 12].copy_from_slice(&frames.to_be_bytes());
        bytes
    }

    #[test]
    fn optional_duration_json_is_a_number_or_null() {
        let missing: Option<f64> = None;
        let empty = json!({ "durationSeconds": missing });
        assert!(empty.get("durationSeconds").unwrap().is_null());
        let present = Some(57.0 * 60.0);
        let value = json!({ "durationSeconds": present });
        assert_eq!(value["durationSeconds"], 3420.0);
    }

    #[test]
    fn wav_two_seconds() {
        let bytes = wav(2);
        let duration = duration_from_header(&bytes, bytes.len() as u64).unwrap();
        assert!((duration - 2.0).abs() < 0.001);
    }

    #[test]
    fn mp3_xing_frames() {
        let frames = 1152u32;
        let expected = f64::from(frames) * 1152.0 / 44100.0;
        for mono in [true, false] {
            let bytes = xing(mono, frames);
            let duration = duration_from_header(&bytes, 999_999).unwrap();
            assert!((duration - expected).abs() < 0.001, "{duration} vs {expected}");
        }
    }
}
