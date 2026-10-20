import { describe, it, expect } from "vitest";
import { isHttpUrl, normalizeUrl, looksLikePlaylist, isSpotifyLink } from "@/lib/url";

describe("isHttpUrl", () => {
   it("accepts http and https URLs", () => {
      expect(isHttpUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
      expect(isHttpUrl("http://example.com/x")).toBe(true);
   });

   it("rejects non-URLs and other schemes", () => {
      expect(isHttpUrl("not a url")).toBe(false);
      expect(isHttpUrl("ftp://example.com")).toBe(false);
      expect(isHttpUrl("")).toBe(false);
      expect(isHttpUrl("youtube.com/watch?v=abc")).toBe(false);
   });
});

describe("normalizeUrl", () => {
   it("trims whitespace", () => {
      expect(normalizeUrl("  https://youtube.com/watch?v=abc  ")).toBe(
         "https://youtube.com/watch?v=abc",
      );
   });

   it("strips tracking params from YouTube", () => {
      const out = normalizeUrl(
         "https://www.youtube.com/watch?v=abc123&si=xyz&feature=share&utm_source=foo",
      );
      expect(out).toContain("v=abc123");
      expect(out).not.toContain("si=");
      expect(out).not.toContain("feature=");
      expect(out).not.toContain("utm_");
   });

   it("keeps meaningful params", () => {
      const out = normalizeUrl(
         "https://www.youtube.com/watch?v=abc&list=PL123&index=3",
      );
      expect(out).toContain("list=PL123");
      expect(out).toContain("index=3");
   });

   it("normalizes youtu.be short links", () => {
      const out = normalizeUrl("https://youtu.be/abc123?si=x");
      expect(out).toContain("watch?v=abc123");
   });

   it("leaves non-YouTube URLs unchanged", () => {
      const url = "https://soundcloud.com/someone/track?x=1";
      expect(normalizeUrl(url)).toBe(url);
   });
});

describe("looksLikePlaylist", () => {
   it("detects playlist URLs", () => {
      expect(
         looksLikePlaylist("https://www.youtube.com/playlist?list=PL123"),
      ).toBe(true);
      expect(
         looksLikePlaylist("https://www.youtube.com/watch?v=abc&list=PL123"),
      ).toBe(true);
   });

   it("does not flag plain videos", () => {
      expect(looksLikePlaylist("https://www.youtube.com/watch?v=abc")).toBe(
         false,
      );
   });
});

describe("isSpotifyLink", () => {
   it("recognises Spotify songs, albums, playlists and short links", () => {
      expect(isSpotifyLink("https://open.spotify.com/track/5S4dgXbimAi4uWAcVPuS0w?si=3e5f")).toBe(true);
      expect(isSpotifyLink("https://open.spotify.com/intl-fr/album/4SZko61aMnmgvNhfhgTuD3")).toBe(true);
      expect(isSpotifyLink("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")).toBe(true);
      expect(isSpotifyLink("https://spotify.link/abc123")).toBe(true);
   });
   it("leaves other links and searches alone", () => {
      expect(isSpotifyLink("https://www.youtube.com/watch?v=abc")).toBe(false);
      expect(isSpotifyLink("spotify wagendanye natwe")).toBe(false);
   });
});
