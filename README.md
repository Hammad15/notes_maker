# Study Notes

Desktop app for one student on a computer. Pick a home folder, create a course, and turn a video or audio file that is already on the computer into study notes. Notes are Markdown. Every save also writes a PDF beside the Markdown.

This build is the course library and Make Notes. The theme is dark. Local notes run on this computer. Cloud notes stay off until an entitlement is present. There is no login and no payment screen.

The local provider writes the transcript from the recording's length and chapter markers. A downloaded speech model is not part of this build.

## Run the UI

Requirements: Node.js 22.

```bash
npm install
npm run dev
```

Open http://127.0.0.1:43127

In the browser, folder and file prompts browse this computer through the dev server. Courses are real folders in the home directory you pick.

Settings live outside that folder:

- Windows: `%LOCALAPPDATA%\Study Notes\settings.json`
- Linux: `~/.local/share/Study Notes/settings.json`
- macOS: `~/Library/Application Support/Study Notes/settings.json`

Cloud notes run only when `license.json` in that same folder contains `{ "entitled": true }`.

## Run the desktop window

Requirements: [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS, including Rust 1.87 or newer (rustup reads `rust-toolchain.toml`) and WebKitGTK on Linux.

```bash
npm run tauri dev
```

The window uses the same UI. File prompts are the system dialogs. On Windows, the `.study` folder inside a course is marked hidden.

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
