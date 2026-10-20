use regex::Regex;
use std::sync::OnceLock;

/// A parsed snapshot of yt-dlp progress output for one job.
#[derive(Debug, Clone, Default)]
pub struct ProgressUpdate {
    pub percent: Option<f64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub stage: Option<String>,
    pub output_path: Option<String>,
    pub skipped: bool,
}

static PERCENT_RE: OnceLock<Regex> = OnceLock::new();
static DEST_RE: OnceLock<Regex> = OnceLock::new();
static ITEM_RE: OnceLock<Regex> = OnceLock::new();
static PATH_RE: OnceLock<Regex> = OnceLock::new();

fn percent_re() -> &'static Regex {
    PERCENT_RE.get_or_init(|| {
        Regex::new(r"^\s*\[download\]\s+([0-9.]+)%\s+of\s+(~?\s*[0-9.]+[KMG]?i?B)\s+(?:at\s+([0-9.]+[KMG]?i?B/s)\s+)?(?:ETA\s+(\S+)|in\s+(\S+))").expect("regex")
    })
}

fn dest_re() -> &'static Regex {
    DEST_RE.get_or_init(|| {
        Regex::new(r"^\[(?:download|ExtractAudio)\]\s+Destination:\s+(.+)$").expect("regex")
    })
}

fn item_re() -> &'static Regex {
    ITEM_RE.get_or_init(|| {
        Regex::new(r"^\[info\]\s+.*?Downloading item\s+(\d+)\s+of\s+(\d+)").expect("regex")
    })
}

fn path_re() -> &'static Regex {
    PATH_RE.get_or_init(|| Regex::new(r"^[A-Za-z]:[\\/].+\.(?:mp3|mp4|m4a|webm|mkv|part)$").expect("regex"))
}

fn parse_bytes(input: &str) -> Option<u64> {
    let input = input.trim();
    if input.starts_with('~') {
        return None; // unknown total
    }
    let idx = input.find(|c: char| c.is_ascii_alphabetic())?;
    let num: f64 = input[..idx].trim().parse().ok()?;
    let unit = input[idx..].trim().to_uppercase();
    let multiplier = match unit.as_str() {
        "KIB" => 1024f64,
        "MIB" => 1024f64 * 1024f64,
        "GIB" => 1024f64 * 1024f64 * 1024f64,
        "KB" => 1000f64,
        "MB" => 1000f64 * 1000f64,
        "GB" => 1000f64 * 1000f64 * 1000f64,
        _ => return None,
    };
    Some((num * multiplier) as u64)
}

/// Parse one line of yt-dlp output into a structured progress update.
pub fn parse_line(line: &str, update: &mut ProgressUpdate) {
    let line = line.trim_end();
    let line = line.trim();

    if line.contains("has already been downloaded") || line.contains("has already been recorded") {
        update.skipped = true;
        update.stage = Some("Skipped".to_string());
        return;
    }

    if let Some(caps) = dest_re().captures(line) {
        update.output_path = Some(caps[1].trim().to_string());
        if line.starts_with("[ExtractAudio]") || line.starts_with("[Merger]") {
            update.stage = Some("Processing".to_string());
            update.percent = None;
        } else {
            update.stage = Some("Downloading".to_string());
        }
        return;
    }

    if let Some(caps) = percent_re().captures(line) {
        if let Ok(p) = caps[1].parse::<f64>() {
            update.percent = Some(p.min(100.0));
        }
        let total = caps[2].trim();
        if let Some(b) = parse_bytes(total) {
            update.total_bytes = Some(b);
            if let Some(p) = update.percent {
                update.downloaded_bytes = Some(((b as f64) * p / 100.0) as u64);
            }
        }
        if let Some(speed) = caps.get(3) {
            update.speed = Some(speed.as_str().to_string());
        }
        if let Some(eta) = caps.get(4) {
            update.eta = Some(eta.as_str().to_string());
        }
        // "in 00:08" means finished downloading this part
        if caps.get(4).is_none() && caps.get(5).is_some() {
            update.percent = Some(100.0);
        }
        // With --no-quiet the [youtube]/[info] lines come first and set
        // "Fetching information"; a progress line means we are past that.
        if update.stage.is_none() || update.stage.as_deref() == Some("Fetching information") {
            update.stage = Some("Downloading".to_string());
        }
        return;
    }

    if let Some(caps) = item_re().captures(line) {
        let cur: u64 = caps[1].parse().unwrap_or(0);
        let total: u64 = caps[2].parse().unwrap_or(0);
        if total > 0 {
            update.percent = Some(((cur - 1) as f64 / total as f64) * 100.0);
        }
        update.stage = Some(format!("Fetching item {cur} of {total}"));
        return;
    }

    if line.starts_with("[download]") {
        update.stage = Some("Downloading".to_string());
        // handle "0.0% of ~ 1.2GiB" style without speed/eta
        let re = Regex::new(r"^\s*\[download\]\s+([0-9.]+)%\s+of\s+(~?\s*[0-9.]+[KMG]?i?B)").unwrap();
        if let Some(caps) = re.captures(line) {
            if let Ok(p) = caps[1].parse::<f64>() {
                update.percent = Some(p.min(100.0));
            }
        }
        return;
    }

    // post-processing / merger / metadata / thumbnail stages
    if line.starts_with("[ExtractAudio]")
        || line.starts_with("[Merger]")
        || line.starts_with("[ffmpeg]")
        || line.starts_with("[EmbedThumbnail]")
        || line.starts_with("[Metadata]")
        || line.starts_with("[VideoRemuxer]")
        || line.starts_with("[Fixup")
        || line.starts_with("[MoveFiles]")
        || line.starts_with("[VideoConvertor]")
    {
        update.stage = Some("Processing".to_string());
        update.percent = None; // percent no longer meaningful during post-processing
        return;
    }

    if line.starts_with("[youtube]") || line.starts_with("[info]") {
        if update.stage.is_none() {
            update.stage = Some("Fetching information".to_string());
        }
        return;
    }

    // bare file path emitted by `--print after_move:filepath`
    if path_re().is_match(line) {
        update.output_path = Some(line.to_string());
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_classic_progress_line() {
        let mut u = ProgressUpdate::default();
        parse_line("[download]  42.3% of 10.00MiB at 1.23MiB/s ETA 00:07", &mut u);
        assert!((u.percent.unwrap() - 42.3).abs() < 0.01);
        assert_eq!(u.total_bytes, Some((10.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(u.speed.as_deref(), Some("1.23MiB/s"));
        assert_eq!(u.eta.as_deref(), Some("00:07"));
    }

    #[test]
    fn parses_complete_line() {
        let mut u = ProgressUpdate::default();
        parse_line("[download] 100% of 5.20MiB in 00:08 at 1.23MiB/s", &mut u);
        assert_eq!(u.percent, Some(100.0));
    }

    #[test]
    fn parses_unknown_total() {
        let mut u = ProgressUpdate::default();
        parse_line("[download]   0.0% of ~ 1.2GiB at 5.00MiB/s ETA 04:05", &mut u);
        assert_eq!(u.percent, Some(0.0));
        assert_eq!(u.total_bytes, None);
        assert_eq!(u.speed.as_deref(), Some("5.00MiB/s"));
    }

    #[test]
    fn parses_destination() {
        let mut u = ProgressUpdate::default();
        parse_line("[download] Destination: C:\\Music\\file.mp3", &mut u);
        assert_eq!(u.output_path.as_deref(), Some("C:\\Music\\file.mp3"));
    }

    #[test]
    fn parses_extract_audio_destination() {
        let mut u = ProgressUpdate::default();
        parse_line("[ExtractAudio] Destination: C:\\Music\\file.mp3", &mut u);
        assert_eq!(u.output_path.as_deref(), Some("C:\\Music\\file.mp3"));
        assert_eq!(u.stage.as_deref(), Some("Processing"));
    }

    #[test]
    fn detects_skipped() {
        let mut u = ProgressUpdate::default();
        parse_line("[download] C:\\Music\\file.mp3 has already been downloaded", &mut u);
        assert!(u.skipped);
    }

    #[test]
    fn parses_playlist_item() {
        let mut u = ProgressUpdate::default();
        parse_line("[info] https://youtube.com/watch?v=abc: Downloading item 2 of 10", &mut u);
        assert!((u.percent.unwrap() - 10.0).abs() < 0.01);
        assert!(u.stage.as_deref().unwrap().contains("item 2"));
    }

    /// Real `yt-dlp --print after_move:filepath --no-quiet -x --audio-format
    /// mp3` stdout (2026.08.19), as the worker reads it.
    #[test]
    fn real_no_quiet_mp3_run_reaches_processing() {
        let lines = [
            "[youtube] Extracting URL: https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "[youtube] jNQXAC9IVRw: Downloading webpage",
            "[info] jNQXAC9IVRw: Downloading 1 format(s): 251",
            "[download] Destination: C:\\Music\\zoo.webm",
            "[download]   0.4% of  246.27KiB at  480.56KiB/s ETA 00:00",
            "[download]  51.6% of  246.27KiB at  311.08KiB/s ETA 00:00",
            "[download] 100% of  246.27KiB in 00:00:02 at 105.69KiB/s",
            "[ExtractAudio] Destination: C:\\Music\\zoo.mp3",
            "Deleting original file C:\\Music\\zoo.webm (pass -k to keep)",
            "C:\\Music\\zoo.mp3",
        ];
        let mut u = ProgressUpdate::default();
        let mut stages = Vec::new();
        for line in lines {
            parse_line(line, &mut u);
            if stages.last() != u.stage.as_ref() {
                stages.push(u.stage.clone().unwrap());
            }
        }
        assert_eq!(stages, ["Fetching information", "Downloading", "Processing"]);
        assert_eq!(u.output_path.as_deref(), Some("C:\\Music\\zoo.mp3"));
        assert!(!u.skipped);
    }

    #[test]
    fn parses_bare_after_move_path() {
        let mut u = ProgressUpdate::default();
        parse_line("C:\\Music\\Amen\\Song Title.mp3", &mut u);
        assert_eq!(u.output_path.as_deref(), Some("C:\\Music\\Amen\\Song Title.mp3"));
    }
}
