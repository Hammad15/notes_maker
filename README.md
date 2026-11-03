# Create Notes

Desktop app for one student on a computer. Pick a home folder, create a course, and turn a video or audio file that is already on the computer into study notes. Notes are Markdown. Every save also writes a PDF beside the Markdown.

This build is the course library and Make Notes. The theme is dark. There is no login and no payment screen.

Press **Set up local notes** once in the sidebar. That button downloads the speech model for the speed you chose, the speech engine, and ffmpeg and ffprobe when those programs are missing. Local notes do not ask for an API key. After setup finishes, Make Notes transcribes the recording and writes Markdown plus a PDF. The window shows a percent and an estimate of the time remaining for the whole run, including writing the notes after transcription. The bar stays empty until both of those numbers are on screen.

Suggested CPU specs: 4-core CPU and 16 GB RAM. Lesser builds should also work, just slower.

**Speed** is chosen under Local. Faster is quicker and the notes can be rougher. Clearer is slower and the notes are better. Switching speed shows setup again until that speed's speech model is present. Both model files can sit next to each other.

If a transcript already exists for the same recording and the same course or module, Make Notes does not run speech recognition again. It rewrites the study notes from that saved transcript. The raw transcript stays in the hidden `.study` folder. The Markdown note and the PDF are study notes.

Cloud notes are not available in this build. Choosing **Cloud** in the sidebar says so, and Make Notes and Restyle stay off. This build does not ask for a Groq API key and does not call Groq. Local notes stay on this computer. Notes in this build are English. The language is a setting so another language can be added later.

## Run on Windows

Choosing a recording and choosing the home folder use the Windows common file dialog. A browser tab cannot show that dialog, so `npm run dev` is not the app.

Requirements: Node.js 22, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows, including Rust 1.87 or newer (rustup reads `rust-toolchain.toml`).

```bash
npm install
npm run tauri dev
```

That opens the Create Notes window. The file dialogs come from the Tauri dialog plugin. Use that window. Do not pick files from a browser tab pointed at the dev server. The `.study` folder inside a course is marked hidden.

**Set up local notes** downloads the local speech files:

- whisper.cpp 1.9.2 for Windows (`whisper-cli.exe` and the DLLs next to it), from `whisper-bin-x64.zip`
- the English speech model for the selected speed: `ggml-base.en.bin` (147,964,211 bytes) for Clearer, or `ggml-tiny.en.bin` (77,704,715 bytes) for Faster
- FFmpeg 9.0.2 `ffmpeg.exe` and `ffprobe.exe`, when they are not already on the computer

Those files land in `%LOCALAPPDATA%\Study Notes`, and the button writes `models\local.json`. There is no terminal step. Local notes do not use an API key.

`npm run dev` only serves the UI at http://127.0.0.1:43127. Tauri starts it for you. Opening that address in a browser cannot show the Windows file dialog.

Settings live outside the home folder. The folder name stays Study Notes, so models and settings from the earlier build stay in place:

- Windows: `%LOCALAPPDATA%\Study Notes\settings.json`
- Linux: `~/.local/share/Study Notes/settings.json`
- macOS: `~/Library/Application Support/Study Notes/settings.json`

`settings.json` holds the home folder, the notes choice, and the speech speed. It does not hold an API key. A key left in that file from an older build is removed the next time Create Notes loads settings.

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

Cloud notes, login, payments, a theme picker, and the public WiX MSI installer.

## License

Create Notes is released under the GNU General Public License version 3. See [LICENSE](LICENSE).

Third-party code keeps its own license. Dependency licenses were checked for the npm packages and the Rust crates. These are not permissive software licenses:

- Mozilla Public License 2.0: `lightningcss` and its platform packages; Rust crates `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, and `selectors`
- SIL Open Font License 1.1: `@fontsource/literata`, `@fontsource/outfit`, and the Liberation fonts bundled for PDF text
- Creative Commons Attribution 4.0: `caniuse-lite`

The other checked dependencies use a permissive license, or offer a permissive license as one of the choices. Third-party license texts are not copied into this file.
