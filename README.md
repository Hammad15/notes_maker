# Study Notes

Desktop app for one student on a computer. Pick a home folder, create a course, and turn a video or audio file that is already on the computer into study notes. Notes are Markdown. Every save also writes a PDF beside the Markdown.

This build is the course library and Make Notes. The theme is dark. Local notes run on this computer. Cloud notes stay off until an entitlement is present. There is no login and no payment screen.

The local provider does not run a speech model. Make Notes still files a Markdown note and a PDF for the course. The note records the recording and its length. It does not claim a transcript was produced.

## Run on Windows

Choosing a recording and choosing the home folder use the Windows common file dialog. A browser tab cannot show that dialog, so `npm run dev` is not the app.

Requirements: Node.js 22, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows, including Rust 1.87 or newer (rustup reads `rust-toolchain.toml`).

```bash
npm install
npm run tauri dev
```

That opens the Study Notes window. The file dialogs come from the Tauri dialog plugin. Use that window. Do not pick files from a browser tab pointed at the dev server. The `.study` folder inside a course is marked hidden.

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

File prompts are the system dialogs.

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
