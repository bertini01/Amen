//! Links from DRM-protected streaming services.
//!
//! Spotify (like Apple Music, Tidal or Deezer) encrypts its audio, and yt-dlp
//! deliberately refuses those sites. What Amen can do is read the PUBLIC
//! description of a song, album or playlist (title, artists, length) from the
//! service's embed page, so the user can search for the same song on a site
//! that allows saving and choose a result themselves. Nothing here touches the
//! protected audio.

use crate::error::{AppError, AppResult};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub title: String,
    pub artists: String,
    /// Seconds.
    pub duration: Option<f64>,
    /// What to search for to find this song elsewhere.
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicLink {
    pub service: String,
    /// "track", "album" or "playlist".
    pub kind: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub url: String,
    pub tracks: Vec<MusicTrack>,
}

/// Streaming services whose audio is DRM-protected, by host suffix.
const PROTECTED_SERVICES: [(&str, &str); 6] = [
    ("spotify.com", "Spotify"),
    ("spotify.link", "Spotify"),
    ("music.apple.com", "Apple Music"),
    ("tidal.com", "Tidal"),
    ("deezer.com", "Deezer"),
    ("music.amazon.", "Amazon Music"),
];

/// The protected service a link belongs to, if any.
pub fn protected_service(url: &str) -> Option<&'static str> {
    if url.trim().starts_with("spotify:") {
        return Some("Spotify");
    }
    let re = Regex::new(r"(?i)^https?://([^/:?#]+)").expect("valid regex");
    let host = re.captures(url.trim())?[1].to_lowercase();
    PROTECTED_SERVICES
        .iter()
        .find(|(service_host, _)| host.contains(service_host))
        .map(|(_, name)| *name)
}

/// `(kind, id)` from an open.spotify.com URL or a `spotify:kind:id` URI.
pub fn parse_spotify(input: &str) -> Option<(String, String)> {
    let re = Regex::new(
        r"(?:open\.spotify\.com/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:embed/)?|spotify:)(track|album|playlist|artist)[/:]([A-Za-z0-9]{10,40})",
    )
    .expect("valid regex");
    let caps = re.captures(input)?;
    Some((caps[1].to_string(), caps[2].to_string()))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20))
        // The embed page is served to browsers; a browser-like agent gets the
        // same public markup a visitor would see.
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        .build()
}

fn fetch(url: &str) -> AppResult<String> {
    agent()
        .get(url)
        .call()
        .map_err(|e| {
            AppError::with_detail(
                "spotify_unreachable",
                "Couldn't reach Spotify. Check your connection and try again.",
                e.to_string(),
            )
        })?
        .into_string()
        .map_err(|e| AppError::with_detail("spotify_unreachable", "Spotify sent an unreadable page.", e.to_string()))
}

/// Resolve a Spotify link to the songs it describes.
pub fn resolve_spotify(input: &str) -> AppResult<MusicLink> {
    let input = input.trim();
    let (kind, id) = match parse_spotify(input) {
        Some(found) => found,
        // Short links (spotify.link/…) are a page that forwards to the real one.
        None if input.contains("spotify.link") => {
            let page = fetch(input)?;
            parse_spotify(&page).ok_or_else(not_a_song_link)?
        }
        None => return Err(not_a_song_link()),
    };
    if kind == "artist" {
        return Err(AppError::new(
            "spotify_artist",
            "That's an artist page. Paste a link to a song, album or playlist instead.",
        ));
    }
    let page = fetch(&format!("https://open.spotify.com/embed/{kind}/{id}"))?;
    let entity = embed_entity(&page).ok_or_else(|| {
        AppError::new(
            "spotify_unreadable",
            "Couldn't read that Spotify link. It may be private, removed, or unavailable in your region.",
        )
    })?;
    let link = parse_entity(&entity, &kind, &format!("https://open.spotify.com/{kind}/{id}"));
    if link.tracks.is_empty() {
        return Err(AppError::new("spotify_empty", "That Spotify link has no songs Amen can look up."));
    }
    Ok(link)
}

fn not_a_song_link() -> AppError {
    AppError::new(
        "spotify_link",
        "That doesn't look like a Spotify song, album or playlist link.",
    )
}

/// The page's embedded JSON description (Next.js `__NEXT_DATA__`).
fn embed_entity(page: &str) -> Option<Value> {
    let re = Regex::new(r#"(?s)<script id="__NEXT_DATA__" type="application/json">(.*?)</script>"#).ok()?;
    let json: Value = serde_json::from_str(re.captures(page)?.get(1)?.as_str()).ok()?;
    let entity = json.pointer("/props/pageProps/state/data/entity")?.clone();
    entity.is_object().then_some(entity)
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn seconds(v: &Value) -> Option<f64> {
    v.get("duration").and_then(Value::as_f64).filter(|ms| *ms > 0.0).map(|ms| ms / 1000.0)
}

fn make_track(title: String, artists: String, duration: Option<f64>) -> MusicTrack {
    let query = if artists.is_empty() { title.clone() } else { format!("{artists} - {title}") };
    MusicTrack { title, artists, duration, query }
}

fn cover(entity: &Value) -> Option<String> {
    let from_cover_art = entity
        .pointer("/coverArt/sources")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find_map(|s| text(s, "url")));
    let from_identity = entity
        .pointer("/visualIdentity/image")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .max_by_key(|i| i.get("maxWidth").and_then(Value::as_u64).unwrap_or(0))
                .and_then(|i| text(i, "url"))
        });
    from_cover_art.or(from_identity)
}

fn parse_entity(entity: &Value, kind: &str, url: &str) -> MusicLink {
    let title = text(entity, "title")
        .or_else(|| text(entity, "name"))
        .unwrap_or_else(|| "Spotify".to_string());

    let tracks: Vec<MusicTrack> = if kind == "track" {
        let artists = entity
            .get("artists")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| text(x, "name")).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        vec![make_track(title.clone(), artists, seconds(entity))]
    } else {
        entity
            .get("trackList")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|t| {
                        let name = text(t, "title")?;
                        Some(make_track(name, text(t, "subtitle").unwrap_or_default(), seconds(t)))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    let subtitle = match kind {
        "track" => tracks.first().map(|t| t.artists.clone()).filter(|s| !s.is_empty()),
        _ => text(entity, "subtitle"),
    };

    MusicLink {
        service: "Spotify".to_string(),
        kind: kind.to_string(),
        title,
        subtitle,
        cover: cover(entity),
        url: url.to_string(),
        tracks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognises_spotify_links_in_every_shape() {
        let id = "5S4dgXbimAi4uWAcVPuS0w";
        for link in [
            format!("https://open.spotify.com/track/{id}?si=3e5f2f24b9664e8e"),
            format!("https://open.spotify.com/intl-fr/track/{id}"),
            format!("https://open.spotify.com/embed/track/{id}"),
            format!("spotify:track:{id}"),
        ] {
            assert_eq!(parse_spotify(&link), Some(("track".into(), id.into())), "{link}");
        }
        assert_eq!(
            parse_spotify("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
            Some(("playlist".into(), "37i9dQZF1DXcBWIGoYBM5M".into()))
        );
        assert_eq!(parse_spotify("https://www.youtube.com/watch?v=abc"), None);
    }

    #[test]
    fn flags_protected_services_only() {
        assert_eq!(protected_service("https://open.spotify.com/track/x"), Some("Spotify"));
        assert_eq!(protected_service("https://music.apple.com/us/album/x"), Some("Apple Music"));
        assert_eq!(protected_service("https://www.deezer.com/track/1"), Some("Deezer"));
        assert_eq!(protected_service("https://soundcloud.com/a/b"), None);
        assert_eq!(protected_service("https://www.youtube.com/watch?v=x"), None);
    }

    #[test]
    fn reads_a_track_entity() {
        let e = json!({
            "title": "Wagendanye Natwe",
            "artists": [{"name": "Calvary Worship Team"}],
            "duration": 669382,
            "visualIdentity": {"image": [
                {"url": "small", "maxWidth": 64},
                {"url": "big", "maxWidth": 300}
            ]}
        });
        let link = parse_entity(&e, "track", "u");
        assert_eq!(link.subtitle.as_deref(), Some("Calvary Worship Team"));
        assert_eq!(link.cover.as_deref(), Some("big"));
        assert_eq!(link.tracks.len(), 1);
        let t = &link.tracks[0];
        assert_eq!(t.query, "Calvary Worship Team - Wagendanye Natwe");
        assert!((t.duration.unwrap() - 669.382).abs() < 1e-6);
    }

    #[test]
    fn reads_a_playlist_entity() {
        let e = json!({
            "title": "Today's Top Hits",
            "subtitle": "Spotify",
            "coverArt": {"sources": [{"url": "cover"}]},
            "trackList": [
                {"title": "Song A", "subtitle": "Artist 1, Artist 2", "duration": 200000},
                {"title": "", "subtitle": "skipped"},
                {"title": "Song B", "subtitle": "Artist 3"}
            ]
        });
        let link = parse_entity(&e, "playlist", "u");
        assert_eq!(link.cover.as_deref(), Some("cover"));
        assert_eq!(link.tracks.len(), 2);
        assert_eq!(link.tracks[1].duration, None);
        assert_eq!(link.tracks[0].query, "Artist 1, Artist 2 - Song A");
    }
}
