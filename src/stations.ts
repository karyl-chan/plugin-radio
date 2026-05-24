/**
 * Curated list of internet radio streams whose operator explicitly
 * allows personal, non-commercial re-streaming. The built-in list is
 * SomaFM-only — see https://somafm.com/about/playradio.html for the
 * listener terms; SomaFM funds the music licensing it serves and is
 * fine with bots that re-stream it to a small Discord audience.
 *
 * If you add a station, the bar to clear is the same: the operator
 * must publicly authorize personal-use redistribution. Don't add
 * stations that just happen to be reachable — many commercial / public
 * broadcasters serve their stream for direct listening only, and a bot
 * rebroadcasting it doesn't fall under that. When in doubt, leave it
 * out and let the library cover that station with manager-uploaded
 * audio the operator owns.
 *
 * Format constraint: direct mp3 / aac / ogg only (no HLS — the ffmpeg
 * pipeline doesn't handle .m3u8 playlists cleanly). Verify the URL
 * serves Content-Type audio/* directly (`curl -I`) before shipping.
 */
export interface Station {
  key: string;
  name: string;
  description: string;
  url: string;
}

export const STATIONS: Station[] = [
  {
    key: "chill",
    name: "SomaFM Groove Salad",
    description: "Ambient / downtempo electronica",
    url: "https://ice2.somafm.com/groovesalad-128-mp3",
  },
  {
    key: "lofi",
    name: "SomaFM Drone Zone",
    description: "Ambient drone / soundscape",
    url: "https://ice4.somafm.com/dronezone-128-mp3",
  },
  {
    key: "jazz",
    name: "SomaFM Sonic Universe",
    description: "Ambient / world / jazz fusion",
    url: "https://ice4.somafm.com/sonicuniverse-128-mp3",
  },
  {
    key: "indie",
    name: "SomaFM Indie Pop Rocks",
    description: "Indie pop / rock",
    url: "https://ice2.somafm.com/indiepop-128-mp3",
  },
  {
    key: "synthwave",
    name: "SomaFM DEF CON Radio",
    description: "Synthwave / cyberpunk",
    url: "https://ice2.somafm.com/defcon-128-mp3",
  },
  {
    key: "classical",
    name: "SomaFM Black Rock FM",
    description: "Burning Man classical / ambient",
    url: "https://ice2.somafm.com/brfm-128-mp3",
  },
  {
    key: "metal",
    name: "SomaFM Metal Detector",
    description: "Heavy / progressive metal",
    url: "https://ice2.somafm.com/metal-128-mp3",
  },
  {
    key: "folk",
    name: "SomaFM Folk Forward",
    description: "Indie folk / Americana",
    url: "https://ice2.somafm.com/folkfwd-128-mp3",
  },
];

export function findStation(key: string): Station | null {
  const norm = key.trim().toLowerCase();
  return STATIONS.find((s) => s.key === norm) ?? null;
}
