# Study Notes

Desktop app for one student on a computer. Pick a home folder, create a course, and turn a video or audio file that is already on the computer into study notes. Notes are Markdown. Every save also writes a PDF beside the Markdown.

This build is the course library and Make Notes. The theme is dark. There is no login and no payment screen.

Press **Set up local notes** once in the sidebar. That button downloads the speech model, the speech engine, and ffmpeg and ffprobe when those programs are missing. It does not ask for an API key. After it finishes, Make Notes transcribes the recording and writes Markdown plus a PDF. A long recording takes longer than a minute. Cloud notes stay off until an entitlement is present.

## Run on Windows

Choosing a recording and choosing the home folder use the Windows common file dialog. A browser tab cannot show that dialog, so `npm run dev` is not the app.

Requirements: Node.js 22, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows, including Rust 1.87 or newer (rustup reads `rust-toolchain.toml`).

```bash
npm install
npm run tauri dev
```

That opens the Study Notes window. The file dialogs come from the Tauri dialog plugin. Use that window. Do not pick files from a browser tab pointed at the dev server. The `.study` folder inside a course is marked hidden.

**Set up local notes** is the only setup step inside the app. It downloads:

- whisper.cpp 1.9.2 for Windows (`whisper-cli.exe` and the DLLs next to it), from `whisper-bin-x64.zip`
- the English speech model `ggml-base.en.bin` (147,964,211 bytes)
- FFmpeg 9.0.2 `ffmpeg.exe` and `ffprobe.exe`, when they are not already on the computer

Those files land in `%LOCALAPPDATA%\Study Notes`, and the button writes `models\local.json`. There is no terminal step and no API key.

`npm run dev` only serves the UI at http://127.0.0.1:43127. Tauri starts it for you. Opening that address in a browser cannot show the Windows file dialog.

Settings live outside the home folder:

- Windows: `%LOCALAPPDATA%\Study Notes\settings.json`
- Linux: `~/.local/share/Study Notes/settings.json`
- macOS: `~/Library/Application Support/Study Notes/settings.json`

Cloud notes run only when `license.json` in that same folder contains `{ "entitled": true }`.

## Run the desktop window on Linux or macOS

Requirements: [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS, including Rust 1.87 or newer and WebKitGTK on Linux.

```bash
npm install
npm run tauri dev
```

File prompts are the system dialogs. The one-click speech download is the Windows build of whisper.cpp and FFmpeg.

## Tests

```bash
npm test
```

## Course folders

```text
<Home>/
  Biology 101/
    course.json
    notes/
      Lecture 3.md
      Lecture 3.pdf
    Cells/
      module.json
      notes/
        Mitosis.md
        Mitosis.pdf
    .study/
      transcripts/<note-id>.json
      sources/<note-id>.json
      history/<note-id>.md
```

`notes` and `.study` are reserved and are not modules. The app stores the media path. It does not copy the recording into the course.

## Not in this build

Login, payments, a theme picker, and the public WiX MSI installer.
