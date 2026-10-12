/**
 * Track model for the custom player.
 *
 * Shaka's `shaka.extern.Track` is a large struct with two dozen fields, most of
 * which the UI never looks at. Declaring the slice we actually read keeps the
 * player components honest about what they depend on and lets a track obtained
 * from `addTextTrackAsync` be treated exactly like one parsed out of the
 * manifest.
 *
 * Every field is optional-safe (`| null`) because Shaka leaves fields unset for
 * kinds they do not apply to: an audio track has no `height`, a text track has
 * no `bandwidth`.
 */

/** A video, audio or text rendition as Shaka reports it. */
export interface ShakaTrack {
  /** Stable within one player instance. */
  id: number;
  active: boolean;
  type: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  language: string;
  /** Shaka synthesises this from the manifest's `<Label>` or the language. */
  label: string | null;
  channelsCount: number | null;
  /** Text only: `subtitles`, `captions`, `descriptions`, ... */
  kind: string | null;
  mimeType: string | null;
  codecs: string | null;
  /** True for tracks registered through `addTextTrackAsync`. */
  isExternal?: boolean;
}

/** The subset of `shaka.Player` this UI drives. */
export interface PlayerLike {
  getVariantTracks(): ShakaTrack[];
  getTextTracks(): ShakaTrack[];
  getAudioTracks(): ShakaTrack[];
  configure(config: Record<string, unknown>): void;
  selectVariantTrack(track: ShakaTrack, clearBuffer?: boolean): void;
  selectTextTrack(track: ShakaTrack | null): void;
  selectAudioTrack(track: ShakaTrack): void;
  setTextTrackVisibility(visible: boolean): void;
  isTextTrackVisible(): boolean;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  addTextTrackAsync(
    uri: string,
    language: string,
    kind: string,
    mimeType?: string,
    codec?: string,
    label?: string,
    forced?: boolean,
  ): Promise<ShakaTrack>;
}

/** One distinct video height, as offered in the quality menu. */
export interface QualityOption {
  height: number;
  /** The rendition Shaka should play for this height, highest bitrate first. */
  best: ShakaTrack;
  /** How many renditions share this height. */
  count: number;
}

/** The label a variant is shown under: `1080p`, or its bitrate when heightless. */
export function variantLabel(track: ShakaTrack): string {
  if (track.height) return `${track.height}p`;
  if (track.bandwidth) return `${Math.round(track.bandwidth / 1000)} kbps`;
  return 'Unknown';
}

/**
 * Collapse variant tracks to one entry per height, sorted high to low.
 *
 * Shaka exposes every rendition separately (a 1080p track can exist at three
 * bitrates). A quality menu that lists all of them is unreadable and asks the
 * user to choose a bitrate they cannot meaningfully compare. Grouping by height
 * is what every streaming UI does, and the entry keeps the highest-bitrate
 * rendition for that height so picking it means "best 1080p".
 */
export function qualityOptions(variants: ShakaTrack[]): QualityOption[] {
  const byHeight = new Map<number, QualityOption>();
  for (const track of variants) {
    if (!track.height) continue;
    const existing = byHeight.get(track.height);
    if (!existing) {
      byHeight.set(track.height, { height: track.height, best: track, count: 1 });
      continue;
    }
    existing.count += 1;
    if (track.bandwidth > existing.best.bandwidth) existing.best = track;
  }
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

/** The height of the rendition currently playing, if one is. */
export function activeHeight(variants: ShakaTrack[]): number | null {
  const active = variants.find((t) => t.active);
  return active?.height ?? null;
}

/**
 * The `mimeType` to hand `addTextTrackAsync` for a subtitle URL.
 *
 * Matched on the file extension rather than the HTTP `Content-Type`: MovieBox
 * serves `.srt` as `text/plain` and `.ass` as `application/octet-stream`, and
 * Shaka picks its parser from the argument we pass, not the response header.
 * `text/srt` / `text/x-ssa` are the spellings Shaka registers internally.
 */
export function subtitleMime(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* fallback to raw url */
  }
  const clean = decoded.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.vtt')) return 'text/vtt';
  if (clean.endsWith('.ass') || clean.endsWith('.ssa')) return 'text/x-ssa';
  return 'text/srt';
}

/** A human language name from a filename, for a subtitle track's tooltip. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  eng: 'English',
  english: 'English',
  ur: 'Urdu',
  urd: 'Urdu',
  urdu: 'Urdu',
  hi: 'Hindi',
  hin: 'Hindi',
  hindi: 'Hindi',
  ar: 'Arabic',
  ara: 'Arabic',
  arabic: 'Arabic',
  es: 'Spanish',
  spa: 'Spanish',
  spanish: 'Spanish',
  fr: 'French',
  fra: 'French',
  fre: 'French',
  french: 'French',
  de: 'German',
  ger: 'German',
  deu: 'German',
  german: 'German',
  pt: 'Portuguese',
  por: 'Portuguese',
  bn: 'Bengali',
  ben: 'Bengali',
  ta: 'Tamil',
  tam: 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  ko: 'Korean',
  kor: 'Korean',
  ja: 'Japanese',
  jpn: 'Japanese',
  zh: 'Chinese',
  zho: 'Chinese',
  chi: 'Chinese',
  ru: 'Russian',
  rus: 'Russian',
  tr: 'Turkish',
  tur: 'Turkish',
  id: 'Indonesian',
  ind: 'Indonesian',
  fa: 'Persian',
  per: 'Persian',
  fas: 'Persian',
  th: 'Thai',
  tha: 'Thai',
  vi: 'Vietnamese',
  vie: 'Vietnamese',
  it: 'Italian',
  ita: 'Italian',
};

/**
 * Best-effort BCP-47 language tag for a subtitle, from its display name or URL.
 *
 * The provider's subtitle list carries no language field — only a display name
 * and a URL — so the tag is reverse-engineered. A miss falls back to `und`
 * (undetermined), which is a valid BCP-47 tag and avoids inventing a language
 * the subtitle is not in.
 */
export function inferLanguage(name: string, url: string): string {
  const haystack = `${name} ${url.split(/[?#]/)[0]}`.toLowerCase();
  for (const token of haystack.split(/[^a-z]+/).filter(Boolean)) {
    const label = LANGUAGE_NAMES[token];
    if (!label) continue;
    // Prefer the two-letter code for whichever language was matched, so
    // "english", "en" and "eng" all collapse to `en`.
    const twoLetter = Object.keys(LANGUAGE_NAMES).find(
      (code) => code.length === 2 && LANGUAGE_NAMES[code] === label,
    );
    if (twoLetter) return twoLetter;
  }
  return 'und';
}
