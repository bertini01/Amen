# Amply Studio 0.5.0 — Release Notes

## New name: Amply Studio

Amen Studio is now **Amply Studio**: amplify the music you love, with plenty of room
to shape it into your own mixes. The familiar "A" logo stays. Existing installs
keep their settings, history, installed tools and download folder; new installs
save music to `Music\Amply`.

## Performance

- **Idle CPU: from ~13% of a core to under 1%.** A small status dot in the
  sidebar pinged forever, and that one endless animation kept the window
  repainting on every screen.
- **Studio playback: from ~140% to ~34% of a core.** The waveform was redrawn
  in full 60 times a second just to move the playhead, and the whole Studio
  re-rendered every frame. The playhead lines now follow the audio clock on
  their own, the waveform redraws only when it changes, and the rest of the
  Studio updates 20 times a second. Split, markers and in/out points still use
  the exact playback position.
- The app now honours Windows' "reduce animations" setting.

## Security

- **Content Security Policy**: the app window may only run its own code and
  only talk to its own backend; it cannot load frames, plugins or remote
  scripts.
- **No option smuggling into yt-dlp**: downloads accept only http(s) links, and
  the link is passed after `--`, so text such as `--exec …` can never be read
  as a yt-dlp option.
- **"Open file" only opens media, images, logs and projects**, never programs,
  scripts, installers or shortcuts.
- Dependency updates fixing published advisories: rustls / rustls-webpki (TLS
  certificate checks), SQLite (CVE in the bundled C library, via rusqlite
  0.43), url and cookie crates, and the zip library used to unpack FFmpeg
  (2 → 9; the app never used its vulnerable extract functions, and a new test
  checks that only ffmpeg.exe and ffprobe.exe are ever written). Tauri 2.12
  and plugins updated to match.
  `npm audit` and `cargo audit` report no known vulnerabilities in shipped code.

## Linux

- Cancel now stops downloads on Linux (it called a Windows-only command), and
  Linux builds install exactly the locked dependencies.

## Store "What's new" text

Amen Studio is now Amply Studio. Much lighter on your CPU, both
idle and while playing in the Studio, plus security hardening and updated
components.
