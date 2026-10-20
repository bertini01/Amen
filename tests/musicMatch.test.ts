import { describe, expect, it } from "vitest";
import { describeDelta, rankMatches } from "../src/lib/musicMatch";
import type { MediaInfo, MusicTrack } from "../src/lib/types";

function media(over: Partial<MediaInfo>): MediaInfo {
   return {
      id: null, title: null, uploader: null, channel: null, duration: null, viewCount: null,
      uploadDate: null, thumbnail: null, webpageUrl: null, originalUrl: null, extractor: null,
      extractorKey: null, description: null, album: null, artist: null, track: null,
      releaseDate: null, genre: null, trackNumber: null, availability: null, ageLimit: null,
      playlistIndex: null, bestAudioBitrate: null, bestAudioFormat: null, formats: [],
      ...over,
   };
}

const track: MusicTrack = {
   title: "Wagendanye Natwe",
   artists: "Calvary Worship Team",
   duration: 669,
   query: "Calvary Worship Team - Wagendanye Natwe",
};

describe("rankMatches", () => {
   it("prefers the same song at the same length over a live or cover version", () => {
      const ranked = rankMatches(track, [
         media({ id: "cover", title: "Wagendanye Natwe (cover)", duration: 300 }),
         media({ id: "live", title: "Wagendanye Natwe LIVE - Calvary Worship Team", duration: 900 }),
         media({ id: "real", title: "Wagendanye Natwe", channel: "Calvary Worship Team", duration: 670 }),
         media({ id: "other", title: "Another song entirely", duration: 669 }),
      ]);
      expect(ranked[0].media.id).toBe("real");
      expect(ranked.at(-1)?.media.id).not.toBe("real");
   });

   it("keeps a live version first when the requested song is itself live", () => {
      const live = { ...track, title: "Wagendanye Natwe (Live)" };
      const ranked = rankMatches(live, [
         media({ id: "studio", title: "Wagendanye Natwe", duration: 669 }),
         media({ id: "live", title: "Wagendanye Natwe (Live)", duration: 669 }),
      ]);
      expect(ranked[0].media.id).toBe("live");
   });

   it("keeps search order when nothing distinguishes the results", () => {
      const ranked = rankMatches({ ...track, duration: null }, [
         media({ id: "a", title: "x" }),
         media({ id: "b", title: "y" }),
      ]);
      expect(ranked.map((r) => r.media.id)).toEqual(["a", "b"]);
   });
});

describe("describeDelta", () => {
   it("labels length differences for people", () => {
      expect(describeDelta(null)).toBeNull();
      expect(describeDelta(2)).toBe("Same length");
      expect(describeDelta(12)).toBe("12s longer");
      expect(describeDelta(-65)).toBe("1:05 shorter");
   });
});
