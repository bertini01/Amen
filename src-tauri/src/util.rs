use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Sanitize a single path component so it is safe on Windows:
/// - replaces characters invalid in Windows filenames
/// - collapses whitespace, trims trailing dots/spaces
/// - prefixes reserved device names
/// - limits length (bytes) to keep full paths under MAX_PATH
pub fn sanitize_filename_component(name: &str) -> String {
    let mut cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();

    // collapse repeated whitespace
    let mut out = String::with_capacity(cleaned.len());
    let mut prev_space = false;
    for ch in cleaned.chars() {
        if ch == ' ' {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    cleaned = out.trim().trim_end_matches(['.', ' ']).to_string();

    if cleaned.is_empty() {
        return String::new();
    }

    // Reserved device names (CON, PRN, AUX, NUL, COM1.., LPT1..)
    let stem = cleaned.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        cleaned = format!("_{cleaned}");
    }

    // A readable maximum; `build_output_path` also caps the whole path.
    slice_name(&cleaned, MAX_NAME_CHARS, |_| 1)
}

/// Longest file or folder name we produce, in characters.
const MAX_NAME_CHARS: usize = 120;

/// Shorten `name` so its length, counted with `unit` per char, is at most
/// `max`, marking the cut with "…". Cuts at the last space when one is within
/// the last 30 characters, otherwise between characters (never inside an
/// emoji or a multi-byte char), and never leaves trailing spaces or
/// punctuation before the "…".
fn slice_name(name: &str, max: usize, unit: fn(char) -> usize) -> String {
    const ELLIPSIS: char = '\u{2026}';
    const WORD_WINDOW: usize = 30;
    if name.chars().map(unit).sum::<usize>() <= max {
        return name.to_string();
    }
    let budget = max.saturating_sub(unit(ELLIPSIS));
    let mut end = 0;
    let mut used = 0;
    for (i, c) in name.char_indices() {
        if used + unit(c) > budget {
            break;
        }
        used += unit(c);
        end = i + c.len_utf8();
    }
    let hard = &name[..end];
    let cut = if name[end..].starts_with(' ') {
        hard // the cut already falls between two words
    } else {
        match hard.rfind(' ') {
            Some(i) if i > 0 && hard[i..].chars().count() <= WORD_WINDOW => &hard[..i],
            _ => hard,
        }
    };
    let trailing = |c: char| {
        c.is_whitespace()
            || matches!(c, '.' | ',' | ';' | ':' | '-' | '_' | '\u{2013}' | '\u{2014}' | '\u{200D}' | '\u{FE0F}')
    };
    let mut kept = cut.trim_end_matches(trailing);
    if kept.is_empty() {
        kept = hard.trim_end_matches(trailing);
    }
    if kept.is_empty() {
        return String::new();
    }
    format!("{kept}{ELLIPSIS}")
}

/// Apply a yt-dlp style `%(field)s` filename template using provided fields.
/// Missing fields render as empty strings. `%(ext)s` is preserved as-is when
/// present so callers can substitute the actual extension.
pub fn apply_template(template: &str, fields: &HashMap<String, String>) -> String {
    let re = Regex::new(r"%\(([a-zA-Z0-9_]+)\)s").expect("valid regex");
    re.replace_all(template, |caps: &regex::Captures| {
        let key = &caps[1];
        // Only the template's own slashes may create folders. A slash inside a
        // value ("Song A / Song B") used to split the title into a folder and
        // a file, and the recorded path then pointed at the wrong place.
        fields
            .get(key)
            .map(|v| v.replace(['/', '\\'], "-"))
            .unwrap_or_default()
    })
    .to_string()
}

/// Expand `%VAR%` and `${VAR}` environment variables in a path string.
pub fn expand_env(input: &str) -> String {
    let re = Regex::new(r"%(?P<name>[A-Za-z_][A-Za-z0-9_]*)%").expect("valid regex");
    let mut s = re
        .replace_all(input, |caps: &regex::Captures| {
            std::env::var(&caps["name"]).unwrap_or_else(|_| format!("%{}%", &caps["name"]))
        })
        .to_string();
    let re2 = Regex::new(r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)\}").expect("valid regex");
    s = re2
        .replace_all(&s, |caps: &regex::Captures| {
            std::env::var(&caps["name"]).unwrap_or_else(|_| format!("${{{}}}", &caps["name"]))
        })
        .to_string();
    s
}

/// Split the extension (if any) off a rendered filename component.
pub fn split_ext(name: &str) -> (String, Option<String>) {
    match name.rfind('.') {
        Some(idx) if idx > 0 => (
            name[..idx].to_string(),
            Some(name[idx + 1..].to_string()),
        ),
        _ => (name.to_string(), None),
    }
}

/// Build a safe absolute output path from a directory + filename template +
/// metadata fields + extension. Rejects path traversal; sanitizes each component.
pub fn build_output_path(
    output_dir: &str,
    template: &str,
    fields: &HashMap<String, String>,
    ext: &str,
) -> crate::error::AppResult<PathBuf> {
    let expanded_dir = expand_env(output_dir);
    let base = PathBuf::from(expanded_dir);

    let rendered = apply_template(template, fields);
    let mut rendered = rendered.trim().to_string();
    // Ensure the rendered name carries the requested extension
    let (stem, _) = split_ext(&rendered);
    if stem.is_empty() {
        rendered = format!("media.{ext}");
    } else if !rendered.to_lowercase().ends_with(&format!(".{ext}")) {
        // template already had %(ext)s replaced, or lacks an extension
        if !rendered.contains('.') {
            rendered = format!("{rendered}.{ext}");
        } else if !has_known_media_ext(&rendered) {
            rendered = format!("{rendered}.{ext}");
        }
    }

    let components: Vec<&str> = rendered
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .collect();
    if components.is_empty() {
        return Err(crate::error::AppError::config(
            "The filename template did not produce a filename.",
        ));
    }

    let mut path = base;
    for (i, comp) in components.iter().enumerate() {
        let is_last = i == components.len() - 1;
        if !is_last {
            let dir_component = sanitize_filename_component(comp);
            if dir_component == ".." || dir_component == "." || dir_component.is_empty() {
                return Err(crate::error::AppError::config(
                    "The filename template contains invalid path segments.",
                ));
            }
            path = path.join(dir_component);
        } else {
            let (stem, _) = split_ext(comp);
            let mut stem = sanitize_filename_component(&stem);
            // Keep the WHOLE path short enough for yt-dlp's temporary names.
            let used = utf16_len(&path.to_string_lossy()) + 1 + 1 + ext.len();
            let budget = MAX_OUTPUT_PATH.saturating_sub(used);
            if budget < MIN_STEM {
                return Err(crate::error::AppError::config(
                    "The output folder path is too long for Windows. Choose a shorter output folder in Settings.",
                ));
            }
            stem = fit_stem(&stem, budget);
            if stem.is_empty() {
                stem = "media".to_string();
            }
            let fname = format!("{stem}.{ext}");
            path = path.join(fname);
        }
    }
    Ok(path)
}

/// Longest output path we hand to yt-dlp, in UTF-16 units (what Windows
/// counts against MAX_PATH = 260). The margin covers what yt-dlp and we add
/// to the name: ".f251.webm.part", ".temp.mp3", " (12)".
const MAX_OUTPUT_PATH: usize = 230;
/// Shortest filename stem worth keeping; below this the folder is too long.
const MIN_STEM: usize = 16;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Shorten a filename stem to at most `max_units` UTF-16 units (see
/// `slice_name`).
fn fit_stem(stem: &str, max_units: usize) -> String {
    slice_name(stem, max_units, char::len_utf16)
}

fn has_known_media_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["mp3", "mp4", "m4a", "webm", "mkv", "ogg", "opus", "flac", "wav"]
        .iter()
        .any(|e| lower.ends_with(&format!(".{e}")))
}

/// If `path` already exists, return `path`, `name (1).ext`, `name (2).ext`, ...
/// so downloads never silently overwrite an existing file.
pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let (stem, ext) = split_ext(&file_name);
    for n in 1..10_000 {
        let candidate = parent.join(if let Some(e) = &ext {
            format!("{stem} ({n}).{e}")
        } else {
            format!("{stem} ({n})")
        });
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Redact likely-sensitive query parameters from URLs before logging.
pub fn redact_url(url: &str) -> String {
    const SENSITIVE: &[&str] = &[
        "token", "access_token", "auth", "signature", "sig", "key", "api_key", "apikey", "secret",
        "password", "passwd", "cookie", "session", "code", "state", "credential", "refresh_token",
    ];
    let Some((before, after)) = url.split_once('?') else {
        return url.to_string();
    };
    let mut kept: Vec<String> = Vec::new();
    for pair in after.split('&') {
        let key = pair.split('=').next().unwrap_or("").to_lowercase();
        if SENSITIVE.iter().any(|s| key.starts_with(s)) {
            kept.push(format!("{key}=REDACTED"));
        } else {
            kept.push(pair.to_string());
        }
    }
    format!("{before}?{}", kept.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_invalid_chars() {
        let s = sanitize_filename_component("Title: With <Bad> | Chars * ?");
        assert!(!s.contains(':'));
        assert!(!s.contains('<'));
        assert!(!s.contains('|'));
        assert!(!s.contains('*'));
    }

    #[test]
    fn sanitize_handles_reserved_names() {
        assert!(sanitize_filename_component("CON").starts_with('_'));
        assert!(sanitize_filename_component("com1.mp3").starts_with('_'));
        assert_eq!(sanitize_filename_component("normal"), "normal");
    }

    #[test]
    fn sanitize_trims_dots_and_spaces() {
        let s = sanitize_filename_component("  Leading and trailing   ");
        assert_eq!(s, "Leading and trailing");
        assert!(!s.ends_with('.'));
    }

    #[test]
    fn sanitize_empty_falls_back() {
        assert_eq!(sanitize_filename_component("///"), "");
    }

    #[test]
    fn template_replaces_fields() {
        let mut fields = HashMap::new();
        fields.insert("title".to_string(), "Hello World".to_string());
        fields.insert("ext".to_string(), "mp3".to_string());
        assert_eq!(
            apply_template("%(title)s.%(ext)s", &fields),
            "Hello World.mp3"
        );
    }

    #[test]
    fn template_missing_field_empty() {
        let fields = HashMap::new();
        assert_eq!(apply_template("a%(nope)sb", &fields), "ab");
    }

    #[test]
    fn template_with_subdirs() {
        let mut fields = HashMap::new();
        fields.insert("artist".to_string(), "Artist".to_string());
        fields.insert("album".to_string(), "Album".to_string());
        fields.insert("title".to_string(), "Track".to_string());
        fields.insert("ext".to_string(), "mp3".to_string());
        assert_eq!(
            apply_template("%(artist)s/%(album)s/%(title)s.%(ext)s", &fields),
            "Artist/Album/Track.mp3"
        );
    }

    #[test]
    fn build_output_path_subdirs() {
        let mut fields = HashMap::new();
        fields.insert("artist".to_string(), "A".to_string());
        fields.insert("album".to_string(), "B".to_string());
        fields.insert("title".to_string(), "T".to_string());
        fields.insert("ext".to_string(), "mp3".to_string());
        // `build_output_path` normalises separators inside the TEMPLATE, but
        // takes the base directory as given — and `C:\Music` is not a path on
        // Unix, it is one filename containing backslashes. So the base and the
        // expectation both have to be native, or this asserts nothing on Linux.
        let base = if cfg!(windows) { r"C:\Music" } else { "/music" };
        let p = build_output_path(
            base,
            "%(artist)s/%(album)s/%(title)s.%(ext)s",
            &fields,
            "mp3",
        )
        .unwrap();
        let expected = PathBuf::from(base).join("A").join("B").join("T.mp3");
        assert_eq!(p, expected);
    }

    #[test]
    fn build_output_path_rejects_traversal() {
        let mut fields = HashMap::new();
        fields.insert("title".to_string(), "T".to_string());
        let p = build_output_path("C:\\Music", "../%(title)s.%(ext)s", &fields, "mp3");
        assert!(p.is_err());
    }

    fn native_base() -> &'static str {
        if cfg!(windows) {
            r"C:\Users\someone\Music\Amen"
        } else {
            "/home/someone/Music/Amen"
        }
    }

    fn title_path(base: &str, title: &str) -> crate::error::AppResult<PathBuf> {
        let mut fields = HashMap::new();
        fields.insert("title".to_string(), title.to_string());
        fields.insert("ext".to_string(), "mp3".to_string());
        build_output_path(base, "%(title)s.%(ext)s", &fields, "mp3")
    }

    #[test]
    fn titles_never_create_folders_or_escape_the_output_dir() {
        let base = native_base();
        let long = "Very long worship title ".repeat(17); // ~400 chars
        for title in [
            "A / B / C",
            "..\\evil",
            "../../evil",
            "..",
            "CON",
            "trailing dots...",
            "Praise 🙏🙏 🎶 Live",
            "100% Worship %(id)s",
            "C:\\Windows\\system32",
            long.as_str(),
        ] {
            let p = title_path(base, title).unwrap();
            assert_eq!(p.parent(), Some(Path::new(base)), "title {title:?} gave {p:?}");
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.ends_with(".mp3"), "{name}");
            assert!(!name.contains('/') && !name.contains('\\'), "{name}");
            assert!(utf16_len(&p.to_string_lossy()) <= MAX_OUTPUT_PATH, "{p:?}");
        }
        let con = title_path(base, "CON").unwrap();
        assert!(con.file_name().unwrap().to_string_lossy().starts_with('_'));
        let dots = title_path(base, "trailing dots...").unwrap();
        assert_eq!(dots.file_name().unwrap().to_string_lossy(), "trailing dots.mp3");
    }

    #[test]
    fn template_slashes_still_make_folders() {
        let base = native_base();
        let mut fields = HashMap::new();
        fields.insert("artist".to_string(), "AC/DC".to_string());
        fields.insert("title".to_string(), "Back / Black".to_string());
        fields.insert("ext".to_string(), "mp3".to_string());
        let p = build_output_path(base, "%(artist)s/%(title)s.%(ext)s", &fields, "mp3").unwrap();
        assert_eq!(p, PathBuf::from(base).join("AC-DC").join("Back - Black.mp3"));
    }

    #[test]
    fn long_titles_are_cut_to_fit_the_whole_path() {
        // A deep folder plus a long emoji title.
        let deep = format!("{}{}", native_base(), if cfg!(windows) { r"\Deep\Folder\For\Tests" } else { "/Deep/Folder/For/Tests" });
        let title = "🙏".repeat(60) + &"word ".repeat(30);
        let p = title_path(&deep, &title).unwrap();
        let full = p.to_string_lossy().to_string();
        assert!(utf16_len(&full) <= MAX_OUTPUT_PATH, "{} units", utf16_len(&full));
        assert_eq!(p.parent(), Some(Path::new(&deep)));
        let stem = p.file_stem().unwrap().to_string_lossy().to_string();
        assert!(stem.ends_with('…'), "{stem}");
        // Cut between characters: no broken surrogate became U+FFFD.
        assert!(!stem.contains('\u{FFFD}'));
        assert!(stem.chars().count() >= MIN_STEM / 2);
    }

    #[test]
    fn fit_stem_cuts_on_char_boundaries() {
        assert_eq!(fit_stem("short", 10), "short");
        // "…" is one unit, an emoji two.
        assert_eq!(fit_stem("abc 🙏🙏", 5), "abc…");
        assert_eq!(fit_stem("abcdefgh", 5), "abcd…");
        assert_eq!(fit_stem("ab.. cd", 4), "ab…");
        assert_eq!(fit_stem("a\u{1F468}\u{200D}\u{1F469}", 4), "a\u{1F468}…");
    }

    #[test]
    fn long_names_are_sliced_readably_at_a_word() {
        let long = "Very long worship title ".repeat(17); // 408 chars
        let s = sanitize_filename_component(&long);
        assert!(s.chars().count() <= MAX_NAME_CHARS, "{}", s.chars().count());
        assert!(s.ends_with('…'));
        assert!(s.ends_with("title…") || s.ends_with("worship…") || s.ends_with("long…") || s.ends_with("Very…"), "{s}");
        // Idempotent: the sliced name passes sanitizing unchanged.
        assert_eq!(sanitize_filename_component(&s), s);

        // Emoji-heavy, 125 chars: shortened without splitting any emoji.
        let emoji = "🙏🎶 Praise ".repeat(12) + "🙏🙏🙏🙏🙏";
        assert_eq!(emoji.chars().count(), 125);
        let s = sanitize_filename_component(&emoji);
        assert!(s.chars().count() <= MAX_NAME_CHARS);
        assert!(s.ends_with("Praise…"), "{s}");
        assert!(!s.contains('\u{FFFD}'));
        assert_eq!(sanitize_filename_component(&s), s);

        // No spaces at all: a hard cut on a char boundary.
        let solid = "é".repeat(200);
        let s = sanitize_filename_component(&solid);
        assert_eq!(s.chars().count(), MAX_NAME_CHARS);
        assert_eq!(s, "é".repeat(MAX_NAME_CHARS - 1) + "…");

        // Short names are untouched.
        assert_eq!(sanitize_filename_component("Amazing Grace"), "Amazing Grace");
    }

    #[test]
    fn a_too_long_output_folder_is_a_clear_error() {
        let base = format!("{}{}", native_base(), if cfg!(windows) { "\\x" } else { "/x" }.repeat(100));
        let err = title_path(&base, "Song").unwrap_err();
        assert!(err.message.contains("output folder path is too long"));
    }

    #[test]
    fn expand_env_windows_syntax() {
        std::env::set_var("TEST_VAR_LMS", "value");
        assert_eq!(expand_env("%TEST_VAR_LMS%/x"), "value/x");
        assert_eq!(expand_env("${TEST_VAR_LMS}/x"), "value/x");
    }

    #[test]
    fn unique_path_suffix() {
        let dir = std::env::temp_dir().join("lms_unique_test");
        std::fs::create_dir_all(&dir).unwrap();
        let f1 = dir.join("song.mp3");
        std::fs::write(&f1, b"x").unwrap();
        let u = unique_path(&f1);
        assert_ne!(u, f1);
        assert!(u.to_string_lossy().contains("(1)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn redact_url_removes_tokens() {
        let u = redact_url("https://x.com/v?token=abc&v=1&sig=zzz");
        assert!(!u.contains("abc"));
        assert!(!u.contains("zzz"));
        assert!(u.contains("token=REDACTED"));
        assert!(u.contains("v=1"));
    }

    #[test]
    fn redact_url_passthrough_without_query() {
        assert_eq!(redact_url("https://youtube.com/watch?v=abc"), "https://youtube.com/watch?v=abc");
    }
}
