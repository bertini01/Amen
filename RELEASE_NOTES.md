# Amen Studio 0.4.0 — Release Notes

## New

- **Spotify links.** Spotify music is copy-protected, so it can't be saved
  directly. Pasting a Spotify song, album or playlist link now shows what it
  describes (cover, title, artists, length) and searches for versions you can
  save. Results are ranked by matching length and title, with covers, live and
  karaoke versions ranked down; you choose. The saved file is named and tagged
  after the song ("Artist - Title.mp3", with title and artist tags).
  Other copy-protected services (Apple Music, Tidal, Deezer, Amazon Music) get
  a clear explanation instead of a cryptic error.
- **Search by song name.** Typing a song and artist now searches (the button
  reads "Search"). Before, the button only accepted links, so search was
  unreachable. Only the top result is pre-selected.
- **Tidy up download folders.** History offers to move songs that older
  versions saved into accidental sub-folders back into the download folder,
  under their full title.
- **Completion notifications** (Settings → General), and "Start empty" now
  works.
- **Drag audio files onto the Audio Studio.**

## Fixed

- **Files saved into nested folders.** A "/" in a title created folders
  ("EP 18 / Song" became "EP 18\Song.mp3"). Titles can no longer create
  folders or leave the download folder. Names over ~120 characters are
  shortened at a word with "…", and the full path stays within Windows limits.
  A "%" in a title no longer garbles the name.
- **Open in Audio Studio, Open file and Show in folder failing** for titles
  with emoji: history recorded a path without the emoji. Output is now read as
  UTF-8, the recorded path is checked against the disk, and existing entries
  repair themselves.
- **Download progress never moved and "Processing" never showed.** yt-dlp
  wrote progress to a stream the app did not read.
- **"Download again" was silently skipped**, as was saving a video as MP4
  after its MP3. Duplicates now require the same format and an existing file.
- Cancel during "Fetching info" was ignored; removing a job while it was
  fetching brought it back.
- Copy and Paste failed (missing clipboard permission) while still saying
  "Copied".
- Studio playback failed for audio outside the user profile.
- Settings edits leaked into the app before Save; Theme changes saved them.
- Your default format/quality was ignored on startup; downloads re-analyzed
  links already analyzed.
- Diagnostics: the network check always reported failure; the logs path was
  wrong; leaving during an install allowed a second, corrupting install;
  a failed yt-dlp update reported success.
- Confirmation dialogs only worked inside the Studio (Clear history ran
  without asking).
- Errors across the app showed "[object Object]" or nothing; they now give
  the reason.

## Store "What's new" text

(Deliberately names no other company's service: Store reviewers can treat
brand names in listings as a trademark issue.)

Paste a streaming-service link and pick a version you can save. Search songs by name.
Downloads are named and tagged properly, never in stray folders, with live
progress. Many fixes across History, Studio, Settings and Diagnostics.
