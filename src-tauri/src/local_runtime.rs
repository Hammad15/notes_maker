use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{copy, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

const MODEL_NAME: &str = "ggml-base.en";
const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_BYTES: u64 = 147_964_211;
const MODEL_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

const TINY_NAME: &str = "ggml-tiny.en";
const TINY_FILE: &str = "ggml-tiny.en.bin";
const TINY_BYTES: u64 = 77_704_715;
const TINY_SHA256: &str = "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
const TINY_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";

#[derive(Clone, Copy)]
struct ModelSpec {
    name: &'static str,
    file: &'static str,
    bytes: u64,
    sha256: &'static str,
    url: &'static str,
}

fn pace_name(pace: &str) -> &'static str {
    if pace == "faster" { "faster" } else { "clearer" }
}

fn setup_label(phase: &str) -> &'static str {
    match phase {
        "ffmpeg" => "Downloading the speech tools",
        "engine" => "Downloading the speech engine",
        "model" => "Downloading the speech model",
        "notesEngine" => "Downloading the notes engine",
        "notes" => "Downloading the notes model",
        _ => "Saving local setup",
    }
}

/// The selected speed's speech model. Setup does not fetch the other speed's file.
fn speech_models_for_setup(pace: &str) -> Vec<ModelSpec> {
    vec![model_spec(pace)]
}

fn model_spec(pace: &str) -> ModelSpec {
    if pace_name(pace) == "faster" {
        ModelSpec {
            name: TINY_NAME,
            file: TINY_FILE,
            bytes: TINY_BYTES,
            sha256: TINY_SHA256,
            url: TINY_URL,
        }
    } else {
        ModelSpec {
            name: MODEL_NAME,
            file: MODEL_FILE,
            bytes: MODEL_BYTES,
            sha256: MODEL_SHA256,
            url: MODEL_URL,
        }
    }
}

const ENGINE_VERSION: &str = "1.9.2";
const ENGINE_EXE: &str = "whisper-cli.exe";
const ENGINE_EXE_BYTES: u64 = 479_232;
const ENGINE_ZIP_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
const ENGINE_ZIP_BYTES: u64 = 8_194_445;
const ENGINE_ZIP_SHA256: &str = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a";

const FFMPEG_VERSION: &str = "9.0.2";
const FFMPEG_ZIP_URL: &str =
    "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip";
const FFMPEG_ZIP_BYTES: u64 = 114_768_076;
const FFMPEG_ZIP_SHA256: &str = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";

const NOTES_MODEL_NAME: &str = "Qwen2.5-7B-Instruct";
const NOTES_MODEL_FILE: &str = "qwen2.5-7b-instruct-q4_k_m.gguf";
const NOTES_MODEL_BYTES: u64 = 4_683_074_240;
const NOTES_MODEL_SHA256: &str = "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423";
const NOTES_MODEL_URL: &str = "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf";

const NOTES_ENGINE_VERSION: &str = "b10599";
const NOTES_ENGINE_EXE: &str = "llama-cli.exe";
const NOTES_ENGINE_ZIP_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b10599/llama-b10599-bin-win-cpu-x64.zip";
const NOTES_ENGINE_ZIP_BYTES: u64 = 18_061_865;
const NOTES_ENGINE_ZIP_SHA256: &str =
    "d95eff420538b372273c5ee82258e238cc955ee3b5135443503d1fa4a38d8308";
const NOTES_CONTEXT_TOKENS: u64 = 16_384;
const NOTES_ENGINE_FILES: [(&str, u64); 7] = [
    ("llama-cli.exe", 9_216),
    ("llama-cli-impl.dll", 3_258_368),
    ("llama.dll", 2_996_224),
    ("llama-common.dll", 7_740_416),
    ("ggml.dll", 86_016),
    ("ggml-base.dll", 773_632),
    ("ggml-cpu-x64.dll", 870_912),
];

const LONG_RECORDING_SECONDS: f64 = 30.0 * 60.0;
const MIN_LONG_ELAPSED_MS: u128 = 60_000;
const SETUP_REQUIRED: &str = "Press Set up local notes before making notes.";
const REPLACED: &str = "Transcription was replaced by a different recording.";
const NOTES_CANCELLED: &str = "Note making was cancelled.";
#[cfg(windows)]
const PROCESS_SNAPSHOT_SCRIPT: &str = r#"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'whisper-cli.exe' -or $_.Name -eq 'ffmpeg.exe' } | ForEach-Object { $cmd = $_.CommandLine; if ($null -eq $cmd) { $cmd = '' }; $cmd = ($cmd -replace "`t", ' ' -replace "`r|`n", ' '); $exe = $_.ExecutablePath; if ($null -eq $exe) { $exe = '' }; Write-Output (('{0}`t{1}`t{2}' -f $_.ProcessId, $exe, $cmd)) }"#;

const ENGINE_DLLS: [&str; 4] = [
    "whisper.dll",
    "ggml.dll",
    "ggml-base.dll",
    "ggml-cpu-x64.dll",
];

struct Segment {
    start: f64,
    end: f64,
    text: String,
}

struct RuntimeStatus {
    ready: bool,
    missing: Vec<&'static str>,
}

pub(crate) fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn exe_name(name: &str) -> String {
    #[cfg(windows)]
    {
        format!("{name}.exe")
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn bin_dir(app_data: &Path) -> PathBuf {
    app_data.join("bin")
}

fn model_path(app_data: &Path, pace: &str) -> PathBuf {
    app_data.join("models").join(model_spec(pace).file)
}

fn config_path(app_data: &Path) -> PathBuf {
    app_data.join("models").join("local.json")
}

fn notes_bin(app_data: &Path) -> PathBuf {
    bin_dir(app_data).join("notes")
}

fn notes_model_path(app_data: &Path) -> PathBuf {
    app_data.join("models").join(NOTES_MODEL_FILE)
}

pub(crate) fn tool_path(app_data: &Path, name: &str) -> Option<PathBuf> {
    let bundled = bin_dir(app_data).join(exe_name(name));
    if bundled.is_file() {
        return Some(bundled);
    }
    let bare = PathBuf::from(name);
    if command_works(&bare) {
        return Some(bare);
    }
    None
}

fn command_works(program: &Path) -> bool {
    let mut command = Command::new(program);
    command.arg("-version");
    run_command(command, Duration::from_secs(20), "version").is_ok()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buf).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_matches(path: &Path, expected: u64, sha256: &str) -> Result<bool, String> {
    let Ok(meta) = fs::metadata(path) else {
        return Ok(false);
    };
    if !meta.is_file() || meta.len() != expected {
        return Ok(false);
    }
    Ok(sha256_file(path)? == sha256)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(180))
        .build()
}

fn download_verified(
    url: &str,
    dest: &Path,
    expected: u64,
    sha256: &str,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    if file_matches(dest, expected, sha256)? {
        progress(expected, expected);
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let partial = PathBuf::from(format!("{}.partial", dest.display()));
    let _ = fs::remove_file(&partial);
    let response = agent()
        .get(url)
        .set("user-agent", "StudyNotes/0.1")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => format!("The download was refused ({code})."),
            other => format!("Check the network and press Set up local notes again. {other}"),
        })?;
    let mut reader = response.into_reader();
    let mut file = File::create(&partial).map_err(|error| error.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    let mut reported = 0u64;
    loop {
        let read = reader.read(&mut buf).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read])
            .map_err(|error| error.to_string())?;
        received += read as u64;
        if received == expected || received.saturating_sub(reported) >= 1024 * 1024 {
            reported = received;
            progress(received, expected);
        }
    }
    file.sync_all().ok();
    drop(file);
    if received != expected {
        let _ = fs::remove_file(&partial);
        return Err(format!(
            "The download was incomplete ({received} of {expected} bytes)."
        ));
    }
    if sha256_file(&partial)? != sha256 {
        let _ = fs::remove_file(&partial);
        return Err("The download did not match the expected file.".into());
    }
    let _ = fs::remove_file(dest);
    fs::rename(&partial, dest).map_err(|error| error.to_string())?;
    unblock(dest);
    progress(expected, expected);
    Ok(())
}

fn unblock(path: &Path) {
    #[cfg(windows)]
    {
        let ads = format!("{}:Zone.Identifier", path.display());
        let _ = fs::remove_file(ads);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
}

fn keep_name(name: &str, kind: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if kind == "ffmpeg" {
        return lower == "ffmpeg.exe" || lower == "ffprobe.exe";
    }
    if kind == "notes" {
        return lower == "llama-cli.exe" || lower.ends_with(".dll");
    }
    lower == "whisper-cli.exe" || lower.ends_with(".dll")
}

fn extract_named(zip_path: &Path, dest: &Path, kind: &str) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    let file = File::open(zip_path).map_err(|error| error.to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Could not open the download. {error}"))?;
    let mut wrote = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with('/') || name.split('/').any(|part| part == "..") {
            continue;
        }
        let Some(file_name) = name.rsplit('/').next() else {
            continue;
        };
        if file_name.is_empty() || !keep_name(file_name, kind) {
            continue;
        }
        let target = dest.join(file_name);
        let mut outfile = File::create(&target).map_err(|error| error.to_string())?;
        copy(&mut entry, &mut outfile).map_err(|error| error.to_string())?;
        unblock(&target);
        wrote += 1;
    }
    if wrote == 0 {
        return Err("The download did not include the expected programs.".into());
    }
    Ok(())
}

fn sized_file(path: &Path, bytes: u64) -> bool {
    fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() == bytes)
        .unwrap_or(false)
}

fn notes_engine_ready(dir: &Path) -> bool {
    NOTES_ENGINE_FILES
        .iter()
        .all(|(name, bytes)| sized_file(&dir.join(name), *bytes))
}

fn notes_model_ready(app_data: &Path) -> Result<bool, String> {
    static VERIFIED: Mutex<Option<PathBuf>> = Mutex::new(None);
    let path = notes_model_path(app_data);
    if let Ok(guard) = VERIFIED.lock() {
        if guard.as_ref() == Some(&path) && sized_file(&path, NOTES_MODEL_BYTES) {
            return Ok(true);
        }
    }
    let ready = file_matches(&path, NOTES_MODEL_BYTES, NOTES_MODEL_SHA256)?;
    if ready {
        if let Ok(mut guard) = VERIFIED.lock() {
            *guard = Some(path);
        }
    }
    Ok(ready)
}

fn engine_ready(dir: &Path) -> bool {
    let cli = dir.join(ENGINE_EXE);
    let Ok(meta) = fs::metadata(&cli) else {
        return false;
    };
    if meta.len() != ENGINE_EXE_BYTES {
        return false;
    }
    ENGINE_DLLS.iter().all(|dll| dir.join(dll).is_file())
}

fn config_ready(app_data: &Path) -> bool {
    let Ok(text) = fs::read_to_string(config_path(app_data)) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    json.get("ready").and_then(Value::as_bool) == Some(true)
}

fn collect_status(app_data: &Path, pace: &str) -> Result<RuntimeStatus, String> {
    let spec = model_spec(pace);
    let mut missing = Vec::new();
    if tool_path(app_data, "ffmpeg").is_none() {
        missing.push("ffmpeg");
    }
    if tool_path(app_data, "ffprobe").is_none() {
        missing.push("ffprobe");
    }
    if !engine_ready(&bin_dir(app_data)) {
        missing.push("engine");
    }
    if !file_matches(&model_path(app_data, pace), spec.bytes, spec.sha256)? {
        missing.push("model");
    }
    if !notes_engine_ready(&notes_bin(app_data)) {
        missing.push("notesEngine");
    }
    if !notes_model_ready(app_data)? {
        missing.push("notes");
    }
    if !config_ready(app_data) {
        missing.push("config");
    }
    let ready = missing.is_empty();
    Ok(RuntimeStatus { ready, missing })
}

fn status_value(status: &RuntimeStatus, pace: &str) -> Value {
    json!({
        "ready": status.ready,
        "model": model_spec(pace).name,
        "missing": status.missing,
    })
}

pub(crate) fn status_json(app_data: &Path, pace: &str) -> Result<Value, String> {
    Ok(status_value(&collect_status(app_data, pace)?, pace))
}

pub(crate) fn setup_local(
    app_data: &Path,
    pace: &str,
    progress: &mut dyn FnMut(&str, &str, u64, Option<u64>),
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("Set up local notes downloads the Windows speech tools.".into());
    }
    let bin = bin_dir(app_data);
    let downloads = app_data.join("downloads");
    fs::create_dir_all(&bin).map_err(|error| error.to_string())?;
    fs::create_dir_all(app_data.join("models")).map_err(|error| error.to_string())?;
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;

    if tool_path(app_data, "ffmpeg").is_none() || tool_path(app_data, "ffprobe").is_none() {
        let label = setup_label("ffmpeg");
        progress("ffmpeg", label, 0, Some(FFMPEG_ZIP_BYTES));
        let zip = downloads.join("ffmpeg-9.0.2-essentials_build.zip");
        download_verified(
            FFMPEG_ZIP_URL,
            &zip,
            FFMPEG_ZIP_BYTES,
            FFMPEG_ZIP_SHA256,
            &mut |received, total| {
                progress("ffmpeg", label, received, Some(total));
            },
        )
        .map_err(|error| format!("Could not download ffmpeg and ffprobe. {error}"))?;
        extract_named(&zip, &bin, "ffmpeg")?;
        let mut ffmpeg_version = Command::new(bin.join("ffmpeg.exe"));
        ffmpeg_version.arg("-version");
        run_command(
            ffmpeg_version,
            Duration::from_secs(20),
            "ffmpeg was downloaded but did not start.",
        )?;
        let mut ffprobe_version = Command::new(bin.join("ffprobe.exe"));
        ffprobe_version.arg("-version");
        run_command(
            ffprobe_version,
            Duration::from_secs(20),
            "ffprobe was downloaded but did not start.",
        )?;
    }

    if !engine_ready(&bin) {
        let label = setup_label("engine");
        progress("engine", label, 0, Some(ENGINE_ZIP_BYTES));
        let zip = downloads.join("whisper-bin-x64.zip");
        download_verified(
            ENGINE_ZIP_URL,
            &zip,
            ENGINE_ZIP_BYTES,
            ENGINE_ZIP_SHA256,
            &mut |received, total| {
                progress("engine", label, received, Some(total));
            },
        )
        .map_err(|error| format!("Could not download the speech engine. {error}"))?;
        extract_named(&zip, &bin, "engine")?;
        if !engine_ready(&bin) {
            return Err("The speech engine download did not include whisper-cli.".into());
        }
    }

    let models = speech_models_for_setup(pace);
    let spec = models.first().cloned().unwrap_or_else(|| model_spec(pace));
    for speech in &models {
        let label = setup_label("model");
        progress("model", label, 0, Some(speech.bytes));
        download_verified(
            speech.url,
            &app_data.join("models").join(speech.file),
            speech.bytes,
            speech.sha256,
            &mut |received, total| {
                progress("model", label, received, Some(total));
            },
        )
        .map_err(|error| format!("Could not download the speech model. {error}"))?;
    }

    let notes_dir = notes_bin(app_data);
    if !notes_engine_ready(&notes_dir) {
        let label = setup_label("notesEngine");
        progress("notesEngine", label, 0, Some(NOTES_ENGINE_ZIP_BYTES));
        let zip = downloads.join("llama-bin-win-cpu-x64.zip");
        download_verified(
            NOTES_ENGINE_ZIP_URL,
            &zip,
            NOTES_ENGINE_ZIP_BYTES,
            NOTES_ENGINE_ZIP_SHA256,
            &mut |received, total| {
                progress("notesEngine", label, received, Some(total));
            },
        )
        .map_err(|error| format!("Could not download the notes engine. {error}"))?;
        fs::create_dir_all(&notes_dir).map_err(|error| error.to_string())?;
        extract_named(&zip, &notes_dir, "notes")?;
        if !notes_engine_ready(&notes_dir) {
            return Err("The notes engine download did not include llama-cli.".into());
        }
    }

    let notes_label = setup_label("notes");
    progress("notes", notes_label, 0, Some(NOTES_MODEL_BYTES));
    download_verified(
        NOTES_MODEL_URL,
        &notes_model_path(app_data),
        NOTES_MODEL_BYTES,
        NOTES_MODEL_SHA256,
        &mut |received, total| {
            progress("notes", notes_label, received, Some(total));
        },
    )
    .map_err(|error| format!("Could not download the notes model. {error}"))?;

    progress("config", setup_label("config"), 1, Some(1));
    let ffmpeg_source = if bin.join("ffmpeg.exe").is_file() {
        FFMPEG_VERSION
    } else {
        "path"
    };
    let config = json!({
        "ready": true,
        "pace": pace_name(pace),
        "model": spec.name,
        "modelFile": spec.file,
        "modelBytes": spec.bytes,
        "engine": "whisper.cpp",
        "engineVersion": ENGINE_VERSION,
        "notesModel": NOTES_MODEL_NAME,
        "notesFile": NOTES_MODEL_FILE,
        "notesBytes": NOTES_MODEL_BYTES,
        "notesEngine": "llama.cpp",
        "notesEngineVersion": NOTES_ENGINE_VERSION,
        "ffmpeg": ffmpeg_source,
    });
    let pretty = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(config_path(app_data), format!("{pretty}\n")).map_err(|error| error.to_string())?;
    let status = collect_status(app_data, pace)?;
    if !status.ready {
        return Err(format!(
            "Local notes are still missing pieces after setup: {}.",
            status.missing.join(", ")
        ));
    }
    Ok(status_value(&status, pace))
}

fn last_assistant_end(raw: &str) -> Option<usize> {
    let lower = raw.to_ascii_lowercase();
    let mut best: Option<usize> = None;
    let token = "<|im_start|>assistant";
    let mut from = 0;
    while let Some(rel) = lower[from..].find(token) {
        let at = from + rel;
        let mut end = at + token.len();
        let bytes = raw.as_bytes();
        while end < bytes.len() && (bytes[end] == b' ' || bytes[end] == b'\t') {
            end += 1;
        }
        best = Some(end);
        from = end.max(at + 1);
    }
    let mut offset = 0;
    for line in raw.split_inclusive('\n') {
        let trimmed_start = line.len() - line.trim_start().len();
        let body = line.trim();
        let body_lower = body.to_ascii_lowercase();
        if let Some(rel) = body_lower.find("assistant:") {
            if rel == 0 {
                let mut after = "assistant:".len();
                let bytes = body.as_bytes();
                while after < bytes.len() && (bytes[after] == b' ' || bytes[after] == b'\t') {
                    after += 1;
                }
                let end = offset + trimmed_start + after;
                if best.map(|current| end >= current).unwrap_or(true) {
                    best = Some(end);
                }
            }
        }
        offset += line.len();
    }
    best
}

fn timestamped_transcript_line(line: &str) -> bool {
    let trimmed = line.trim();
    let bytes = trimmed.as_bytes();
    if bytes.first() != Some(&b'[') {
        return false;
    }
    let mut index = 1;
    let mut digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        digits += 1;
        index += 1;
        if digits > 2 {
            return false;
        }
    }
    if digits == 0 || index >= bytes.len() || bytes[index] != b':' {
        return false;
    }
    index += 1;
    if index + 1 >= bytes.len() || !bytes[index].is_ascii_digit() || !bytes[index + 1].is_ascii_digit() {
        return false;
    }
    index += 2;
    if index < bytes.len() && bytes[index] == b':' {
        index += 1;
        if index + 1 >= bytes.len() || !bytes[index].is_ascii_digit() || !bytes[index + 1].is_ascii_digit() {
            return false;
        }
        index += 2;
    }
    if index >= bytes.len() || bytes[index] != b']' {
        return false;
    }
    index += 1;
    index == bytes.len() || bytes[index].is_ascii_whitespace()
}

fn clock_span(bytes: &[u8], start: usize) -> Option<usize> {
    if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
        return None;
    }
    let mut index = start;
    let mut digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        digits += 1;
        index += 1;
        if digits > 2 {
            return None;
        }
    }
    if digits == 0 || index >= bytes.len() || bytes[index] != b':' {
        return None;
    }
    index += 1;
    if index + 1 >= bytes.len() || !bytes[index].is_ascii_digit() || !bytes[index + 1].is_ascii_digit() {
        return None;
    }
    index += 2;
    if index < bytes.len() && bytes[index] == b':' {
        if index + 2 >= bytes.len()
            || !bytes[index + 1].is_ascii_digit()
            || !bytes[index + 2].is_ascii_digit()
        {
            return None;
        }
        index += 3;
    }
    if index < bytes.len() && bytes[index].is_ascii_alphanumeric() {
        return None;
    }
    Some(index)
}

fn extend_clock_range(bytes: &[u8], end: usize) -> usize {
    let mut index = end;
    while index < bytes.len() && (bytes[index] == b' ' || bytes[index] == b'\t') {
        index += 1;
    }
    let rest = std::str::from_utf8(&bytes[index..]).unwrap_or("");
    let lower = rest.to_ascii_lowercase();
    for word in ["through", "to", "and", "–", "—", "-"] {
        if !lower.starts_with(word) {
            continue;
        }
        let mut next = index + word.len();
        while next < bytes.len() && (bytes[next] == b' ' || bytes[next] == b'\t') {
            next += 1;
        }
        if let Some(range_end) = clock_span(bytes, next) {
            return range_end;
        }
    }
    end
}

fn rewind_time_pointer(bytes: &[u8], clock_at: usize) -> usize {
    let mut end = clock_at;
    while end > 0 && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    let prefix = std::str::from_utf8(&bytes[..end]).unwrap_or("");
    let lower = prefix.to_ascii_lowercase();
    for word in [
        "starting", "ending", "timestamp", "between", "around", "before", "after", "until", "about",
        "from", "near", "till", "time", "the", "at",
    ] {
        if !lower.ends_with(word) {
            continue;
        }
        let start = end - word.len();
        let boundary = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        if !boundary {
            continue;
        }
        return if word == "the" || word == "time" {
            rewind_time_pointer(bytes, start)
        } else {
            start
        };
    }
    clock_at
}

fn remove_phrase(input: &str, phrase: &str) -> String {
    let lower_input = input.to_ascii_lowercase();
    let needle = phrase.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let matched = lower_input[index..].starts_with(&needle);
        let end = index + needle.len();
        let boundary = index == 0 || !bytes[index - 1].is_ascii_alphanumeric();
        let closed = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if matched && boundary && closed {
            out.push(' ');
            index = end;
            continue;
        }
        let size = if bytes[index].is_ascii() { 1 } else { input[index..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1) };
        out.push_str(&input[index..index + size]);
        index += size;
    }
    out
}

fn tidy_timestamp_body(text: &str) -> String {
    let mut body = text.to_string();
    for phrase in [
        "at this point in the recording",
        "at that point in the recording",
        "at the point in the recording",
        "this point in the recording",
        "that point in the recording",
        "the point in the recording",
        "this part in the recording",
        "this moment in the recording",
        "this timestamp in the recording",
        "from this point in the recording",
        "around this point in the recording",
        "near this point in the recording",
        "this point in the video",
        "this point in the audio",
        "at this point in the video",
        "at that point in the video",
        "at the point in the video",
        "from this point in the video",
        "earlier in the recording",
        "later in the recording",
        "earlier in the video",
        "later in the video",
        "earlier in the audio",
        "later in the audio",
        "this timestamp",
        "that timestamp",
        "the timestamp",
        "timestamps",
        "timestamp",
    ] {
        body = remove_phrase(&body, phrase);
    }
    let source = body;
    let bytes = source.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if let Some(clock_end) = clock_span(bytes, index) {
            let mut end = extend_clock_range(bytes, clock_end);
            let mut start = rewind_time_pointer(bytes, index);
            if start > 0 && (bytes[start - 1] == b'[' || bytes[start - 1] == b'(') {
                start -= 1;
            }
            if end < bytes.len() && (bytes[end] == b']' || bytes[end] == b')') {
                end += 1;
            }
            if start > copied {
                out.push_str(&source[copied..start]);
            }
            out.push(' ');
            copied = end;
            index = end;
            continue;
        }
        let size = if bytes[index].is_ascii() {
            1
        } else {
            source[index..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1)
        };
        index += size;
    }
    if copied < source.len() {
        out.push_str(&source[copied..]);
    }
    let mut tidy = String::new();
    let mut spaced = false;
    for ch in out.chars() {
        if ch == ' ' || ch == '\t' {
            if !spaced {
                tidy.push(' ');
            }
            spaced = true;
            continue;
        }
        spaced = false;
        if matches!(ch, ',' | '.' | ';' | ':' | '!' | '?') {
            while tidy.ends_with(' ') {
                tidy.pop();
            }
        }
        tidy.push(ch);
    }
    tidy.replace("( )", "")
        .replace("()", "")
        .replace("[ ]", "")
        .replace("[]", "")
        .trim()
        .to_string()
}

fn shape_local_study_line(line: &str) -> String {
    let trimmed = line.trim_end();
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if (1..=6).contains(&hashes) {
        let rest = trimmed[hashes..].trim();
        if !rest.is_empty() && trimmed.as_bytes().get(hashes) == Some(&b' ') {
            let title = tidy_timestamp_body(rest);
            if title.is_empty() || title.chars().all(|ch| ch == '-' || ch == '*' || ch == '+' || ch == '.') {
                return String::new();
            }
            return format!("{} {}", "#".repeat(hashes), title);
        }
    }
    let (indent, body) = {
        let indent_len = line
            .chars()
            .take_while(|ch| *ch == ' ' || *ch == '\t')
            .map(|ch| ch.len_utf8())
            .sum();
        line.split_at(indent_len)
    };
    let stripped = tidy_timestamp_body(body);
    if stripped.is_empty() {
        return String::new();
    }
    if stripped.starts_with('|') || is_rule(&stripped) {
        return format!("{indent}{stripped}");
    }
    let item = strip_list_marker(&stripped);
    if item.is_empty() {
        return String::new();
    }
    format!("{indent}- {item}")
}

fn is_rule(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first != '-' && first != '*' && first != '_' {
        return false;
    }
    let mut count = 1;
    for ch in chars {
        if ch != first {
            return false;
        }
        count += 1;
    }
    count >= 3
}

fn strip_list_marker(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index > 0 && index < bytes.len() && (bytes[index] == b'.' || bytes[index] == b')') {
        let mut next = index + 1;
        if next < bytes.len() && (bytes[next] == b' ' || bytes[next] == b'\t') {
            while next < bytes.len() && (bytes[next] == b' ' || bytes[next] == b'\t') {
                next += 1;
            }
            return &text[next..];
        }
    }
    for marker in ["- ", "* ", "+ ", "• "] {
        if let Some(rest) = text.strip_prefix(marker) {
            return rest;
        }
    }
    text
}

fn clean_notes_reply(raw: &str) -> String {
    let without_nulls = raw.replace('\u{0000}', "");
    let kept = match last_assistant_end(&without_nulls) {
        Some(end) => &without_nulls[end..],
        None => without_nulls.as_str(),
    };
    let stripped = kept.replace("<|im_end|>", "");
    let mut lines = Vec::new();
    for line in stripped.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("llama_")
            || trimmed.starts_with("ggml_")
            || trimmed.starts_with("main:")
            || trimmed.starts_with("build:")
            || trimmed.starts_with("print_info:")
            || trimmed.starts_with("load_backend:")
            || timestamped_transcript_line(trimmed)
        {
            continue;
        }
        if trimmed.is_empty() {
            lines.push(String::new());
            continue;
        }
        let shaped = shape_local_study_line(line);
        if !shaped.is_empty() {
            lines.push(shaped);
        }
    }
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let mut collapsed = String::new();
    let mut blank = 0;
    for line in lines {
        if line.trim().is_empty() {
            blank += 1;
            if blank <= 1 && !collapsed.is_empty() {
                collapsed.push('\n');
            }
            continue;
        }
        blank = 0;
        if !collapsed.is_empty() {
            collapsed.push('\n');
        }
        collapsed.push_str(&line);
    }
    collapsed
}

fn notes_prompt(messages: &Value) -> Result<(String, String), String> {
    let rows = messages
        .as_array()
        .ok_or("The notes model did not return study notes.")?;
    let mut system = Vec::new();
    let mut user = Vec::new();
    for row in rows {
        let role = row.get("role").and_then(Value::as_str).unwrap_or("");
        let content = row.get("content").and_then(Value::as_str).unwrap_or("");
        if role == "system" {
            system.push(content);
        } else if role == "user" {
            user.push(content);
        }
    }
    let user_text = user.join("\n\n");
    if user_text.trim().is_empty() {
        return Err("The notes model did not return study notes.".into());
    }
    Ok((system.join("\n\n"), user_text))
}

struct NotesRun {
    job_id: String,
    pid: Mutex<u32>,
    cancelled: Mutex<bool>,
}

fn notes_slot() -> &'static Mutex<Option<Arc<NotesRun>>> {
    static SLOT: OnceLock<Mutex<Option<Arc<NotesRun>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

pub(crate) fn complete_local_notes(
    app_data: &Path,
    messages: &Value,
    max_tokens: u64,
    job_id: &str,
) -> Result<String, String> {
    if !notes_engine_ready(&notes_bin(app_data)) || !notes_model_ready(app_data)? {
        return Err(SETUP_REQUIRED.into());
    }
    let (system, user) = notes_prompt(messages)?;
    let tmp = app_data.join("tmp");
    fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let system_path = tmp.join(format!("notes-{id}-system.txt"));
    let user_path = tmp.join(format!("notes-{id}-user.txt"));
    let out_path = tmp.join(format!("notes-{id}-out.txt"));
    fs::write(&system_path, &system).map_err(|error| error.to_string())?;
    fs::write(&user_path, &user).map_err(|error| error.to_string())?;
    let predict = max_tokens.max(1);
    let mut command = Command::new(notes_bin(app_data).join(NOTES_ENGINE_EXE));
    command
        .current_dir(notes_bin(app_data))
        .arg("-m")
        .arg(notes_model_path(app_data))
        .arg("-c")
        .arg(NOTES_CONTEXT_TOKENS.to_string())
        .arg("-n")
        .arg(predict.to_string())
        .arg("--temp")
        .arg("0.2")
        .arg("-ngl")
        .arg("0")
        .arg("--jinja")
        .arg("--reasoning")
        .arg("off")
        .arg("--no-display-prompt")
        .arg("--no-show-timings")
        .arg("--no-warmup")
        .arg("--simple-io")
        .arg("--log-disable")
        .arg("-st")
        .arg("-sysf")
        .arg(&system_path)
        .arg("-f")
        .arg(&user_path)
        .arg("--output-file")
        .arg(&out_path);
    let run = Arc::new(NotesRun {
        job_id: job_id.to_string(),
        pid: Mutex::new(0),
        cancelled: Mutex::new(false),
    });
    if !job_id.is_empty() {
        *lock_mutex(notes_slot()) = Some(run.clone());
    }
    let stop = run.clone();
    let spawned = run.clone();
    // One section can spend longer than 15 minutes in CPU prompt processing and still be working.
    let ran = run_command_watched(
        command,
        Some(Duration::from_secs(60 * 60)),
        "The notes model stopped before it finished the notes.",
        &mut |_| {},
        &|| *lock_mutex(&stop.cancelled),
        &mut |pid| {
            *lock_mutex(&spawned.pid) = pid;
        },
    );
    if !job_id.is_empty() {
        let mut slot = lock_mutex(notes_slot());
        if slot.as_ref().map(|item| item.job_id.as_str()) == Some(job_id) {
            *slot = None;
        }
    }
    let output = fs::read_to_string(&out_path).unwrap_or_default();
    let _ = fs::remove_file(&system_path);
    let _ = fs::remove_file(&user_path);
    let _ = fs::remove_file(&out_path);
    if *lock_mutex(&run.cancelled) {
        return Err(NOTES_CANCELLED.into());
    }
    // llama writes the prompt into the output file before it generates. A timeout
    // still leaves that prompt on disk, and it is not a finished reply.
    if let Err(error) = ran {
        return Err(error);
    }
    let cleaned = clean_notes_reply(&output);
    if !cleaned.is_empty() {
        return Ok(cleaned);
    }
    Err("The notes model did not return study notes.".into())
}

fn run_command(command: Command, timeout: Duration, what: &str) -> Result<(), String> {
    run_command_watched(command, Some(timeout), what, &mut |_| {}, &|| false, &mut |_| {})
}

fn run_command_watched(
    mut command: Command,
    timeout: Option<Duration>,
    what: &str,
    on_progress: &mut dyn FnMut(u8),
    should_stop: &dyn Fn() -> bool,
    on_spawn: &mut dyn FnMut(u32),
) -> Result<(), String> {
    quiet(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if what.is_empty() {
            error.to_string()
        } else {
            format!("{what} {error}")
        }
    })?;
    on_spawn(child.id());
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read command output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read command output.".to_string())?;
    let (progress_tx, progress_rx) = mpsc::channel();
    let out_thread = thread::spawn(move || drain_tail(&mut stdout));
    let err_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut kept = String::new();
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if let Some(percent) = progress_percent(&line) {
                let _ = progress_tx.send(percent);
            }
            append_tail(&mut kept, &line);
        }
        kept
    });
    let started = Instant::now();
    let status = loop {
        while let Ok(percent) = progress_rx.try_recv() {
            on_progress(percent);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if should_stop() => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(REPLACED.into());
            }
            Ok(None) if timeout.is_some_and(|limit| started.elapsed() > limit) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(if what.is_empty() {
                    "That step took too long and was stopped.".into()
                } else {
                    format!("{what} That step took too long and was stopped.")
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => return Err(error.to_string()),
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    while let Ok(percent) = progress_rx.try_recv() {
        on_progress(percent);
    }
    if status.success() {
        return Ok(());
    }
    let detail = tail(&format!("{stderr}\n{stdout}"));
    if detail.is_empty() {
        Err(if what.is_empty() {
            format!("The command failed ({status}).")
        } else {
            format!("{what} The command failed ({status}).")
        })
    } else if what.is_empty() {
        Err(detail)
    } else {
        Err(format!("{what} {detail}"))
    }
}

fn drain_tail(reader: &mut dyn Read) -> String {
    let mut buf = vec![0u8; 8 * 1024];
    let mut out = Vec::new();
    loop {
        let Ok(read) = reader.read(&mut buf) else {
            break;
        };
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read]);
        if out.len() > 8 * 1024 {
            let drop = out.len() - 8 * 1024;
            out.drain(..drop);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn append_tail(tail: &mut String, line: &str) {
    if !tail.is_empty() {
        tail.push('\n');
    }
    tail.push_str(line.trim_end());
    let count = tail.chars().count();
    if count > 700 {
        *tail = tail.chars().skip(count - 700).collect();
    }
}

fn progress_percent(line: &str) -> Option<u8> {
    let marker = "progress =";
    let rest = line.split_once(marker)?.1.trim();
    let number = rest.trim_end_matches('%').trim();
    let value: u8 = number.parse().ok()?;
    if value > 100 {
        return None;
    }
    Some(value)
}

fn tail(text: &str) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= 700 {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - 700).collect()
}

fn prepend_path(dir: &Path) -> String {
    let mut path = dir.display().to_string();
    if let Some(existing) = std::env::var_os("PATH") {
        #[cfg(windows)]
        path.push(';');
        #[cfg(not(windows))]
        path.push(':');
        path.push_str(&existing.to_string_lossy());
    }
    path
}

fn probe_duration(ffprobe: &Path, media: &Path) -> Option<f64> {
    let mut command = Command::new(ffprobe);
    quiet(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(media)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let seconds: f64 = text.trim().parse().ok()?;
    if seconds.is_finite() && seconds > 0.0 {
        Some(seconds)
    } else {
        None
    }
}

fn wav_seconds(size: u64) -> Option<f64> {
    if size <= 44 {
        return None;
    }
    let seconds = (size - 44) as f64 / 32_000.0;
    if seconds.is_finite() && seconds > 0.0 {
        Some(seconds)
    } else {
        None
    }
}

/// Clearer uses half the logical processors, at least one.
/// Faster uses every logical processor.
pub(crate) fn whisper_thread_count(logical_cpus: usize, pace: &str) -> usize {
    let cpus = logical_cpus.max(1);
    if pace_name(pace) == "faster" {
        return cpus;
    }
    if cpus <= 1 {
        1
    } else {
        (cpus / 2).max(1)
    }
}

fn logical_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

/// No deadline. The old cap was duration × 20, clamped to 6 hours, and that
/// killed a 57-minute lecture overnight (`That step took too long and was stopped`).
fn whisper_wait_limit(_duration_seconds: Option<f64>) -> Option<Duration> {
    None
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_media(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[derive(Clone)]
struct Target {
    media: String,
    course_id: String,
    module_id: Option<String>,
    module_name: Option<String>,
}

fn same_job(a: &Target, b: &Target) -> bool {
    if normalize_media(&a.media) != normalize_media(&b.media) || a.course_id != b.course_id {
        return false;
    }
    let a_name = a.module_name.as_deref().map(str::trim).unwrap_or("");
    let b_name = b.module_name.as_deref().map(str::trim).unwrap_or("");
    let a_course = a.module_id.is_none() && a_name.is_empty();
    let b_course = b.module_id.is_none() && b_name.is_empty();
    if a_course || b_course {
        return a_course && b_course;
    }
    if let (Some(a_id), Some(b_id)) = (&a.module_id, &b.module_id) {
        return a_id == b_id;
    }
    !a_name.is_empty() && a_name.eq_ignore_ascii_case(b_name)
}

fn forward_percent(current: Option<u8>, next: u8) -> Option<u8> {
    if next > 100 {
        return current;
    }
    match current {
        Some(prev) if next < prev => Some(prev),
        _ => Some(next),
    }
}

/// Pids whose executable path or command line is this app's own tool.
/// `keep_pid` is the live transcription and is not stopped.
fn owned_pids_to_stop(snapshot: &str, own_executable: &str, keep_pid: Option<u32>) -> Vec<u32> {
    let own = normalize_media(own_executable).replace('"', "");
    if own.is_empty() {
        return Vec::new();
    }
    let mut pids = Vec::new();
    for line in snapshot.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.trim().parse::<u32>() else {
            continue;
        };
        if pid == 0 || Some(pid) == keep_pid {
            continue;
        }
        let executable = normalize_media(parts.next().unwrap_or("")).replace('"', "");
        let command = normalize_media(parts.next().unwrap_or("")).replace('"', "");
        if executable == own || command.contains(&own) {
            pids.push(pid);
        }
    }
    pids
}

fn own_whisper_exe(app_data: &Path) -> PathBuf {
    bin_dir(app_data).join(ENGINE_EXE)
}

fn own_ffmpeg_exe(app_data: &Path) -> PathBuf {
    bin_dir(app_data).join(exe_name("ffmpeg"))
}

fn process_snapshot() -> Result<String, String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            PROCESS_SNAPSHOT_SCRIPT,
        ]);
        quiet(&mut command);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            format!("Could not check for a running transcription. {error}")
        })?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() > Duration::from_secs(30) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Could not check for a running transcription.".into());
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(error) => return Err(error.to_string()),
            }
        };
        let mut stdout = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        if !status.success() {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            return Err(format!(
                "Could not check for a running transcription. {}",
                tail(&stderr)
            ));
        }
        return Ok(stdout);
    }
    #[cfg(not(windows))]
    {
        Ok(linux_process_snapshot())
    }
}

#[cfg(not(windows))]
fn linux_process_snapshot() -> String {
    let mut lines = String::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return lines;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let exe = fs::read_link(entry.path().join("exe"))
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let command = fs::read(entry.path().join("cmdline"))
            .map(|bytes| String::from_utf8_lossy(&bytes).replace('\u{0}', " "))
            .unwrap_or_default()
            .replace(['\t', '\n', '\r'], " ");
        lines.push_str(&format!("{pid}\t{exe}\t{command}\n"));
    }
    lines
}

fn pid_alive(pid: u32) -> bool {
    if pid <= 4 {
        return false;
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
        quiet(&mut command);
        let Ok(output) = command.output() else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let lower = text.to_ascii_lowercase();
        !lower.contains("no tasks") && text.contains(&pid.to_string())
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

/// Stop this app's whisper-cli. On Windows that is `taskkill /PID <pid> /F /T`
/// after the process list shows the executable is our own `bin\\whisper-cli.exe`.
/// The live job pid is left running so the same recording can resume.
fn kill_pid(pid: u32) {
    if pid <= 4 || pid == std::process::id() {
        return;
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/F", "/T"]);
        quiet(&mut command);
        let _ = command.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .output();
    }
}

fn stop_pids(pids: &[u32]) {
    for pid in pids {
        kill_pid(*pid);
    }
}

fn job_file(app_data: &Path) -> PathBuf {
    app_data.join("transcription-job.json")
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedJob {
    id: String,
    media_path: String,
    home: String,
    course_id: String,
    #[serde(default)]
    module_id: Option<String>,
    #[serde(default)]
    module_name: Option<String>,
    #[serde(default)]
    new_module_name: Option<String>,
    phase: String,
    label: String,
    #[serde(default)]
    percent: Option<u8>,
    #[serde(default)]
    pid: Option<u32>,
    stderr_path: String,
    stdout_path: String,
    json_path: String,
    wav_path: String,
    started_ms: u64,
    #[serde(default)]
    duration_seconds: Option<f64>,
    #[serde(default)]
    pace: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    transcribe_started_ms: u64,
    #[serde(default)]
    model: String,
}

fn saved_target(job: &SavedJob) -> Target {
    Target {
        media: job.media_path.clone(),
        course_id: job.course_id.clone(),
        module_id: job.module_id.clone(),
        module_name: job.module_name.clone(),
    }
}

fn read_saved(app_data: &Path) -> Option<SavedJob> {
    let text = fs::read_to_string(job_file(app_data)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_saved(app_data: &Path, job: &SavedJob) -> Result<(), String> {
    if let Some(parent) = job_file(app_data).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(job).map_err(|error| error.to_string())?;
    let temp = app_data.join("transcription-job.json.tmp");
    fs::write(&temp, format!("{text}\n")).map_err(|error| error.to_string())?;
    fs::rename(&temp, job_file(app_data)).map_err(|error| error.to_string())?;
    Ok(())
}

fn update_saved(app_data: &Path, id: &str, mutate: impl FnOnce(&mut SavedJob)) {
    let Some(mut job) = read_saved(app_data) else {
        return;
    };
    if job.id != id {
        return;
    }
    mutate(&mut job);
    let _ = write_saved(app_data, &job);
}

fn is_tmp_file(app_data: &Path, path: &str) -> bool {
    let tmp = app_data.join("tmp");
    Path::new(path).starts_with(&tmp)
}

fn saved_paths_usable(app_data: &Path, job: &SavedJob) -> bool {
    [&job.wav_path, &job.json_path, &job.stderr_path, &job.stdout_path]
        .iter()
        .all(|path| !path.is_empty() && is_tmp_file(app_data, path))
}

/// The extracted audio is worth keeping once ffmpeg has left the header behind.
fn wav_kept(job: &SavedJob) -> bool {
    if job.phase == "reading" {
        return false;
    }
    fs::metadata(&job.wav_path)
        .map(|meta| meta.is_file() && meta.len() > 44)
        .unwrap_or(false)
}

fn remove_work_files(app_data: &Path, job: &SavedJob) {
    for path in [&job.wav_path, &job.json_path, &job.stderr_path, &job.stdout_path] {
        if is_tmp_file(app_data, path) {
            let _ = fs::remove_file(path);
        }
    }
}

fn public_job(job: &SavedJob) -> Value {
    json!({
        "id": job.id,
        "jobId": job.id,
        "mediaPath": job.media_path,
        "home": job.home,
        "courseId": job.course_id,
        "moduleId": job.module_id,
        "moduleName": job.module_name,
        "newModuleName": job.new_module_name,
        "provider": "local",
        "phase": job.phase,
        "label": job.label,
        "percent": job.percent,
        "pace": if job.pace.is_empty() { "clearer" } else { job.pace.as_str() },
        "language": if job.language.is_empty() { "en" } else { job.language.as_str() },
        "transcribeStartedMs": if job.transcribe_started_ms == 0 { Value::Null } else { json!(job.transcribe_started_ms) },
    })
}

pub(crate) fn active_job_json(app_data: &Path) -> Value {
    read_saved(app_data)
        .map(|job| public_job(&job))
        .unwrap_or(Value::Null)
}

struct Flight {
    id: u64,
    job_id: String,
    target: Target,
    pid: Mutex<u32>,
    cancelled: Mutex<bool>,
    done: Mutex<Option<Result<Value, String>>>,
    cv: Condvar,
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl Flight {
    fn publish(&self, result: Result<Value, String>) {
        let mut done = lock_mutex(&self.done);
        if done.is_none() {
            *done = Some(result);
        }
        self.cv.notify_all();
    }

    fn wait(&self) -> Result<Value, String> {
        let mut done = lock_mutex(&self.done);
        while done.is_none() {
            done = self.cv.wait(done).unwrap_or_else(|error| error.into_inner());
        }
        done.clone().unwrap()
    }

    fn cancel(&self) {
        *lock_mutex(&self.cancelled) = true;
    }

    fn cancelled(&self) -> bool {
        *lock_mutex(&self.cancelled)
    }

    fn pid(&self) -> u32 {
        *lock_mutex(&self.pid)
    }

    fn set_pid(&self, pid: u32) {
        *lock_mutex(&self.pid) = pid;
    }
}

fn gate() -> &'static Mutex<Option<Arc<Flight>>> {
    static GATE: OnceLock<Mutex<Option<Arc<Flight>>>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(None))
}

fn lock_gate() -> std::sync::MutexGuard<'static, Option<Arc<Flight>>> {
    gate().lock().unwrap_or_else(|error| error.into_inner())
}

fn next_flight_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

enum Admission {
    Wait(Arc<Flight>),
    Own(Arc<Flight>),
}

fn admit(target: &Target, job_id: &str) -> Admission {
    loop {
        let mut guard = lock_gate();
        if let Some(flight) = guard.clone() {
            if same_job(&flight.target, target) && !flight.cancelled() {
                return Admission::Wait(flight);
            }
            flight.cancel();
            let pid = flight.pid();
            let flight_id = flight.id;
            drop(guard);
            if pid > 4 {
                kill_pid(pid);
            }
            let mut guard = lock_gate();
            if guard.as_ref().map(|item| item.id) == Some(flight_id) {
                *guard = None;
            }
            continue;
        }
        let flight = Arc::new(Flight {
            id: next_flight_id(),
            job_id: if job_id.is_empty() {
                format!("job-{}", now_ms())
            } else {
                job_id.to_string()
            },
            target: target.clone(),
            pid: Mutex::new(0),
            cancelled: Mutex::new(false),
            done: Mutex::new(None),
            cv: Condvar::new(),
        });
        *guard = Some(flight.clone());
        return Admission::Own(flight);
    }
}

enum ResumePlan {
    Attach(SavedJob),
    Reuse(SavedJob),
    Continue(SavedJob),
    Start,
}

fn json_ready(path: &str) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    parse_whisper_json(&raw).is_ok()
}

fn plan_resume(saved: Option<&SavedJob>, target: &Target, snapshot: &str, own_exe: &str) -> ResumePlan {
    let Some(saved) = saved else {
        return ResumePlan::Start;
    };
    if !same_job(&saved_target(saved), target) {
        return ResumePlan::Start;
    }
    if let Some(pid) = saved.pid {
        if owned_pids_to_stop(snapshot, own_exe, None).contains(&pid) {
            return ResumePlan::Attach(saved.clone());
        }
    }
    if json_ready(&saved.json_path) {
        return ResumePlan::Reuse(saved.clone());
    }
    ResumePlan::Continue(saved.clone())
}

/// On launch, stop leftover whisper-cli from this app. Keep the pid recorded
/// for the in-progress job when that process is still our whisper-cli.
pub(crate) fn reconcile_on_launch(app_data: &Path) -> Result<(), String> {
    let saved = read_saved(app_data);
    let snapshot = process_snapshot()?;
    let own = own_whisper_exe(app_data);
    let own_text = own.to_string_lossy().into_owned();
    let keep = saved.as_ref().and_then(|job| {
        let pid = job.pid?;
        if owned_pids_to_stop(&snapshot, &own_text, None).contains(&pid) {
            Some(pid)
        } else {
            None
        }
    });
    stop_pids(&owned_pids_to_stop(&snapshot, &own_text, keep));
    let ffmpeg = own_ffmpeg_exe(app_data);
    stop_pids(&owned_pids_to_stop(
        &snapshot,
        &ffmpeg.to_string_lossy(),
        None,
    ));
    if keep.is_none() {
        if let Some(mut job) = saved {
            job.pid = None;
            let _ = write_saved(app_data, &job);
        }
    }
    Ok(())
}

/// Stop this run. A partial transcript is removed. A finished transcript stays.
pub(crate) fn cancel_make_notes(app_data: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Ok(());
    }
    {
        let guard = lock_gate();
        if let Some(flight) = guard.as_ref() {
            if flight.job_id == id {
                flight.cancel();
                let pid = flight.pid();
                if pid > 4 {
                    kill_pid(pid);
                }
            }
        }
    }
    {
        let guard = lock_mutex(notes_slot());
        if let Some(run) = guard.as_ref() {
            if run.job_id == id {
                *lock_mutex(&run.cancelled) = true;
                let pid = *lock_mutex(&run.pid);
                if pid > 4 {
                    kill_pid(pid);
                }
            }
        }
    }
    if let Some(job) = read_saved(app_data) {
        if job.id == id && !json_ready(&job.json_path) {
            remove_work_files(app_data, &job);
            let _ = fs::remove_file(job_file(app_data));
        }
    }
    Ok(())
}

pub(crate) fn clear_job(app_data: &Path, id: &str) -> Result<(), String> {
    let finished = {
        let guard = lock_gate();
        guard
            .as_ref()
            .map(|flight| flight.job_id == id && lock_mutex(&flight.done).is_some())
            .unwrap_or(false)
    };
    if let Some(job) = read_saved(app_data) {
        if job.id == id {
            if let Some(pid) = job.pid {
                if !finished {
                    if let Ok(snapshot) = process_snapshot() {
                        let own = own_whisper_exe(app_data);
                        if owned_pids_to_stop(&snapshot, &own.to_string_lossy(), None).contains(&pid)
                        {
                            return Ok(());
                        }
                    }
                }
            }
            // Leave a partial transcript in place. The next launch continues it.
            // Cancel deletes that partial on its own.
            if json_ready(&job.json_path) {
                remove_work_files(app_data, &job);
                let _ = fs::remove_file(job_file(app_data));
            }
        }
    }
    let mut guard = lock_gate();
    if guard
        .as_ref()
        .map(|flight| flight.job_id == id)
        .unwrap_or(false)
    {
        *guard = None;
    }
    Ok(())
}

fn pull_progress(path: &Path, offset: u64, mut last: Option<u8>) -> (u64, Option<u8>, Option<u8>) {
    let Ok(mut file) = File::open(path) else {
        return (offset, last, None);
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return (offset, last, None);
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return (offset, last, None);
    }
    let usable = if buf.ends_with(b"\n") {
        buf.len()
    } else {
        buf.iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0)
    };
    if usable == 0 {
        return (offset, last, None);
    }
    let text = String::from_utf8_lossy(&buf[..usable]);
    let mut emitted = None;
    for line in text.lines() {
        let Some(percent) = progress_percent(line) else {
            continue;
        };
        let next = forward_percent(last, percent);
        if next != last {
            emitted = next;
            last = next;
        }
    }
    (offset + usable as u64, last, emitted)
}

fn transcript_value(duration: Option<f64>, elapsed_ms: u128, segments: &[Segment], model: &str) -> Value {
    json!({
        "segments": segments.iter().map(|segment| json!({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
        })).collect::<Vec<_>>(),
        "durationSeconds": duration,
        "elapsedMs": elapsed_ms as u64,
        "model": model,
    })
}

fn finish_transcript(job: &SavedJob) -> Result<Value, String> {
    let raw = fs::read_to_string(&job.json_path)
        .map_err(|_| "The speech model did not write a transcript.".to_string())?;
    let segments = parse_whisper_json(&raw)?;
    let elapsed_ms = now_ms().saturating_sub(job.started_ms) as u128;
    assert_heard(job.duration_seconds, elapsed_ms, &segments)?;
    let model = if job.model.is_empty() {
        model_spec(if job.pace.is_empty() { "clearer" } else { job.pace.as_str() }).name
    } else {
        job.model.as_str()
    };
    Ok(transcript_value(job.duration_seconds, elapsed_ms, &segments, model))
}

fn stopped(flight: &Flight) -> Result<(), String> {
    if flight.cancelled() {
        Err(REPLACED.into())
    } else {
        Ok(())
    }
}

pub(crate) struct TranscribeRequest {
    pub job_id: String,
    pub home: String,
    pub course_id: String,
    pub module_id: Option<String>,
    pub module_name: Option<String>,
    pub new_module_name: Option<String>,
    pub pace: String,
    pub language: String,
}

pub(crate) fn transcribe_json(
    app_data: &Path,
    media: &str,
    request: &TranscribeRequest,
    progress: &mut dyn FnMut(&str, &str, Option<u8>, Option<u64>),
) -> Result<Value, String> {
    let status = collect_status(app_data, &request.pace)?;
    if !status.ready {
        return Err(SETUP_REQUIRED.into());
    }
    let target = Target {
        media: media.to_string(),
        course_id: request.course_id.clone(),
        module_id: nonempty(request.module_id.as_deref()),
        module_name: nonempty(request.module_name.as_deref()),
    };
    match admit(&target, &request.job_id) {
        Admission::Wait(flight) => {
            let keep = flight.pid();
            if keep > 4 {
                if let Ok(snapshot) = process_snapshot() {
                    let own = own_whisper_exe(app_data);
                    stop_pids(&owned_pids_to_stop(
                        &snapshot,
                        &own.to_string_lossy(),
                        Some(keep),
                    ));
                }
            }
            flight.wait()
        }
        Admission::Own(flight) => {
            let result = run_owned(app_data, media, request, &flight, progress);
            let cancelled = flight.cancelled();
            flight.publish(result.clone());
            if result.is_err() && !cancelled {
                let mut guard = lock_gate();
                if guard.as_ref().map(|item| item.id) == Some(flight.id) {
                    *guard = None;
                }
            }
            result
        }
    }
}

fn run_owned(
    app_data: &Path,
    media: &str,
    request: &TranscribeRequest,
    flight: &Arc<Flight>,
    progress: &mut dyn FnMut(&str, &str, Option<u8>, Option<u64>),
) -> Result<Value, String> {
    stopped(flight)?;
    let snapshot = process_snapshot()?;
    let own = own_whisper_exe(app_data);
    let own_text = own.to_string_lossy().into_owned();
    let saved = read_saved(app_data);
    match plan_resume(saved.as_ref(), &flight.target, &snapshot, &own_text) {
        ResumePlan::Attach(job) => {
            let pid = job.pid.ok_or_else(|| "The transcription process is gone.".to_string())?;
            stop_pids(&owned_pids_to_stop(&snapshot, &own_text, Some(pid)));
            let ffmpeg = own_ffmpeg_exe(app_data);
            stop_pids(&owned_pids_to_stop(
                &snapshot,
                &ffmpeg.to_string_lossy(),
                None,
            ));
            flight.set_pid(pid);
            let mut job = job;
            job.id = flight.job_id.clone();
            write_saved(app_data, &job)?;
            let started = if job.transcribe_started_ms > 0 {
                Some(job.transcribe_started_ms)
            } else {
                None
            };
            if let Some(percent) = job.percent {
                progress("transcribing", "Transcribing the recording", Some(percent), started);
            }
            if let Err(error) = wait_for_pid(pid, Path::new(&job.stderr_path), flight, job.percent, |percent| {
                progress("transcribing", "Transcribing the recording", Some(percent), started);
                update_saved(app_data, &job.id, |saved| {
                    saved.phase = "transcribing".into();
                    saved.label = "Transcribing the recording".into();
                    saved.percent = forward_percent(saved.percent, percent);
                });
            }) {
                if !(flight.cancelled() && json_ready(&job.json_path)) {
                    return Err(error);
                }
            }
            if flight.cancelled() && !json_ready(&job.json_path) {
                return Err(REPLACED.into());
            }
            let mut done = read_saved(app_data).unwrap_or(job);
            done.pid = None;
            done.phase = "writing".into();
            done.percent = Some(100);
            write_saved(app_data, &done)?;
            progress(
                "transcribing",
                "Transcribing the recording",
                Some(100),
                started,
            );
            finish_transcript(&done)
        }
        ResumePlan::Reuse(mut job) => {
            stop_pids(&owned_pids_to_stop(&snapshot, &own_text, None));
            let ffmpeg = own_ffmpeg_exe(app_data);
            stop_pids(&owned_pids_to_stop(
                &snapshot,
                &ffmpeg.to_string_lossy(),
                None,
            ));
            job.id = flight.job_id.clone();
            job.pid = None;
            job.phase = "writing".into();
            job.percent = Some(100);
            write_saved(app_data, &job)?;
            progress("transcribing", "Transcribing the recording", Some(100), None);
            finish_transcript(&job)
        }
        ResumePlan::Continue(job) => {
            stop_pids(&owned_pids_to_stop(&snapshot, &own_text, None));
            let ffmpeg_path = own_ffmpeg_exe(app_data);
            stop_pids(&owned_pids_to_stop(
                &snapshot,
                &ffmpeg_path.to_string_lossy(),
                None,
            ));
            continue_saved(app_data, media, request, flight, progress, job)
        }
        ResumePlan::Start => {
            stop_pids(&owned_pids_to_stop(&snapshot, &own_text, None));
            let ffmpeg_path = own_ffmpeg_exe(app_data);
            stop_pids(&owned_pids_to_stop(
                &snapshot,
                &ffmpeg_path.to_string_lossy(),
                None,
            ));
            if let Some(old) = saved {
                if old.id != flight.job_id {
                    remove_work_files(app_data, &old);
                }
            }
            start_fresh(app_data, media, request, flight, progress)
        }
    }
}

fn start_fresh(
    app_data: &Path,
    media: &str,
    request: &TranscribeRequest,
    flight: &Arc<Flight>,
    progress: &mut dyn FnMut(&str, &str, Option<u8>, Option<u64>),
) -> Result<Value, String> {
    stopped(flight)?;
    let ffmpeg = tool_path(app_data, "ffmpeg").ok_or_else(|| SETUP_REQUIRED.to_string())?;
    let ffprobe = tool_path(app_data, "ffprobe").ok_or_else(|| SETUP_REQUIRED.to_string())?;
    let tmp = app_data.join("tmp");
    fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let work = format!("{}-{}", std::process::id(), now_ms());
    let wav = tmp.join(format!("{work}.wav"));
    let json_base = tmp.join(&work);
    let json_path = tmp.join(format!("{work}.json"));
    let stderr_path = tmp.join(format!("{work}.stderr"));
    let stdout_path = tmp.join(format!("{work}.stdout"));
    let job = SavedJob {
        id: flight.job_id.clone(),
        media_path: media.to_string(),
        home: request.home.clone(),
        course_id: request.course_id.clone(),
        module_id: nonempty(request.module_id.as_deref()),
        module_name: nonempty(request.module_name.as_deref()),
        new_module_name: nonempty(request.new_module_name.as_deref()),
        phase: "reading".into(),
        label: "Reading the recording".into(),
        percent: None,
        pid: None,
        stderr_path: stderr_path.to_string_lossy().into_owned(),
        stdout_path: stdout_path.to_string_lossy().into_owned(),
        json_path: json_path.to_string_lossy().into_owned(),
        wav_path: wav.to_string_lossy().into_owned(),
        started_ms: now_ms(),
        duration_seconds: None,
        pace: pace_name(&request.pace).to_string(),
        language: {
            let code = request.language.trim();
            if code.is_empty() { "en".to_string() } else { code.to_string() }
        },
        transcribe_started_ms: 0,
        model: model_spec(&request.pace).name.to_string(),
    };
    write_saved(app_data, &job)?;
    progress("reading", "Reading the recording", None, None);
    let mut convert = Command::new(&ffmpeg);
    convert.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        media,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-vn",
    ]);
    convert.arg(&wav);
    let flight_stop = flight.clone();
    let flight_spawn = flight.clone();
    let app_data_spawn = app_data.to_path_buf();
    let job_id = flight.job_id.clone();
    let converted = run_command_watched(
        convert,
        Some(Duration::from_secs(2 * 60 * 60)),
        "Could not read that recording.",
        &mut |_| {},
        &|| flight_stop.cancelled(),
        &mut |pid| {
            flight_spawn.set_pid(pid);
            update_saved(&app_data_spawn, &job_id, |saved| {
                saved.pid = Some(pid);
            });
        },
    );
    if let Err(error) = converted {
        flight.set_pid(0);
        return Err(error);
    }
    stopped(flight)?;
    transcribe_prepared_wav(
        app_data,
        flight,
        progress,
        job,
        &ffprobe,
        &wav,
        &json_base,
        &json_path,
        &stderr_path,
        &stdout_path,
    )
}

/// Keep the extracted audio and the job files, then finish the transcript.
fn continue_saved(
    app_data: &Path,
    media: &str,
    request: &TranscribeRequest,
    flight: &Arc<Flight>,
    progress: &mut dyn FnMut(&str, &str, Option<u8>, Option<u64>),
    mut job: SavedJob,
) -> Result<Value, String> {
    stopped(flight)?;
    if !saved_paths_usable(app_data, &job) {
        return start_fresh(app_data, media, request, flight, progress);
    }
    let ffmpeg = tool_path(app_data, "ffmpeg").ok_or_else(|| SETUP_REQUIRED.to_string())?;
    let ffprobe = tool_path(app_data, "ffprobe").ok_or_else(|| SETUP_REQUIRED.to_string())?;
    let keep_wav = wav_kept(&job);
    let wav = PathBuf::from(&job.wav_path);
    let json_path = PathBuf::from(&job.json_path);
    let json_base = json_path.with_extension("");
    let stderr_path = PathBuf::from(&job.stderr_path);
    let stdout_path = PathBuf::from(&job.stdout_path);
    let language = {
        let code = request.language.trim();
        if !code.is_empty() {
            code.to_string()
        } else if job.language.trim().is_empty() {
            "en".to_string()
        } else {
            job.language.clone()
        }
    };
    job.id = flight.job_id.clone();
    job.media_path = media.to_string();
    job.home = request.home.clone();
    job.course_id = request.course_id.clone();
    job.module_id = nonempty(request.module_id.as_deref());
    job.module_name = nonempty(request.module_name.as_deref());
    job.new_module_name = nonempty(request.new_module_name.as_deref());
    job.phase = if keep_wav { "transcribing" } else { "reading" }.into();
    job.label = if keep_wav {
        "Transcribing the recording"
    } else {
        "Reading the recording"
    }
    .into();
    if !keep_wav {
        job.percent = None;
    }
    job.pid = None;
    job.pace = pace_name(&request.pace).to_string();
    job.language = language;
    job.model = model_spec(&request.pace).name.to_string();
    write_saved(app_data, &job)?;
    if !keep_wav {
        progress("reading", "Reading the recording", None, None);
        let mut convert = Command::new(&ffmpeg);
        convert.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            media,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "-vn",
        ]);
        convert.arg(&wav);
        let flight_stop = flight.clone();
        let flight_spawn = flight.clone();
        let app_data_spawn = app_data.to_path_buf();
        let job_id = flight.job_id.clone();
        let converted = run_command_watched(
            convert,
            Some(Duration::from_secs(2 * 60 * 60)),
            "Could not read that recording.",
            &mut |_| {},
            &|| flight_stop.cancelled(),
            &mut |pid| {
                flight_spawn.set_pid(pid);
                update_saved(&app_data_spawn, &job_id, |saved| {
                    saved.pid = Some(pid);
                });
            },
        );
        if let Err(error) = converted {
            flight.set_pid(0);
            return Err(error);
        }
        stopped(flight)?;
    }
    transcribe_prepared_wav(
        app_data,
        flight,
        progress,
        job,
        &ffprobe,
        &wav,
        &json_base,
        &json_path,
        &stderr_path,
        &stdout_path,
    )
}

fn transcribe_prepared_wav(
    app_data: &Path,
    flight: &Arc<Flight>,
    progress: &mut dyn FnMut(&str, &str, Option<u8>, Option<u64>),
    job: SavedJob,
    ffprobe: &Path,
    wav: &Path,
    json_base: &Path,
    json_path: &Path,
    stderr_path: &Path,
    stdout_path: &Path,
) -> Result<Value, String> {
    let pace = job.pace.clone();
    let language = if job.language.trim().is_empty() {
        "en".to_string()
    } else {
        job.language.trim().to_string()
    };
    let duration = probe_duration(ffprobe, wav).or_else(|| {
        fs::metadata(wav)
            .ok()
            .and_then(|meta| wav_seconds(meta.len()))
    });
    update_saved(app_data, &flight.job_id, |saved| {
        saved.duration_seconds = duration;
        saved.pid = None;
    });
    stopped(flight)?;
    let own = own_whisper_exe(app_data);
    let own_text = own.to_string_lossy().into_owned();
    let snapshot = process_snapshot()?;
    stop_pids(&owned_pids_to_stop(&snapshot, &own_text, None));
    let still = owned_pids_to_stop(&process_snapshot()?, &own_text, None);
    if !still.is_empty() {
        stop_pids(&still);
        let still = owned_pids_to_stop(&process_snapshot()?, &own_text, None);
        if !still.is_empty() {
            return Err("A transcription is already running. Wait for it to finish.".into());
        }
    }
    let bin = bin_dir(app_data);
    let stderr = File::create(stderr_path).map_err(|error| error.to_string())?;
    let stdout = File::create(stdout_path).map_err(|error| error.to_string())?;
    let mut whisper = Command::new(bin.join(ENGINE_EXE));
    quiet(&mut whisper);
    whisper
        .current_dir(&bin)
        .env("PATH", prepend_path(&bin))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .arg("-m")
        .arg(model_path(app_data, &pace))
        .arg("-f")
        .arg(wav)
        .arg("-l")
        .arg(&language)
        .arg("-t")
        .arg(whisper_thread_count(logical_cpus(), &pace).to_string())
        .arg("-oj")
        .arg("-of")
        .arg(json_base)
        .arg("-np")
        .arg("-pp")
        .arg("-ng");
    let _ = whisper_wait_limit(duration);
    let mut child = whisper.spawn().map_err(|error| {
        format!("Could not transcribe that recording. {error}")
    })?;
    let pid = child.id();
    flight.set_pid(pid);
    let transcribe_started = now_ms();
    let shown = job.percent.unwrap_or(0);
    update_saved(app_data, &flight.job_id, |saved| {
        saved.phase = "transcribing".into();
        saved.label = "Transcribing the recording".into();
        saved.pid = Some(pid);
        saved.duration_seconds = duration;
        saved.transcribe_started_ms = transcribe_started;
    });
    progress(
        "transcribing",
        "Transcribing the recording",
        Some(shown),
        Some(transcribe_started),
    );
    let waited = wait_child(&mut child, stderr_path, flight, |percent| {
        progress(
            "transcribing",
            "Transcribing the recording",
            Some(percent),
            Some(transcribe_started),
        );
        update_saved(app_data, &flight.job_id, |saved| {
            saved.percent = forward_percent(saved.percent, percent);
        });
    });
    flight.set_pid(0);
    if let Err(error) = waited {
        let ready = json_ready(&json_path.to_string_lossy());
        if !(flight.cancelled() && ready) {
            return Err(error);
        }
    }
    if flight.cancelled() && !json_ready(&json_path.to_string_lossy()) {
        return Err(REPLACED.into());
    }
    let mut done = read_saved(app_data).unwrap_or(job);
    done.pid = None;
    done.phase = "writing".into();
    done.percent = Some(100);
    done.duration_seconds = duration;
    write_saved(app_data, &done)?;
    progress(
        "transcribing",
        "Transcribing the recording",
        Some(100),
        Some(transcribe_started),
    );
    finish_transcript(&done)
}

fn wait_child(
    child: &mut std::process::Child,
    stderr_path: &Path,
    flight: &Flight,
    mut on_progress: impl FnMut(u8),
) -> Result<(), String> {
    let mut offset = 0u64;
    let mut last = None;
    loop {
        if flight.cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(REPLACED.into());
        }
        let pulled = pull_progress(stderr_path, offset, last);
        offset = pulled.0;
        last = pulled.1;
        if let Some(percent) = pulled.2 {
            on_progress(percent);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let pulled = pull_progress(stderr_path, offset, last);
                if let Some(percent) = pulled.2 {
                    on_progress(percent);
                }
                if status.success() {
                    return Ok(());
                }
                let detail = fs::read_to_string(stderr_path).unwrap_or_default();
                let message = tail(&detail);
                if message.is_empty() {
                    return Err(format!(
                        "Could not transcribe that recording. The command failed ({status})."
                    ));
                }
                return Err(format!("Could not transcribe that recording. {message}"));
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn wait_for_pid(
    pid: u32,
    stderr_path: &Path,
    flight: &Flight,
    mut last: Option<u8>,
    mut on_progress: impl FnMut(u8),
) -> Result<(), String> {
    let mut offset = 0u64;
    let mut ticks = 0u32;
    loop {
        if flight.cancelled() {
            kill_pid(pid);
            return Err(REPLACED.into());
        }
        let pulled = pull_progress(stderr_path, offset, last);
        offset = pulled.0;
        last = pulled.1;
        if let Some(percent) = pulled.2 {
            on_progress(percent);
        }
        ticks = ticks.wrapping_add(1);
        if ticks % 10 == 0 && !pid_alive(pid) {
            let pulled = pull_progress(stderr_path, offset, last);
            if let Some(percent) = pulled.2 {
                on_progress(percent);
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn strip_tokens(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<|") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 2..].find("|>") {
            rest = &rest[start + 2 + end + 2..];
        } else {
            out.push_str(&rest[start..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn clean_text(text: &str) -> String {
    let cleaned = strip_tokens(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() || is_non_speech(&cleaned) {
        String::new()
    } else {
        cleaned
    }
}

fn is_non_speech(text: &str) -> bool {
    matches!(
        text.to_ascii_lowercase().as_str(),
        "[blank_audio]"
            | "[music]"
            | "[noise]"
            | "[silence]"
            | "[laughter]"
            | "[applause]"
            | "(blank audio)"
            | "(silence)"
            | "(music)"
            | "(noise)"
            | "(laughter)"
            | "(applause)"
            | "♪"
    )
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|number| number as f64))
        .or_else(|| value.as_u64().map(|number| number as f64))
}

fn timestamp_seconds(value: Option<&Value>) -> Option<f64> {
    let text = value?.as_str()?.trim();
    let (body, frac) = text
        .split_once(',')
        .or_else(|| text.split_once('.'))
        .unwrap_or((text, "0"));
    let mut parts = body.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let mut digits = frac
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .take(3)
        .collect::<String>();
    while digits.len() < 3 {
        digits.push('0');
    }
    let millis: f64 = digits.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds + millis / 1000.0)
}

fn segment_bounds(item: &Value) -> Option<(f64, f64)> {
    let from_ms = number_of(item.pointer("/offsets/from"));
    let to_ms = number_of(item.pointer("/offsets/to"));
    if let (Some(from_ms), Some(to_ms)) = (from_ms, to_ms) {
        return Some((from_ms / 1000.0, to_ms / 1000.0));
    }
    let start = timestamp_seconds(item.pointer("/timestamps/from"));
    let end = timestamp_seconds(item.pointer("/timestamps/to"));
    Some((start?, end?))
}

fn parse_whisper_json(raw: &str) -> Result<Vec<Segment>, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| "The speech model did not write a transcript.".to_string())?;
    let items = value
        .get("transcription")
        .and_then(Value::as_array)
        .ok_or_else(|| "The speech model did not write a transcript.".to_string())?;
    let mut segments = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .map(clean_text)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let Some((start, end)) = segment_bounds(item) else {
            continue;
        };
        if end < start {
            continue;
        }
        segments.push(Segment { start, end, text });
    }
    Ok(segments)
}

fn assert_heard(
    duration: Option<f64>,
    elapsed_ms: u128,
    segments: &[Segment],
) -> Result<(), String> {
    if segments
        .iter()
        .all(|segment| segment.text.trim().is_empty())
    {
        return Err("No speech was found in that recording.".into());
    }
    if let Some(duration) = duration {
        if duration >= LONG_RECORDING_SECONDS && elapsed_ms < MIN_LONG_ELAPSED_MS {
            return Err(
                "Transcription finished before the speech model could have heard this recording."
                    .into(),
            );
        }
    }
    Ok(())
}

const CLOUD_CHUNK_BYTES: u64 = 20 * 1024 * 1024;
const CLOUD_CHUNK_SECONDS: u64 = 540;

fn direct_cloud_audio(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp3" | "m4a" | "wav" | "flac" | "ogg" | "opus" | "webm" | "mp4" | "mpeg" | "mpg" | "mpga" | "aac"
    )
}

pub(crate) fn prepare_cloud_audio(app_data: &Path, media: &str) -> Result<Value, String> {
    let path = Path::new(media);
    let meta = fs::metadata(path).map_err(|error| error.to_string())?;
    if meta.is_file() && meta.len() > 0 && meta.len() <= CLOUD_CHUNK_BYTES && direct_cloud_audio(path) {
        return Ok(json!({
            "temporaryDirectory": null,
            "chunks": [{ "path": media, "startSeconds": 0 }],
        }));
    }
    let ffmpeg = tool_path(app_data, "ffmpeg").ok_or_else(|| {
        "This recording has to be prepared with ffmpeg. Press Set up local notes once, then try Cloud again."
            .to_string()
    })?;
    let directory = app_data
        .join("tmp")
        .join(format!("groq-{}-{}", std::process::id(), now_ms()));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let pattern = directory.join("chunk_%03d.wav");
    let mut command = Command::new(ffmpeg);
    quiet(&mut command);
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        media,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "segment",
        "-segment_time",
        &CLOUD_CHUNK_SECONDS.to_string(),
        "-reset_timestamps",
        "1",
    ]);
    command.arg(&pattern);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Could not prepare that recording. {}", detail.trim()));
    }
    let mut names = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.to_ascii_lowercase().ends_with(".wav"))
        .collect::<Vec<_>>();
    names.sort();
    if names.is_empty() {
        return Err("Could not prepare that recording for Groq.".into());
    }
    let chunks = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            json!({
                "path": directory.join(name).to_string_lossy(),
                "startSeconds": index as u64 * CLOUD_CHUNK_SECONDS,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "temporaryDirectory": directory.to_string_lossy(),
        "chunks": chunks,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        assert_heard, clean_notes_reply, forward_percent, owned_pids_to_stop, parse_whisper_json,
        collect_status, plan_resume, progress_percent, same_job, setup_label, speech_models_for_setup,
        whisper_thread_count, whisper_wait_limit,
        NOTES_ENGINE_VERSION, NOTES_ENGINE_ZIP_BYTES, NOTES_MODEL_BYTES, NOTES_MODEL_FILE,
        NOTES_MODEL_NAME, NOTES_MODEL_SHA256, ResumePlan, SavedJob, Segment, Target,
    };

    #[test]
    fn notes_model_is_qwen_and_replies_drop_engine_logs() {
        assert_eq!(NOTES_MODEL_NAME, "Qwen2.5-7B-Instruct");
        assert_eq!(NOTES_MODEL_FILE, "qwen2.5-7b-instruct-q4_k_m.gguf");
        assert_eq!(NOTES_MODEL_BYTES, 4_683_074_240);
        assert_eq!(
            NOTES_MODEL_SHA256,
            "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423"
        );
        assert_eq!(NOTES_ENGINE_VERSION, "b10599");
        assert_eq!(NOTES_ENGINE_ZIP_BYTES, 18_061_865);
        assert_eq!(
            clean_notes_reply("llama_print_timings: load\n## Cells\n\n- Mitosis.<|im_end|>\n"),
            "## Cells\n\n- Mitosis."
        );
        assert_eq!(
            clean_notes_reply(
                "User:\nTranscript:\n[1:00] To my beloved ones,\n[14:16] She was given the glad tidings.\n\nAssistant:\nKey points.\n[2:00] Still copied.\n"
            ),
            "- Key points."
        );
        assert_eq!(
            clean_notes_reply(
                "## 1:00 to 14:16\n\nKey points from the lecture:\n\n1. Abu Talib died in the 10th year.\n2. Khadija died at 14:16.\nSee this point in the recording.\n"
            ),
            "- Key points from the lecture:\n\n- Abu Talib died in the 10th year.\n- Khadija died.\n- See."
        );
    }

    #[test]
    fn reads_timed_speech_and_drops_non_speech() {
        let raw = r#"{
          "transcription": [
            {
              "offsets": { "from": 0, "to": 2480 },
              "text": " Mitosis begins when the cell divides."
            },
            { "offsets": { "from": 2480, "to": 4000 }, "text": " [BLANK_AUDIO]" }
          ]
        }"#;
        let segments = parse_whisper_json(raw).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Mitosis begins when the cell divides.");
        assert!((segments[0].end - 2.48).abs() < 0.001);
    }

    #[test]
    fn a_57_minute_recording_is_not_stopped_for_time() {
        assert!(whisper_wait_limit(Some(57.0 * 60.0)).is_none());
        assert!(whisper_wait_limit(None).is_none());
    }

    #[test]
    fn whisper_threads_leave_processors_free() {
        assert_eq!(whisper_thread_count(1, "clearer"), 1);
        assert_eq!(whisper_thread_count(2, "clearer"), 1);
        assert_eq!(whisper_thread_count(4, "clearer"), 2);
        assert_eq!(whisper_thread_count(8, "clearer"), 4);
        assert!(whisper_thread_count(4, "clearer") < 4);
        assert_eq!(whisper_thread_count(4, "faster"), 4);
        assert_eq!(whisper_thread_count(8, "faster"), 8);
        assert!(whisper_thread_count(8, "faster") > whisper_thread_count(8, "clearer"));
    }

    fn lecture() -> Target {
        Target {
            media: r"D:\Lectures\ISC 102 U01.mp3".into(),
            course_id: "isc-102".into(),
            module_id: None,
            module_name: None,
        }
    }

    #[test]
    fn same_recording_and_course_or_module_resumes() {
        let lecture = lecture();
        let mut other_path = lecture.clone();
        other_path.media = "d:/lectures/isc 102 u01.mp3".into();
        assert!(same_job(&lecture, &other_path));
        let mut module = lecture.clone();
        module.module_name = Some("Cells".into());
        assert!(!same_job(&lecture, &module));
        let mut listed = module.clone();
        listed.module_id = Some("module-1".into());
        assert!(same_job(&module, &listed));
        let mut labs = listed.clone();
        labs.module_id = Some("module-2".into());
        labs.module_name = Some("Labs".into());
        assert!(!same_job(&listed, &labs));
        let mut next_file = lecture.clone();
        next_file.media = r"D:\Lectures\ISC 102 U02.mp3".into();
        assert!(!same_job(&lecture, &next_file));
    }

    #[test]
    fn stops_leftover_whisper_from_this_app_and_keeps_the_live_pid() {
        let own = r"C:\Users\A\AppData\Local\Study Notes\bin\whisper-cli.exe";
        let snapshot = format!(
            "11\t{own}\t{own} -m model\n22\t{own}\t{own} -m model\n33\t{own}\t{own} -m model\n44\t{own}\t{own} -m model\n55\t{own}\t{own} -m model\n66\tC:\\tools\\whisper-cli.exe\tC:\\tools\\whisper-cli.exe -m model\n77\tC:\\Windows\\System32\\notepad.exe\tnotepad\n"
        );
        assert_eq!(
            owned_pids_to_stop(&snapshot, own, Some(11)),
            vec![22, 33, 44, 55]
        );
        assert_eq!(
            owned_pids_to_stop(&snapshot, own, None),
            vec![11, 22, 33, 44, 55]
        );
    }

    #[test]
    fn attaches_to_the_same_job_and_starts_fresh_when_the_module_differs() {
        let own = r"C:\Users\A\AppData\Local\Study Notes\bin\whisper-cli.exe";
        let snapshot = format!("11\t{own}\t{own} -m model\n");
        let saved = SavedJob {
            id: "job".into(),
            media_path: r"D:\Lectures\ISC 102 U01.mp3".into(),
            home: r"D:\Notes".into(),
            course_id: "isc-102".into(),
            module_id: None,
            module_name: None,
            new_module_name: None,
            phase: "transcribing".into(),
            label: "Transcribing the recording".into(),
            percent: Some(15),
            pid: Some(11),
            stderr_path: "stderr".into(),
            stdout_path: "stdout".into(),
            json_path: "missing.json".into(),
            wav_path: "audio.wav".into(),
            started_ms: 1,
            duration_seconds: Some(57.0 * 60.0),
            pace: "clearer".into(),
            language: "en".into(),
            transcribe_started_ms: 1,
            model: "ggml-base.en".into(),
        };
        assert!(matches!(
            plan_resume(Some(&saved), &lecture(), &snapshot, own),
            ResumePlan::Attach(_)
        ));
        let mut other = lecture();
        other.module_name = Some("Cells".into());
        assert!(matches!(
            plan_resume(Some(&saved), &other, &snapshot, own),
            ResumePlan::Start
        ));
        let mut gone = saved.clone();
        gone.pid = None;
        assert!(matches!(
            plan_resume(Some(&gone), &lecture(), "", own),
            ResumePlan::Continue(_)
        ));
        gone.pid = Some(99);
        assert!(matches!(
            plan_resume(Some(&gone), &lecture(), "", own),
            ResumePlan::Continue(_)
        ));
    }

    #[test]
    fn keeps_extracted_audio_when_whisper_has_stopped() {
        let root = std::env::temp_dir().join(format!("study-notes-continue-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let tmp = root.join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let wav = tmp.join("work.wav");
        std::fs::write(&wav, vec![0u8; 45]).unwrap();
        let job = SavedJob {
            id: "job".into(),
            media_path: r"D:\Lectures\ISC 102 U01.mp3".into(),
            home: root.to_string_lossy().into_owned(),
            course_id: "isc-102".into(),
            module_id: None,
            module_name: None,
            new_module_name: None,
            phase: "transcribing".into(),
            label: "Transcribing the recording".into(),
            percent: Some(15),
            pid: None,
            stderr_path: tmp.join("work.stderr").to_string_lossy().into_owned(),
            stdout_path: tmp.join("work.stdout").to_string_lossy().into_owned(),
            json_path: tmp.join("work.json").to_string_lossy().into_owned(),
            wav_path: wav.to_string_lossy().into_owned(),
            started_ms: 1,
            duration_seconds: None,
            pace: "clearer".into(),
            language: "en".into(),
            transcribe_started_ms: 1,
            model: "ggml-base.en".into(),
        };
        assert!(super::saved_paths_usable(&root, &job));
        assert!(super::wav_kept(&job));
        let mut reading = job.clone();
        reading.phase = "reading".into();
        assert!(!super::wav_kept(&reading));
        std::fs::write(&wav, vec![0u8; 44]).unwrap();
        assert!(!super::wav_kept(&job));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn progress_from_one_process_does_not_go_backward() {
        assert_eq!(forward_percent(Some(30), 15), Some(30));
        assert_eq!(forward_percent(Some(15), 30), Some(30));
        assert_eq!(forward_percent(None, 15), Some(15));
    }

    #[test]
    fn reads_whisper_progress_percent() {
        assert_eq!(
            progress_percent("whisper_print_progress_callback: progress =   5%"),
            Some(5)
        );
        assert_eq!(
            progress_percent("whisper_print_progress_callback: progress = 100%"),
            Some(100)
        );
        assert_eq!(progress_percent("no progress here"), None);
    }

    #[test]
    fn fifty_seven_minutes_cannot_finish_in_under_a_minute() {
        let segments = vec![Segment {
            start: 0.0,
            end: 57.0 * 60.0,
            text: "A fake line.".into(),
        }];
        let error = assert_heard(Some(57.0 * 60.0), 59_000, &segments).unwrap_err();
        assert!(error.contains("could have heard"), "{error}");
        assert_heard(Some(57.0 * 60.0), 90_000, &segments).unwrap();
    }

    #[test]
    fn setup_downloads_only_the_selected_speech_model() {
        let faster = speech_models_for_setup("faster");
        let clearer = speech_models_for_setup("clearer");
        assert_eq!(faster.len(), 1);
        assert_eq!(clearer.len(), 1);
        assert_eq!(faster[0].file, "ggml-tiny.en.bin");
        assert_eq!(clearer[0].file, "ggml-base.en.bin");
        assert_ne!(faster[0].file, clearer[0].file);
        assert_eq!(setup_label("model"), "Downloading the speech model");
        assert_eq!(setup_label("notes"), "Downloading the notes model");
        for phase in ["ffmpeg", "engine", "model", "notesEngine", "notes", "config"] {
            let label = setup_label(phase);
            assert!(!label.contains("ggml"));
            assert!(!label.contains(".bin"));
            assert!(!label.contains(".gguf"));
        }
        let root = std::env::temp_dir().join(format!("study-notes-pace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("models")).unwrap();
        std::fs::write(root.join("models").join("ggml-tiny.en.bin"), b"not the model").unwrap();
        let faster_status = collect_status(&root, "faster").unwrap();
        let clearer_status = collect_status(&root, "clearer").unwrap();
        assert!(faster_status.missing.contains(&"model"));
        assert!(clearer_status.missing.contains(&"model"));
        assert!(!faster_status.ready);
        assert!(!clearer_status.ready);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn downloads_speech_model_and_transcribes() {
        let root = std::env::temp_dir().join(format!("study notes runtime {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let status = super::setup_local(&root, "clearer", &mut |phase, label, received, total| {
            if received == 0 || total.map(|value| received >= value).unwrap_or(false) {
                eprintln!("{phase} {label} {received}/{total:?}");
            }
        })
        .unwrap();
        assert_eq!(status["ready"], true);
        assert_eq!(status["model"], "ggml-base.en");
        let wav = root.join("sample.wav");
        synthesize(&wav).unwrap();
        let request = super::TranscribeRequest {
            job_id: "job".into(),
            home: root.to_string_lossy().into_owned(),
            course_id: "course".into(),
            module_id: None,
            module_name: None,
            new_module_name: None,
            pace: "clearer".into(),
            language: "en".into(),
        };
        let transcript =
            super::transcribe_json(&root, wav.to_str().unwrap(), &request, &mut |_, _, _, _| {})
                .unwrap();
        let text = transcript["segments"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|segment| segment["text"].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        eprintln!("transcript: {text}");
        let lower = text.to_ascii_lowercase();
        assert!(
            lower.contains("mitosis")
                || lower.contains("cell")
                || lower.contains("divid")
                || lower.contains("daughter"),
            "{text}"
        );
        let elapsed = transcript["elapsedMs"].as_u64().unwrap();
        assert!(elapsed < 15 * 60 * 1000, "short clip took {elapsed} ms");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_removes_a_partial_transcript_and_keeps_a_finished_one() {
        let root = std::env::temp_dir().join(format!("create-notes-cancel-{}", super::now_ms()));
        let tmp = root.join("tmp");
        let notes = root.join("notes");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::create_dir_all(&notes).unwrap();
        let finished = notes.join("Lecture.md");
        std::fs::write(&finished, "finished note\n").unwrap();

        let partial_json = tmp.join("partial.json");
        let partial_wav = tmp.join("partial.wav");
        std::fs::write(&partial_json, "{").unwrap();
        std::fs::write(&partial_wav, "wav").unwrap();
        super::write_saved(&root, &saved_job(&root, "partial", &partial_json, &partial_wav)).unwrap();
        super::cancel_make_notes(&root, "partial").unwrap();
        assert!(!partial_json.exists());
        assert!(!partial_wav.exists());
        assert!(!super::job_file(&root).exists());
        assert_eq!(std::fs::read_to_string(&finished).unwrap(), "finished note\n");

        let complete_json = tmp.join("complete.json");
        let complete_wav = tmp.join("complete.wav");
        std::fs::write(
            &complete_json,
            r#"{"transcription":[{"offsets":{"from":0,"to":1000},"text":"Cells divide."}]}"#,
        )
        .unwrap();
        std::fs::write(&complete_wav, "wav").unwrap();
        super::write_saved(
            &root,
            &saved_job(&root, "complete", &complete_json, &complete_wav),
        )
        .unwrap();
        super::cancel_make_notes(&root, "complete").unwrap();
        assert!(complete_json.exists());
        assert!(complete_wav.exists());
        assert!(super::job_file(&root).exists());
        assert_eq!(std::fs::read_to_string(&finished).unwrap(), "finished note\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    fn saved_job(
        root: &std::path::Path,
        id: &str,
        json_path: &std::path::Path,
        wav: &std::path::Path,
    ) -> super::SavedJob {
        super::SavedJob {
            id: id.into(),
            media_path: "lecture.mp3".into(),
            home: root.to_string_lossy().into_owned(),
            course_id: "course".into(),
            module_id: None,
            module_name: None,
            new_module_name: None,
            phase: "transcribing".into(),
            label: "Transcribing the recording".into(),
            percent: Some(10),
            pid: None,
            stderr_path: root
                .join("tmp")
                .join(format!("{id}.stderr"))
                .to_string_lossy()
                .into_owned(),
            stdout_path: root
                .join("tmp")
                .join(format!("{id}.stdout"))
                .to_string_lossy()
                .into_owned(),
            json_path: json_path.to_string_lossy().into_owned(),
            wav_path: wav.to_string_lossy().into_owned(),
            started_ms: 1,
            duration_seconds: None,
            pace: "clearer".into(),
            language: "en".into(),
            transcribe_started_ms: 1,
            model: "ggml-base.en".into(),
        }
    }

    #[cfg(windows)]
    fn synthesize(dest: &std::path::Path) -> Result<(), String> {
        let script = format!(
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('{}'); $s.Speak('Mitosis begins when the cell prepares to divide into two daughter cells.'); $s.Dispose()",
            dest.display().to_string().replace('\'', "''")
        );
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", &script]);
        let status = super::quiet(&mut command)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not synthesize a sample recording.".into())
        }
    }
}
