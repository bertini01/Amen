# Wavecrate User Guide

## Welcome to Wavecrate

Wavecrate is a premium local audio downloader and studio application for Windows. Download media from supported platforms and compose audio projects—all processed locally on your machine with no cloud services.

---

## Getting Started

### First Launch

1. **Install Wavecrate** - Install it from the Microsoft Store (or the Linux package)
2. **Open Diagnostics** - On first launch, go to Settings → Diagnostics
3. **Install Dependencies** - Click "Install both" to get yt-dlp and FFmpeg
4. **Wait for completion** - This takes about 30 seconds
5. **You're ready!** - Green checkmarks mean everything is working

---

## Downloading Media

### Quick Download

1. **Copy a URL** - Copy any supported media link (YouTube, SoundCloud, etc.)
2. **Paste in Wavecrate** - Go to the Home tab, paste the URL
3. **Click Analyze** - Wavecrate analyzes the media locally
4. **Choose format** - Select MP3 (audio) or MP4 (video)
5. **Choose quality** - Select Best, 320k, 256k, 192k, or 128k for MP3
6. **Click Download** - Your file downloads to `Music\Wavecrate`

### Search Mode

If you paste a search query instead of a URL:
- Wavecrate shows up to 5 best results
- Click one to select it
- Then download as normal

### Custom Location

Want to save files somewhere else?
1. Go to **Settings**
2. Click **Browse** next to Output Directory
3. Choose your folder
4. All future downloads go there

---

## Audio Studio

### What is Audio Studio?

Audio Studio lets you:
- Import multiple audio files
- Cut precise clips from them and preview each one individually
- Arrange clips across multiple tracks on a timeline
- Move, trim, split, duplicate, and delete clips on the timeline
- Mute/solo individual tracks
- Apply volume, fades, and crossfades
- Undo/redo any editing action
- Export the final mix

Drag the handle between the waveform and the timeline to give either one more
room — Wavecrate remembers your preference.

### Import Audio

**Method 1: File Picker**
1. Go to **Audio Studio** tab
2. Click **Import Audio**
3. Select your audio files (MP3, WAV, FLAC, M4A)
4. Click Open

**Method 2: Drag and Drop**
1. Go to **Audio Studio** tab
2. Drag audio files from Windows Explorer
3. Drop them on the window
4. They import automatically

**Method 3: From Downloads**
1. Download an MP3 from Home view
2. Go to **History** tab
3. Click the **music note icon** next to your download
4. File opens in Audio Studio automatically

### Create Clips

1. **Select a source** - Click an audio file in the Sources panel
2. **View waveform** - The waveform appears in the center
3. **Select region** - Click and drag on the waveform
4. **Create clip** - Click the **+** button in the Clips section
5. **Done!** - Your clip appears in the Clip Library

**Tip:** You can create multiple clips from the same source.

### Preview a Clip

Before — or instead of — placing a clip on the timeline, you can hear exactly
that clip on its own:

1. Hover over a clip in the **Clip Library**
2. Click the **▶ Preview** icon that appears on it
3. Playback starts at the clip's start and stops exactly at its end
4. The indicator above the player bar reads **CLIP PREVIEW** while this is
   happening, so it's never confused with playing the whole source file

### Loop a Selection and Drop Markers

Two small tools that make working through a long recording much easier:

- **Loop** - Select a region, click **Loop** next to Preview, then Preview it.
  Playback repeats that region continuously instead of stopping at its end —
  useful for judging exactly where a cut should land.
- **Markers** - Click **Add Marker** while listening to bookmark the current
  position (or press **M**). Click a marker to jump straight back to it, or
  the **×** to remove it. Markers are saved with the project.

### Arrange on Timeline

1. **Drag a clip** - Click and drag a clip from the Clip Library onto a track
2. **Drop it** - Release over the position where you want it; a drop indicator
   shows exactly where it will land
3. **Move it** - Drag a placed clip left/right to reposition it, or onto
   another track
4. **Trim it** - Drag either edge of a placed clip to shorten it (the
   underlying clip in the library is untouched — this only affects the
   timeline placement)
5. **Split it** - Move the playhead to where you want the cut, select the
   clip, then click **Split** in the timeline toolbar (or press **S**). Both
   halves keep playing the same audio with no gap or fade at the cut, and can
   then be moved, trimmed, or deleted independently
6. **Add more tracks** - Click **+ Track** to layer additional clips
7. **Mute / solo a track** - Use the speaker/S buttons in the track header
8. **Undo/redo** - Every move, trim, split, and delete can be undone
   (Ctrl+Z) and redone (Ctrl+Shift+Z)

### Preview Your Mix

The player bar always shows what it's about to play — **SOURCE**,
**CLIP PREVIEW**, or **TIMELINE MIX** — so it's never ambiguous which one
you're hearing.

1. **Switch to Timeline Mix** - Click **Timeline Mix** in the Playback row
   (Wavecrate renders a preview automatically the first time, and again whenever
   the timeline changes)
2. **Play button** - Click Play in the player bar
3. **Seek** - Click the seek slider, or the timeline ruler, to jump around
4. **Volume** - Adjust volume or mute as needed

### Export Your Mix

1. **Click Export** - Top-right corner
2. **Choose format**:
   - **MP3** - Compressed, good for sharing (choose bitrate)
   - **WAV** - Uncompressed, best quality, large file
   - **FLAC** - Compressed but lossless
   - **M4A** - Modern compressed format
3. **Choose location** - Pick where to save
4. **Click Export** - Wait for completion
5. **Done!** - Your mix is ready

### Save Your Project

Want to come back later?
1. **Click Save** - Saves your project as a .lms file
2. **Choose location** - Save it anywhere
3. **Later:** Click **Open** to reload it

---

## Keyboard Shortcuts

Shortcuts are disabled while a text field (like a time input) has focus, so
typing a number never accidentally triggers one.

### Player Bar
- **Space** - Play / Pause
- **←** - Seek back 5 seconds
- **→** - Seek forward 5 seconds
- **Shift + ←** - Seek back 0.5 seconds
- **Shift + →** - Seek forward 0.5 seconds
- **Home** - Jump to start
- **End** - Jump to end
- **0-9** - Jump to 0-90% of duration

### Waveform
- **Mouse wheel** - Zoom in/out
- **Click** - Seek to position
- **Drag** - Select region
- **Shift + drag** - Pan the view
- **+ / -** - Zoom in/out
- **Ctrl+0** - Fit the whole source to view

### Timeline & Project
- **S** - Split the selected clip at the playhead
- **M** - Add a marker at the current playhead
- **Delete / Backspace** - Delete the selected timeline clip (or library clip)
- **Ctrl+Z** - Undo
- **Ctrl+Shift+Z** (or **Ctrl+Y**) - Redo
- **Ctrl+D** - Duplicate the selected clip
- **Ctrl+S** - Save project
- **Ctrl+O** - Open project
- **Ctrl+N** - New project
- **Ctrl+E** - Export mix

---

## Tips & Tricks

### Audio Studio Workflow

**Basic Edit:**
```
Import → Select region → Create clip → Add to timeline → Export
```

**Multi-source Mix:**
```
Import 3 files → Create clip from each → Arrange on timeline → Export
```

**Quick Trim:**
```
Import file → Select 30s-45s → Create clip → Export
```

### Best Practices

1. **Name your clips** - Hover a clip in the Clip Library and click the pencil icon to rename it
2. **Duplicate before experimenting** - Clone clips to try different arrangements
3. **Save often** - Projects are small, save multiple versions
4. **Use multiple tracks** - Layer sounds for richer mixes
5. **Preview frequently** - Preview auto-renders, so listen as you go

### Quality Settings

**For MP3 Downloads:**
- **Best** - VBR (variable bitrate), highest quality, ~256-320k average
- **320k** - Maximum constant bitrate, largest file
- **192k** - Good balance, most people can't hear the difference
- **128k** - Smaller files, noticeable quality loss

**For Exports:**
- **WAV** - Use for further editing in other software
- **FLAC** - Best compression without quality loss
- **MP3 320k** - Great for sharing, streaming
- **MP3 192k** - Good for most uses, smaller files

---

## Common Questions

### Where do my downloads go?

By default: `%USERPROFILE%\Music\Wavecrate` (`Music\Amen` if you installed before the rename)

Example: `C:\Users\YourName\Music\Wavecrate\`

### Can I change the download location?

Yes! Settings → Output Directory → Browse

### Does this use the internet?

Only for downloading media from URLs. The Audio Studio works 100% offline.

### Is my data private?

Yes. Everything happens on your computer. No cloud processing, no data collection.

### What if a download fails?

1. Check Diagnostics to ensure yt-dlp and FFmpeg are installed
2. Try the URL in a web browser to verify it works
3. Check History for error details
4. Some content may be region-locked or removed

### Can I download playlists?

Yes! Paste a playlist URL, and Wavecrate shows all items. Select the ones you want and download them all at once.

### How do I update yt-dlp?

Go to Diagnostics → "Check for updates" → Update if available

### What's the difference between MP3 and MP4?

- **MP3** - Audio only (music, podcasts, audiobooks)
- **MP4** - Video with audio (YouTube videos, clips)

---

## Troubleshooting

### "yt-dlp is not installed"

**Solution:** Go to Diagnostics → Install both

### "FFmpeg is missing"

**Solution:** Go to Diagnostics → Install both

### Downloads are slow

**Cause:** Your internet connection or the source server
**Solution:** Be patient, or try a different quality setting

### "Sign in to confirm you're not a bot"

**Cause:** YouTube's anti-bot protection
**Solution:** If you own the content, provide a cookies file in Settings → Advanced

### Audio Studio won't play

**Solution:**
1. Ensure FFmpeg is installed (Diagnostics)
2. Try rendering preview manually (it should auto-render)
3. Check that your audio files are valid

### File won't import to Studio

**Solution:**
1. Verify file format (MP3, WAV, FLAC, M4A supported)
2. Ensure file isn't corrupt (try playing in Windows Media Player)
3. Check file permissions

### Export fails

**Solution:**
1. Ensure FFmpeg is installed
2. Check you have enough disk space
3. Verify output path is writable
4. Check Diagnostics logs for details

---

## Supported Platforms

Wavecrate supports **hundreds of websites** via yt-dlp, including:

- YouTube
- SoundCloud
- Vimeo
- Twitch
- Bandcamp
- Mixcloud
- And many more...

Full list: [yt-dlp supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)

---

## Privacy & Ethics

### What Wavecrate Does
- Downloads publicly available media
- Processes everything locally
- Embeds metadata from the original source

### What Wavecrate Doesn't Do
- Access your accounts without permission
- Harvest browser cookies automatically
- Bypass DRM or paywalls
- Upload anything anywhere

### Your Responsibility
- Respect copyright laws in your jurisdiction
- Only download content you have rights to
- Respect platform terms of service
- Use ethically and legally

---

## Need More Help?

- Check the logs: `%APPDATA%\Amen\logs\app.log`
- Copy diagnostic report from Diagnostics view
- Ensure yt-dlp and FFmpeg are up to date

---

## Version

**Wavecrate v0.1.0**

Built with ❤️ for audio creators.
