use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{copy, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use zip::ZipArchive;

const MODEL_NAME: &str = "ggml-base.en";
const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_BYTES: u64 = 147_964_211;
const MODEL_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

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

const LONG_RECORDING_SECONDS: f64 = 30.0 * 60.0;
const MIN_LONG_ELAPSED_MS: u128 = 60_000;
const SETUP_REQUIRED: &str = "Press Set up local notes before making notes.";

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

fn model_path(app_data: &Path) -> PathBuf {
    app_data.join("models").join(MODEL_FILE)
}

fn config_path(app_data: &Path) -> PathBuf {
    app_data.join("models").join("local.json")
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
        && json.get("model").and_then(Value::as_str) == Some(MODEL_NAME)
        && json.get("modelBytes").and_then(Value::as_u64) == Some(MODEL_BYTES)
}

fn collect_status(app_data: &Path) -> Result<RuntimeStatus, String> {
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
    if !file_matches(&model_path(app_data), MODEL_BYTES, MODEL_SHA256)? {
        missing.push("model");
    }
    if !config_ready(app_data) {
        missing.push("config");
    }
    let ready = missing.is_empty();
    Ok(RuntimeStatus { ready, missing })
}

fn status_value(status: &RuntimeStatus) -> Value {
    json!({
        "ready": status.ready,
        "model": MODEL_NAME,
        "missing": status.missing,
    })
}

pub(crate) fn status_json(app_data: &Path) -> Result<Value, String> {
    Ok(status_value(&collect_status(app_data)?))
}

pub(crate) fn setup_local(
    app_data: &Path,
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
        let label = "Downloading ffmpeg and ffprobe";
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
        let label = "Downloading the speech engine";
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

    let label = "Downloading the speech model";
    progress("model", label, 0, Some(MODEL_BYTES));
    download_verified(
        MODEL_URL,
        &model_path(app_data),
        MODEL_BYTES,
        MODEL_SHA256,
        &mut |received, total| {
            progress("model", label, received, Some(total));
        },
    )
    .map_err(|error| format!("Could not download the speech model. {error}"))?;

    progress("config", "Saving local setup", 1, Some(1));
    let ffmpeg_source = if bin.join("ffmpeg.exe").is_file() {
        FFMPEG_VERSION
    } else {
        "path"
    };
    let config = json!({
        "ready": true,
        "model": MODEL_NAME,
        "modelFile": MODEL_FILE,
        "modelBytes": MODEL_BYTES,
        "engine": "whisper.cpp",
        "engineVersion": ENGINE_VERSION,
        "ffmpeg": ffmpeg_source,
    });
    let pretty = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(config_path(app_data), format!("{pretty}\n")).map_err(|error| error.to_string())?;
    let status = collect_status(app_data)?;
    if !status.ready {
        return Err(format!(
            "Local notes are still missing pieces after setup: {}.",
            status.missing.join(", ")
        ));
    }
    Ok(status_value(&status))
}

fn run_command(mut command: Command, timeout: Duration, what: &str) -> Result<(), String> {
    quiet(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if what.is_empty() {
            error.to_string()
        } else {
            format!("{what} {error}")
        }
    })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read command output.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read command output.".to_string())?;
    let out_thread = thread::spawn(move || read_capped(&mut stdout));
    let err_thread = thread::spawn(move || read_capped(&mut stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
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

fn read_capped(reader: &mut dyn Read) -> String {
    let mut buf = vec![0u8; 64 * 1024];
    let mut out = Vec::new();
    while out.len() < 1024 * 1024 {
        let Ok(read) = reader.read(&mut buf) else {
            break;
        };
        if read == 0 {
            break;
        }
        let room = (1024 * 1024usize).saturating_sub(out.len());
        out.extend_from_slice(&buf[..read.min(room)]);
    }
    String::from_utf8_lossy(&out).into_owned()
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

fn whisper_timeout(duration: Option<f64>) -> Duration {
    let seconds = duration.unwrap_or(60.0 * 60.0);
    let scaled = (seconds * 20.0).clamp(15.0 * 60.0, 6.0 * 60.0 * 60.0);
    Duration::from_secs(scaled as u64)
}

pub(crate) fn transcribe_json(app_data: &Path, media: &str) -> Result<Value, String> {
    let status = collect_status(app_data)?;
    if !status.ready {
        return Err(SETUP_REQUIRED.into());
    }
    let ffmpeg = tool_path(app_data, "ffmpeg").ok_or_else(|| SETUP_REQUIRED.to_string())?;
    let ffprobe = tool_path(app_data, "ffprobe").ok_or_else(|| SETUP_REQUIRED.to_string())?;
    let started = Instant::now();
    let tmp = app_data.join("tmp");
    fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let id = format!("{}-{}", std::process::id(), millis);
    let wav = tmp.join(format!("{id}.wav"));
    let json_base = tmp.join(&id);
    let json_path = tmp.join(format!("{id}.json"));
    let _cleanup = TempFiles(vec![wav.clone(), json_path.clone()]);
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
    run_command(
        convert,
        Duration::from_secs(2 * 60 * 60),
        "Could not read that recording.",
    )?;
    let duration = probe_duration(&ffprobe, &wav).or_else(|| {
        fs::metadata(&wav)
            .ok()
            .and_then(|meta| wav_seconds(meta.len()))
    });
    let bin = bin_dir(app_data);
    let mut whisper = Command::new(bin.join(ENGINE_EXE));
    whisper
        .current_dir(&bin)
        .env("PATH", prepend_path(&bin))
        .arg("-m")
        .arg(model_path(app_data))
        .arg("-f")
        .arg(&wav)
        .arg("-l")
        .arg("en")
        .arg("-oj")
        .arg("-of")
        .arg(&json_base)
        .arg("-np")
        .arg("-ng");
    run_command(
        whisper,
        whisper_timeout(duration),
        "Could not transcribe that recording.",
    )?;
    let raw = fs::read_to_string(&json_path)
        .map_err(|_| "The speech model did not write a transcript.".to_string())?;
    let segments = parse_whisper_json(&raw)?;
    let elapsed_ms = started.elapsed().as_millis();
    assert_heard(duration, elapsed_ms, &segments)?;
    Ok(json!({
        "segments": segments.iter().map(|segment| json!({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
        })).collect::<Vec<_>>(),
        "durationSeconds": duration,
        "elapsedMs": elapsed_ms as u64,
        "model": MODEL_NAME,
    }))
}

struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
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

#[cfg(test)]
mod tests {
    use super::{assert_heard, parse_whisper_json, Segment};

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

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn downloads_speech_model_and_transcribes() {
        let root = std::env::temp_dir().join(format!("study notes runtime {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let status = super::setup_local(&root, &mut |phase, label, received, total| {
            if received == 0 || total.map(|value| received >= value).unwrap_or(false) {
                eprintln!("{phase} {label} {received}/{total:?}");
            }
        })
        .unwrap();
        assert_eq!(status["ready"], true);
        assert_eq!(status["model"], "ggml-base.en");
        let wav = root.join("sample.wav");
        synthesize(&wav).unwrap();
        let transcript = super::transcribe_json(&root, wav.to_str().unwrap()).unwrap();
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
