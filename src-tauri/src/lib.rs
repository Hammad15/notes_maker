use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

mod local_runtime;

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
    const MPEG1_L1: [u32; 16] = [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
    ];
    const MPEG1_L2: [u32; 16] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
    ];
    const MPEG1_L3: [u32; 16] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ];
    const MPEG2_L1: [u32; 16] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
    ];
    const MPEG2_L3: [u32; 16] = [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ];
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
    if version == 1 || layer == 0 || bitrate_index == 0 || bitrate_index == 15 || sample_index == 3
    {
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
            if mono {
                17
            } else {
                32
            }
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
    let limit = bytes
        .len()
        .saturating_sub(4)
        .min(start.saturating_add(65536));
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
    let parent = Path::new(path)
        .parent()?
        .to_string_lossy()
        .replace('\'', "''");
    let name = Path::new(path)
        .file_name()?
        .to_string_lossy()
        .replace('\'', "''");
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
    if let Some(ffprobe) = local_runtime::tool_path(&app_data_dir(), "ffprobe") {
        let mut command = Command::new(ffprobe);
        local_runtime::quiet(&mut command);
        if let Ok(output) = command
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
                            chapters.push(
                                json!({ "start": start, "end": end, "title": chapter_title }),
                            );
                        }
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

fn optional_string(request: &Value, key: &str) -> Option<String> {
    request
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn emit_transcribe(
    app: &tauri::AppHandle,
    job_id: &str,
    phase: &str,
    label: &str,
    percent: Option<u8>,
    started_ms: Option<u64>,
) {
    let _ = app.emit(
        "local-transcribe-progress",
        json!({
            "jobId": job_id,
            "phase": phase,
            "label": label,
            "percent": percent,
            "startedMs": started_ms,
        }),
    );
}

fn pace_of(request: &Value) -> String {
    match request.get("pace").and_then(Value::as_str) {
        Some("faster") => "faster".into(),
        _ => "clearer".into(),
    }
}

fn language_of(request: &Value) -> String {
    request
        .get("language")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("en")
        .to_string()
}

fn emit_setup(app: &tauri::AppHandle, phase: &str, label: &str, received: u64, total: Option<u64>) {
    let _ = app.emit(
        "local-setup-progress",
        json!({
            "phase": phase,
            "label": label,
            "received": received,
            "total": total,
        }),
    );
}

fn file_path_string(file: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    file.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "That choice is not a file on this computer.".to_string())
}

#[tauri::command]
async fn desktop_call(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match op.as_str() {
        // Whisper stays off the window thread. A sync command runs on that
        // thread, and Windows then marks the desktop Not Responding.
        "transcribeMedia" | "transcribeLocal" => {
            let media = require_str(&request, "path")?.to_string();
            let transcribe = local_runtime::TranscribeRequest {
                job_id: optional_string(&request, "jobId").unwrap_or_default(),
                home: optional_string(&request, "home").unwrap_or_default(),
                course_id: optional_string(&request, "courseId").unwrap_or_default(),
                module_id: optional_string(&request, "moduleId"),
                module_name: optional_string(&request, "moduleName"),
                new_module_name: optional_string(&request, "newModuleName"),
                pace: pace_of(&request),
                language: language_of(&request),
            };
            let app_data = app_data_dir();
            let handle = app.clone();
            return match tauri::async_runtime::spawn_blocking(move || {
                let job_id = transcribe.job_id.clone();
                local_runtime::transcribe_json(
                    &app_data,
                    &media,
                    &transcribe,
                    &mut |phase, label, percent, started_ms| {
                        emit_transcribe(&handle, &job_id, phase, label, percent, started_ms);
                    },
                )
            })
            .await
            {
                Ok(result) => result,
                Err(_) => {
                    Err("Could not transcribe that recording. The worker thread stopped.".into())
                }
            };
        }
        // ffmpeg can run for a long recording. Keep that off the window thread.
        "completeLocal" => {
            let messages = request.get("messages").cloned().unwrap_or(Value::Null);
            let max = request
                .get("maxCompletionTokens")
                .and_then(Value::as_u64)
                .unwrap_or(1200);
            let app_data = app_data_dir();
            return match tauri::async_runtime::spawn_blocking(move || {
                local_runtime::complete_local_notes(&app_data, &messages, max)
            })
            .await
            {
                Ok(result) => result.map(Value::String),
                Err(_) => Err("The notes model stopped before it finished the notes.".into()),
            };
        }
        "prepareCloudAudio" => {
            let media = require_str(&request, "path")?.to_string();
            let app_data = app_data_dir();
            return match tauri::async_runtime::spawn_blocking(move || {
                local_runtime::prepare_cloud_audio(&app_data, &media)
            })
            .await
            {
                Ok(result) => result,
                Err(_) => Err("Could not prepare that recording. The worker thread stopped.".into()),
            };
        }
        // The download can take a while. Keep it off the window thread, and
        // do not start the installer until this command runs.
        "startInstaller" => {
            let url = require_str(&request, "url")?.to_string();
            let file_name = installer_file_name(&url)?;
            if Path::new(&file_name).components().count() != 1 {
                return Err("That installer cannot be downloaded.".into());
            }
            #[cfg(not(windows))]
            {
                let _ = file_name;
                return Err("The Windows installer starts on Windows.".into());
            }
            #[cfg(windows)]
            {
                let dest = app_data_dir().join("updates").join(file_name);
                return match tauri::async_runtime::spawn_blocking(move || {
                    download_installer(&url, &dest)?;
                    start_installer(&dest)?;
                    Ok(Value::Null)
                })
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err("The installer did not start.".into()),
                };
            }
        }
        _ => {}
    }
    desktop_request(app, request)
}

fn mailto_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("mailto:") else {
        return false;
    };
    if rest.contains(['/', '\\', ' ']) {
        return false;
    }
    let address = rest.split('?').next().unwrap_or("");
    let mut parts = address.split('@');
    let local = parts.next().unwrap_or("");
    let host = parts.next().unwrap_or("");
    parts.next().is_none() && !local.is_empty() && host.contains('.')
}

fn openable_url(url: &str) -> bool {
    if url.starts_with("mailto:") {
        return mailto_ok(url);
    }
    const PREFIX: &str = "https://github.com/Hammad15/notes_maker/releases/download/";
    let Some(rest) = url.strip_prefix(PREFIX) else {
        return false;
    };
    let lower_rest = rest.to_ascii_lowercase();
    if rest.contains(['?', '#', '\\', ' ']) || rest.contains("..") {
        return false;
    }
    if lower_rest.contains("%2f") || lower_rest.contains("%5c") {
        return false;
    }
    let mut parts = rest.split('/');
    let tag = match parts.next() {
        Some(tag) if !tag.is_empty() => tag,
        _ => return false,
    };
    let file = match parts.next() {
        Some(file) if !file.is_empty() => file,
        _ => return false,
    };
    if parts.next().is_some() || tag.contains(['@', ':']) {
        return false;
    }
    let lower = file.to_ascii_lowercase();
    lower.ends_with(".exe") || lower.ends_with(".msi")
}

const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;

fn installer_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    if rest.contains([' ', '\\']) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.is_empty() { None } else { Some(host) }
}

fn installer_host_allowed(host: &str) -> bool {
    matches!(
        host,
        "github.com"
            | "release-assets.githubusercontent.com"
            | "objects.githubusercontent.com"
            | "github-releases.githubusercontent.com"
    )
}

fn decode_installer_name(raw: &str) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("That installer cannot be downloaded.".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            let value = u8::from_str_radix(hex, 16)
                .map_err(|_| "That installer cannot be downloaded.".to_string())?;
            if value < 0x20 || value == b'/' || value == b'\\' {
                return Err("That installer cannot be downloaded.".into());
            }
            out.push(char::from(value));
            index += 3;
        } else {
            let ch = bytes[index] as char;
            if ch == '/' || ch == '\\' {
                return Err("That installer cannot be downloaded.".into());
            }
            out.push(ch);
            index += 1;
        }
    }
    Ok(out)
}

fn installer_file_name(url: &str) -> Result<String, String> {
    if !openable_url(url) || !url.starts_with("https://") {
        return Err("That installer cannot be downloaded.".into());
    }
    let raw = url.rsplit('/').next().unwrap_or("");
    let name = decode_installer_name(raw)?;
    let lower = name.to_ascii_lowercase();
    if name.is_empty()
        || name.contains(['/', '\\'])
        || name.contains("..")
        || (!lower.ends_with(".exe") && !lower.ends_with(".msi"))
    {
        return Err("That installer cannot be downloaded.".into());
    }
    Ok(name)
}

fn installer_redirect(current: &str, location: &str) -> Result<String, String> {
    let location = location.trim();
    let next = if location.starts_with("https://") {
        location.to_string()
    } else if location.starts_with('/') && !location.starts_with("//") {
        let host = installer_host(current)
            .ok_or_else(|| "That installer cannot be downloaded.".to_string())?;
        format!("https://{host}{location}")
    } else {
        return Err("That installer cannot be downloaded.".into());
    };
    let host = installer_host(&next).ok_or_else(|| "That installer cannot be downloaded.".to_string())?;
    if !installer_host_allowed(host) {
        return Err("That installer cannot be downloaded.".into());
    }
    Ok(next)
}

fn installer_launch(path: &str) -> Result<(String, Vec<String>), String> {
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let lower = name.to_ascii_lowercase();
    let (program, args) = if lower.ends_with(".msi") {
        ("msiexec".to_string(), vec!["/i".to_string(), path.to_string()])
    } else if lower.ends_with(".exe") {
        (path.to_string(), Vec::new())
    } else {
        return Err("That installer cannot be started.".into());
    };
    for arg in &args {
        let flag = arg.to_ascii_lowercase();
        if matches!(
            flag.as_str(),
            "/s" | "/quiet" | "/qn" | "/qb" | "/passive" | "/norestart" | "-s" | "--silent"
        ) {
            return Err("The installer cannot start unattended.".into());
        }
    }
    Ok((program, args))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn installer_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(180))
        .redirects(0)
        .build()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn fetch_installer(url: &str) -> Result<ureq::Response, String> {
    let mut current = url.to_string();
    for hop in 0..=5 {
        let host = installer_host(&current)
            .ok_or_else(|| "That installer cannot be downloaded.".to_string())?;
        if !installer_host_allowed(host) {
            return Err("That installer cannot be downloaded.".into());
        }
        let response = installer_agent()
            .get(&current)
            .set("user-agent", "CreateNotes/0.1")
            .set("accept", "application/octet-stream")
            .call()
            .map_err(|error| match error {
                ureq::Error::Status(code, _) => {
                    format!("The installer download was refused ({code}).")
                }
                _ => "The installer download did not finish.".into(),
            })?;
        let status = response.status();
        if (300..400).contains(&status) {
            if hop == 5 {
                return Err("The installer download did not finish.".into());
            }
            let location = response.header("location").unwrap_or("").to_string();
            current = installer_redirect(&current, &location)?;
            continue;
        }
        if status != 200 {
            return Err(format!("The installer download was refused ({status})."));
        }
        return Ok(response);
    }
    Err("The installer download did not finish.".into())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn download_installer(url: &str, dest: &Path) -> Result<(), String> {
    let response = fetch_installer(url)?;
    let expected = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok());
    if expected.is_some_and(|size| size == 0 || size > MAX_INSTALLER_BYTES) {
        return Err("The installer download did not finish.".into());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let partial = PathBuf::from(format!("{}.partial", dest.display()));
    let _ = fs::remove_file(&partial);
    let mut reader = response.into_reader();
    let mut file = File::create(&partial).map_err(|error| error.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    loop {
        let read = match reader.read(&mut buf) {
            Ok(read) => read,
            Err(error) => {
                let _ = fs::remove_file(&partial);
                return Err(error.to_string());
            }
        };
        if read == 0 {
            break;
        }
        received += read as u64;
        if received > MAX_INSTALLER_BYTES || file.write_all(&buf[..read]).is_err() {
            let _ = fs::remove_file(&partial);
            return Err("The installer download did not finish.".into());
        }
    }
    file.sync_all().ok();
    drop(file);
    if received == 0 || expected.is_some_and(|size| size != received) {
        let _ = fs::remove_file(&partial);
        return Err("The installer download did not finish.".into());
    }
    let _ = fs::remove_file(dest);
    fs::rename(&partial, dest).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn start_installer(path: &Path) -> Result<(), String> {
    let (program, args) = installer_launch(&path.to_string_lossy())?;
    #[cfg(windows)]
    {
        Command::new(program)
            .args(args)
            .spawn()
            .map_err(|_| "The installer did not start.".to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = (program, args);
        Err("The Windows installer starts on Windows.".into())
    }
}

fn desktop_request(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    let op = require_str(&request, "op")?;
    match op {
        "appDataDir" => Ok(json!(app_data_dir().to_string_lossy())),
        "userHome" => Ok(json!(user_home())),
        "roots" => Ok(json!(roots())),
        "readText" => read_text(require_str(&request, "path")?),
        "writeText" => {
            write_text(
                require_str(&request, "path")?,
                request.get("text").and_then(Value::as_str).unwrap_or(""),
            )?;
            Ok(Value::Null)
        }
        "writeBytes" => {
            let encoded = require_str(&request, "base64")?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|error| error.to_string())?;
            write_bytes(require_str(&request, "path")?, &bytes)?;
            Ok(Value::Null)
        }
        "exists" => Ok(json!(Path::new(require_str(&request, "path")?).exists())),
        "list" => list_dir(require_str(&request, "path")?),
        "mkdir" => {
            fs::create_dir_all(require_str(&request, "path")?)
                .map_err(|error| error.to_string())?;
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
        "readBytes" => {
            let bytes = fs::read(require_str(&request, "path")?).map_err(|error| error.to_string())?;
            Ok(Value::String(STANDARD.encode(bytes)))
        }
        "localStatus" => local_runtime::status_json(&app_data_dir(), &pace_of(&request)),
        "activeTranscription" => Ok(local_runtime::active_job_json(&app_data_dir())),
        "clearTranscription" => {
            local_runtime::clear_job(&app_data_dir(), require_str(&request, "id")?)?;
            Ok(Value::Null)
        }
        "setupLocal" => {
            let handle = app.clone();
            let pace = pace_of(&request);
            local_runtime::setup_local(&app_data_dir(), &pace, &mut |phase, label, received, total| {
                emit_setup(&handle, phase, label, received, total);
            })
        }
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
        "openPath" => {
            let path = require_str(&request, "path")?;
            let file = Path::new(path);
            if !file.is_file() {
                return Err("That PDF is not on this computer.".into());
            }
            let name = file
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let lower = name.to_ascii_lowercase();
            if !lower.ends_with(".pdf") && !lower.ends_with(".md") {
                return Err("That file cannot be opened from Create Notes.".into());
            }
            tauri_plugin_opener::open_path(path, None::<&str>)
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "openUrl" => {
            let url = require_str(&request, "url")?;
            if !openable_url(url) {
                return Err("That link cannot be opened from Create Notes.".into());
            }
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())?;
            Ok(Value::Null)
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
        .setup(|_app| {
            // A sleep can leave whisper-cli running after the window reloads.
            // Stop every copy started from this app except the job we can resume.
            let _ = local_runtime::reconcile_on_launch(&app_data_dir());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_call])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod duration_tests {
    use super::{duration_from_header, installer_file_name, installer_launch, installer_redirect, openable_url};
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
    fn make_notes_command_accepts_the_ui_request() {
        let source = include_str!("lib.rs");
        assert!(
            source.contains("\"transcribeMedia\" | \"transcribeLocal\""),
            "Make Notes sends op transcribeMedia"
        );
        assert!(
            source.contains("\"completeLocal\""),
            "Local notes send op completeLocal"
        );
    }

    #[test]
    fn transcription_runs_off_the_ui_thread() {
        let source = include_str!("lib.rs");
        assert!(
            source.contains("async fn desktop_call"),
            "a sync desktop command runs on the window thread"
        );
        assert!(
            source.contains("spawn_blocking"),
            "whisper has to run on a worker thread"
        );
        assert!(
            source.contains("reconcile_on_launch"),
            "launch has to stop leftover whisper-cli processes"
        );
        assert!(
            source.contains("\"openPath\""),
            "Open PDF has to reach the desktop command when the plugin scope refuses the path"
        );
        assert!(
            source.contains("tauri_plugin_opener::open_path"),
            "the desktop command opens the file without the plugin IPC scope"
        );
        let transcribe = source
            .split("async fn desktop_call")
            .nth(1)
            .and_then(|body| body.split("fn desktop_request").next())
            .unwrap_or("");
        let blocking = transcribe
            .find("spawn_blocking")
            .expect("whisper has to run on a worker thread");
        let call = transcribe
            .find("transcribe_json")
            .expect("the worker has to run transcription");
        assert!(
            blocking < call,
            "whisper starts only after the worker is spawned, not on the window thread"
        );
        assert!(
            transcribe.contains("\"prepareCloudAudio\""),
            "Cloud notes prepare audio through the desktop command"
        );
        let prepare = transcribe
            .find("prepare_cloud_audio")
            .expect("the worker prepares cloud audio");
        let prepare_blocking = transcribe.rfind("spawn_blocking").unwrap_or(0);
        assert!(
            prepare_blocking < prepare,
            "ffmpeg preparation starts on a worker thread"
        );
    }

    #[test]
    fn open_url_allows_mailto_and_release_installers_only() {
        assert!(openable_url(
            "mailto:person@school.test?subject=Create%20Notes&body=Hello"
        ));
        assert!(!openable_url("mailto:not-an-address"));
        assert!(!openable_url("mailto:has/slash@example.com"));
        assert!(openable_url(
            "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/CreateNotes_0.2.0_x64-setup.exe"
        ));
        assert!(openable_url(
            "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/Create.Notes.msi"
        ));
        assert!(!openable_url(
            "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/notes.zip"
        ));
        assert!(!openable_url(
            "http://github.com/Hammad15/notes_maker/releases/download/v0.2.0/Setup.exe"
        ));
        assert!(!openable_url(
            "https://user:pass@github.com/Hammad15/notes_maker/releases/download/v0.2.0/Setup.exe"
        ));
        assert!(!openable_url("https://example.com/Setup.exe"));
    }

    #[test]
    fn installer_download_stays_on_github_and_starts_the_window() {
        let setup = "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/Create%20Notes_0.2.0_x64-setup.exe";
        assert_eq!(
            installer_file_name(setup).unwrap(),
            "Create Notes_0.2.0_x64-setup.exe"
        );
        assert!(installer_file_name("https://example.com/Setup.exe").is_err());
        assert!(installer_file_name("mailto:person@school.test").is_err());
        let asset = "https://release-assets.githubusercontent.com/github-production-release-asset/1/Setup.exe";
        assert_eq!(
            installer_redirect(setup, asset).unwrap(),
            asset
        );
        assert!(installer_redirect(setup, "https://evil.example/Setup.exe").is_err());
        assert!(installer_redirect(setup, "http://objects.githubusercontent.com/Setup.exe").is_err());
        let exe = installer_launch("C:\\Users\\Ada\\AppData\\Local\\Study Notes\\updates\\Setup.exe").unwrap();
        assert_eq!(exe.0, "C:\\Users\\Ada\\AppData\\Local\\Study Notes\\updates\\Setup.exe");
        assert!(exe.1.is_empty());
        let msi = installer_launch("C:\\Users\\Ada\\AppData\\Local\\Study Notes\\updates\\Create Notes.msi").unwrap();
        assert_eq!(msi.0, "msiexec");
        assert_eq!(
            msi.1,
            vec![
                "/i".to_string(),
                "C:\\Users\\Ada\\AppData\\Local\\Study Notes\\updates\\Create Notes.msi".to_string()
            ]
        );
        for arg in exe.1.iter().chain(msi.1.iter()) {
            let flag = arg.to_ascii_lowercase();
            assert!(!matches!(
                flag.as_str(),
                "/s" | "/quiet" | "/qn" | "/qb" | "/passive" | "/norestart" | "-s" | "--silent"
            ));
        }
        assert!(include_str!("lib.rs").contains("\"startInstaller\""));
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
            assert!(
                (duration - expected).abs() < 0.001,
                "{duration} vs {expected}"
            );
        }
    }
}
