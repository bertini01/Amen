# Microsoft Store listing — copy into Partner Center

App name (reserved): **Amen Studio**. It must match the package display name exactly.
Field limits are Partner Center's.

## Properties

- **Category:** Music (secondary: Multimedia design)
- **Privacy policy URL:** https://github.com/bertini01/Amen/blob/main/PRIVACY.md
- **Website:** https://github.com/bertini01/Amen
- **Support contact:** https://github.com/bertini01/Amen/issues
- **Product declarations:** none of the boxes apply (no accessibility claims, no pen, no Xbox). Leave "This app has been tested to meet accessibility guidelines" unticked unless you have tested it.
- **System requirements:** minimum memory 4 GB, Windows 10 version 2004 or later, x64.

## Age ratings questionnaire

- Category: **All other app types**
- Violence, sexuality, language, drugs, gambling: **No** to all
- Does the app allow users to interact or exchange content? **No**
- Does the app share user location? **No**
- Does the app allow digital purchases? **No**
- Does the app access the internet for content not controlled by you? **Yes.** The user pastes links to websites of their choice.

## Short description (shown at the top of the listing)

Save the audio and video you love, then shape it into your own mix. Amen Studio downloads, converts and edits entirely on your PC, with no account and no cloud.

## Description

Amen Studio is a private, offline-first audio studio and media saver for Windows.

Paste a link, choose MP3 or MP4 and the quality you want, and Amen Studio saves it to your PC with the title, artist and cover art already filled in. Then open it in the built-in Audio Studio to cut clips, arrange them on a multi-track timeline and export your own mix.

Everything happens on your computer. There is no account, no advertising, no tracking, and no file ever passes through an online converter.

SAVE
• MP3 at 128 to 320 kbps, or MP4 video
• Title, artist, album, date and cover art embedded automatically
• Playlists: preview, pick the tracks you want, download them in one go
• Live queue with progress, speed and time remaining; cancel and retry anytime
• Smart duplicate handling and a searchable download history

CREATE
• Import several audio files and see their waveforms
• Cut sample-accurate clips and preview each one
• Arrange clips across tracks: move, trim, split, duplicate
• Mute and solo tracks; set volume, fades and crossfades
• Full undo and redo
• Export to MP3, WAV, FLAC or M4A
• Save projects and continue later

STAY IN CONTROL
• Diagnostics screen checks every tool, your disk space and your connection
• Installs its open-source engines (yt-dlp and FFmpeg) from their official sources in one click
• Light and dark themes

Please only download content you own or have permission to save, and respect the terms of the websites you use.

## Features (up to 20, one per line)

Save audio as MP3 (128–320 kbps)
Save video as MP4
Automatic title, artist and cover art tags
Playlist preview and selective download
Download queue with live progress
Searchable download history
Multi-track Audio Studio
Sample-accurate clip cutting
Fades and crossfades
Mute, solo and per-track volume
Undo and redo for every edit
Export to MP3, WAV, FLAC and M4A
Save and reopen projects
Works offline for editing
No account, ads or tracking
Built-in diagnostics and one-click tool setup

## Search terms (up to 7)

audio editor
mp3 converter
music studio
audio cutter
mixer
playlist
offline

## Copyright and trademark info

© 2026 Iradukunda Bertin. yt-dlp (Unlicense) and FFmpeg (LGPL/GPL) are independent open-source projects, downloaded from their official sources at the user's request.

## Notes for certification (Submission options → Notes for certification)

Amen Studio is a Win32 desktop app (Tauri / WebView2) packaged as MSIX. It needs the runFullTrust capability to run as a desktop app and to start its media engines as child processes.

On first launch the app may report that yt-dlp and FFmpeg are not installed. Open Diagnostics and choose Install: they are downloaded from their official sources (github.com/yt-dlp and gyan.dev) into the app's own data folder. No other code is downloaded.

To test without the internet: open Audio Studio, import any MP3 or WAV file, drag a selection on the waveform to create a clip, drag the clip to the timeline, then press Export.

No account or login is required.

## Screenshots

Upload the PNGs from `packaging/store-screenshots/` in their numbered order (1600×900, desktop). The Studio shot goes first on purpose: it presents Amen Studio as a creative tool.

Captions:
1. Arrange clips across tracks in the built-in Audio Studio
2. Export your mix to MP3, WAV, FLAC or M4A
3. Diagnostics checks every tool and installs missing ones in one click
4. Paste a link, pick a format, and save it to your PC

## Restricted capability justification (runFullTrust)

Amen Studio is a desktop (Win32) application packaged as MSIX. Full trust is required to run the desktop executable and to launch its bundled media tools (yt-dlp and FFmpeg) as child processes.
