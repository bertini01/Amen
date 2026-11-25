# Amply Studio

A beautiful, local-first media downloader for **Windows 11** — powered by **yt-dlp** and **FFmpeg**.

Paste a supported media URL (YouTube, SoundCloud, Vimeo, and the hundreds of extractors yt-dlp
supports), analyze it locally, pick a format and quality, and download. Everything runs on your
machine. There is **no cloud service**, no "online YouTube-to-MP3 website", and no third-party
conversion API — the app shells out to a locally installed `yt-dlp` + `ffmpeg` and streams real
progress back to the UI.

---

## What it does

- **URL → Analyze → Download**, all local.
- **MP3 extraction** (primary): `bestaudio` → FFmpeg → MP3 with selectable output quality
  (Best / 320 / 256 / 192 / 128 kbps).
- **MP4 video** (secondary): best video + audio merged to MP4.
- **Real metadata + album art**: title, artist/uploader, album, date, genre, description and the
  thumbnail are embedded as proper media tags (yt-dlp + FFmpeg do the tagging).
- **Playlist support**: preview entries, select/deselect, download whole playlist or a subset.
- **Download queue** with live progress: percentage, speed, ETA, bytes, current stage,
  cancel / retry / remove / clear finished.
- **Robust duplicate handling**: skip / replace / create a new copy, keyed by stable media ID and
  existing files on disk.
- **Download history** (SQLite) with search, filters, sorting, open file, reveal in Explorer,
  copy source URL, re-download, remove.
- **Settings** for theme, defaults, output directory, filename templates, overwrite behavior,
  executable paths, metadata options, and a few advanced options.
- **Diagnostics screen** that genuinely checks yt-dlp, FFmpeg, ffprobe, the output directory,
  free disk space, and network — and can **auto-install** missing tools from official sources.
- **Structured local logging** with a one-click "copy diagnostic report".

## Security model

- User-provided URLs and metadata are treated as **untrusted input**.
- `yt-dlp`/`FFmpeg` are spawned with **structured argument arrays** — never a shell string.
- Output paths are sanitized (Windows-invalid characters, reserved device names, length caps,
  path-traversal rejection).
- No browser cookie harvesting. Authenticated content is only reachable through an
  **explicitly provided** cookies file in Settings → Advanced, which the user must supply.
- Only **official sources** are used for dependency installation: yt-dlp GitHub releases and
  gyan.dev Windows FFmpeg builds.
- No DRM/paywall/access-control bypass is attempted or supported.

---

## Requirements

| Component                                  | Notes                                                  |
| ------------------------------------------ | ------------------------------------------------------ |
| Windows 10/11                              | WebView2 runtime (preinstalled on Windows 11)          |
| Ubuntu 24.04+ / Debian 13+                 | WebKitGTK 4.1; installed automatically by the `.deb`   |
| Node.js ≥ 20                               | Development only                                       |
| Rust toolchain (stable) + MSVC Build Tools | Development only — required to compile the Tauri shell |
| yt-dlp                                     | Required at runtime; auto-installable from Diagnostics |
| FFmpeg + ffprobe                           | Required at runtime; auto-installable from Diagnostics |

At **runtime** the app only needs yt-dlp and FFmpeg, which it can install for you from the
Diagnostics screen. Development additionally needs Node + Rust.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (src/) — React 18 + TypeScript + Tailwind v4  │
│  Zustand stores, shadcn-style UI, lucide icons           │
└───────────────┬──────────────────────────────────────────┘
                │  Tauri IPC (invoke + events)
┌───────────────▼──────────────────────────────────────────┐
│  Backend (src-tauri/) — Rust                            │
│  • subprocess manager (yt-dlp/ffmpeg, CREATE_NO_WINDOW)  │
│  • download queue + real progress parsing → events       │
│  • SQLite history + persisted queue                      │
│  • settings JSON, dependency detection/install           │
└───────────────┬──────────────────────────────────────────┘
                │  structured args (no shell)
        ┌───────▼────────┐   ┌──────────────┐
        │   yt-dlp       │──▶│   FFmpeg     │──▶ MP3/MP4 on disk
        └────────────────┘   └──────────────┘
```

| Layer         | Tech                                     |
| ------------- | ---------------------------------------- |
| Desktop shell | Tauri 2 (Rust)                           |
| UI            | React 18, TypeScript, Vite 6             |
| Styling       | Tailwind CSS v4, shadcn-style components |
| State         | Zustand                                  |
| Icons         | lucide-react                             |
| History DB    | SQLite via `rusqlite` (bundled)          |
| Media engines | yt-dlp + FFmpeg (external processes)     |

### Project structure

```
├─ src/                     # React frontend
│  ├─ components/           # UI primitives + feature components
│  ├─ lib/                  # types, api wrappers, url/format utils
│  ├─ stores/               # zustand stores (app, queue, history, settings, toast)
│  └─ views/                # Home, Downloads, History, Settings, Diagnostics
├─ src-tauri/               # Rust backend
│  ├─ src/
│  │  ├─ analyze.rs         # yt-dlp -J metadata/playlist extraction
│  │  ├─ arggen.rs          # yt-dlp argument generation (pure, tested)
│  │  ├─ commands/          # Tauri command handlers
│  │  ├─ config.rs          # settings + app dirs
│  │  ├─ download.rs        # queue, subprocess lifecycle, progress events
│  │  ├─ history.rs         # SQLite history + persisted queue
│  │  ├─ progress.rs        # yt-dlp output parser (pure, tested)
│  │  ├─ tools.rs           # dependency detection + official-source install
│  │  ├─ util.rs            # filename/path sanitization (pure, tested)
│  │  └─ integration_tests.rs # real end-to-end pipeline tests
│  └─ tauri.conf.json
└─ tests/                   # frontend unit tests (vitest)
```

---

## Development

```bash
# 1. Install frontend dependencies
npm install

# 2. (Optional) after changing public/logo.png, regenerate the app icons
powershell -File scripts/create-tauri-icons.ps1; npm run gen:icon

# 3. Install the Rust toolchain (once)
#    https://rustup.rs — stable profile, MSVC host
#    (requires Visual Studio Build Tools with the "Desktop development with C++" workload)

# 4. Run the desktop app in dev mode (hot reload)
npm run tauri:dev
```

> First `tauri:dev` compiles the whole Rust dependency tree — expect several minutes.

> **Low-memory machines (≤ 8 GB RAM):** the project ships `src-tauri/.cargo/config.toml`
> with `jobs = 1` to avoid memory exhaustion. If `rustc` still aborts while compiling the
> huge `windows`/`tauri-utils` crates (Windows error `0xc0000409`, "stack overflow" /
> "memory allocation … failed"), set a large worker-thread stack before building:
>
> ```powershell
> $env:RUST_MIN_STACK = 268435456   # 256 MB — fixes rustc stack overflow
> npm run tauri:dev
> ```

## Production build (Windows installer)

```bash
npm install
npm run tauri:build
```

The installer is written to `src-tauri/target/release/bundle/nsis/`
(`Amply_<version>_x64-setup.exe`). It is a per-user NSIS installer and does not require
admin rights.

## Microsoft Store build (MSIX)

The Store ships Amply Studio as an MSIX package, which the Store signs itself, so no
code-signing certificate is needed.

1. Fill in `packaging/msix/store-identity.json` from Partner Center → the app →
   *Product management → Product identity* (one-time).
2. Build and pack:

   ```powershell
   .\scripts\package-msix.ps1
   ```

   This writes `src-tauri/target/msix/Amply_<version>.0_x64.msix`. Upload that file
   under *Packages* in the Store submission.

To try the packaged app locally before submitting (requires Windows Developer
Mode), run `.\scripts\package-msix.ps1 -Dev -Register` and launch **Amply Studio** from
Start. Remove it afterwards with `Get-AppxPackage Amply.Dev | Remove-AppxPackage`.

Each Store update needs a higher version in `tauri.conf.json` than the last
submission.

## Production build (Linux packages)

Requires **Ubuntu 24.04+ / Debian 13+** — Tauri v2 needs WebKitGTK **4.1**, and
Ubuntu 22.04 and older only ship 4.0. From Windows, build inside WSL:

```bash
wsl -d Ubuntu -u root -- bash /mnt/c/path/to/amen/scripts/build-linux.sh
```

`scripts/build-linux.sh` installs the toolchain, runs the Rust tests, builds, and
copies the results into `dist-linux/`. To build natively on Linux, run the same
script directly.

The packages link against the glibc of the machine that builds them, so build on
the **oldest** distribution you intend to support: a package built on 24.04 will
not start on 22.04.

### Installing

```bash
# Debian/Ubuntu — pulls in ffmpeg automatically
sudo apt install ./Amply_<version>_amd64.deb

# Or the portable AppImage, which needs no installation
chmod +x Amply_<version>_amd64.AppImage
./Amply_<version>_amd64.AppImage
```

The `.deb` declares `ffmpeg` as a dependency, so apt installs it for you. The
AppImage does not, so install FFmpeg yourself if you use it:
`sudo apt install ffmpeg`. In both cases yt-dlp is fetched on demand from the
Diagnostics screen.

## yt-dlp & FFmpeg setup

The app **auto-detects** each tool in this order:

1. A path explicitly configured in **Settings → yt-dlp & FFmpeg**.
2. A **bundled** copy in `%LOCALAPPDATA%\Amen\tools`.
3. An executable found on your **PATH**.

If a tool is missing, open **Diagnostics** and click **Install both** — the app downloads
`yt-dlp.exe` from the official GitHub releases and the FFmpeg essentials build from gyan.dev,
extracts them into the tools folder, and re-checks.

Manual installation (equivalent):

```powershell
# yt-dlp via pip (needs Python)
py -m pip install -U yt-dlp

# or the standalone exe (official)
# download https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
# into a folder on your PATH

# FFmpeg (official Windows builds)
# download https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
# extract and add the bin folder to PATH (or point to it in Settings)
```

## Configuration

The data folder is still named `Amen`, the app's former name, so upgrades keep
settings, history and tools. Settings are stored in `%APPDATA%\Amen\settings.json`. Download history and the
persisted queue live in `%APPDATA%\Amen\history.db`. Logs are in
`%APPDATA%\Amen\logs\app.log`.

Defaults:

- Output directory: `%USERPROFILE%\Music\Amply` (installs from before the rename keep `Music\Amen`)
- Filename template: `%(title)s.%(ext)s` (yt-dlp syntax — subdirectories like
  `%(artist)s/%(album)s/%(title)s.%(ext)s` are supported)
- Format: MP3 · Quality: Best · Overwrite: Skip · Duplicates: Skip
- Artwork and metadata embedding: on · Concurrent downloads: 3

## Troubleshooting

| Symptom                               | Fix                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "yt-dlp is not installed"             | Open **Diagnostics** and install it (or add it to PATH and re-check).                                                                |
| "FFmpeg is missing"                   | Install from **Diagnostics**. ffmpeg and ffprobe ship together.                                                                      |
| "Sign in to confirm you're not a bot" | YouTube's anti-bot gate. If you are authorized to access the content, provide a cookies file in **Settings → Advanced** (see below). |
| Video unavailable / 403               | The content is private, removed, age-restricted, or region-blocked.                                                                  |
| Files land in the wrong folder        | Change the output directory in **Settings → Downloads**.                                                                             |
| Nothing helps                         | **Diagnostics → Copy report** and inspect the logs folder.                                                                           |

### Cookies file (advanced, deliberate)

For authenticated/age-gated content you are _authorized_ to access, export a cookies file
(e.g. with a browser extension that exports Netscape-format cookies) and set its path in
**Settings → Advanced → Cookies file**. The app only ever passes the file path to yt-dlp with
`--cookies` — it never reads your browser's cookies automatically.

## Security notes

- Subprocesses are spawned with `CREATE_NO_WINDOW` and argument arrays; no shell interpolation.
- Output filenames are sanitized and length-capped; `..` traversal is rejected.
- The download manager kills entire process trees on cancel/close (no orphan FFmpeg processes).
- Downloaded metadata is treated as data — it is never executed.
- Diagnostic reports redact the cookies file path.

## Testing

### Unit tests (no network)

```bash
npm test                    # frontend: URL handling, formatting
cd src-tauri && cargo test  # backend: sanitization, progress parsing, args, errors
```

### Integration / end-to-end (real yt-dlp + FFmpeg + network)

The Rust integration tests in `src-tauri/src/integration_tests.rs` run the **real pipeline**:
metadata fetch → argument generation → actual MP3 download → ffprobe verification (container,
codec, duration, embedded tag). They are `#[ignore]`d by default:

```powershell
# put your tools somewhere the test can find them, then:
$env:LMS_TOOLS_DIR = "$env:LOCALAPPDATA\Amen\tools"   # or your PATH
$env:LMS_TEST_URL   = "https://www.youtube.com/watch?v=BaW_jenozKc"  # optional
cd src-tauri
cargo test -- --ignored --test-threads=1
```

These tests use **Big Buck Bunny** (Blender Foundation's open movie, Creative Commons) — a
publicly available clip that is appropriate for testing download tooling. The E2E test verifies
the real pipeline: metadata extraction → argument generation → actual yt-dlp download → FFmpeg
conversion → ffprobe verification (container, codec, duration, embedded tags).

### Studio end-to-end tests (Playwright, against the real running app)

`tests/*.spec.ts` drive the actual running desktop app's WebView2 instance via Chrome DevTools
Protocol — not a plain browser tab, so `invoke()`-backed features (waveform extraction, mixing,
export, project save/load) are exercised for real, never mocked. Requires the app to already be
running with remote debugging enabled:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri:dev
```

Then, in another terminal:

```bash
npx playwright test              # full suite
npx playwright test tests/studio-undo-redo.spec.ts   # a single file
```

The realistic-duration performance tests (`tests/studio-performance.spec.ts`) need three
multi-minute fixtures that are regenerated locally rather than committed (100+ MB, reproducible
in seconds):

```powershell
powershell -File tests/fixtures/generate-fixtures.ps1
```

## Updating

- **yt-dlp**: Diagnostics → "Check for updates". The app compares against the official GitHub
  release API and can self-update the bundled copy via `yt-dlp -U`.
- **FFmpeg**: re-run the Diagnostics install (it overwrites the bundled binaries).
- **The app itself**: rebuild with `npm run tauri:build` and run the new installer.

## License

Local tool for personal use. This project is an independent local frontend around
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) and FFmpeg (LGPL/GPL). Respect the terms
of service of the media providers you use and applicable copyright law.
