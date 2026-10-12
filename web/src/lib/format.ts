/**
 * Display formatting shared across the UI.
 *
 * Kept apart from the API client on purpose: this is presentation logic, and the
 * one rule it exists to enforce is that every duration, byte count and timestamp
 * in the app is rendered the same way. Scattered `toFixed(0)` calls drift.
 */

/**
 * Human byte count.
 *
 * Uses 1024-based units with the labels Windows and macOS both show, rather than
 * the 1000-based ones a hard drive advertises: this app measures downloaded
 * video files, and every browser download shelf in the OS agrees on 1024.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '--';
  }
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  // Clamped because a value past TB would index past the array.
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;

  // One decimal below 10, none above: "9.4 GB" reads better than "9.41 GB", but
  // "847 MB" beats "847.3 MB".
  const digits = exponent === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/**
 * Seconds as `H:MM:SS` / `M:SS`.
 *
 * `Number.isFinite` guards against the NaN that a live stream reports for its
 * duration before any metadata has loaded -- rendering that would put "NaN:NaN"
 * on the screen.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Rough runtime for a feature, from the provider's own estimate.
 *
 * The upstream field arrives in assorted shapes (`"1h 58m"`, `"118 min"`,
 * `"PT2H"`), so this normalises rather than trusting one format.
 */
export function formatRuntime(raw: string | null | undefined): string {
  if (!raw) return '';

  // ISO-8601 duration, the DASH `<duration>` field.
  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(raw.trim());
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    const hours = Number(iso[2] ?? 0);
    const minutes = Number(iso[3] ?? 0);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  // `"1h 58m"` and friends -- keep whatever is already readable.
  if (/\d+\s*[hms]/i.test(raw)) return raw.trim();

  // Bare minutes, which is what most providers actually send.
  const minutes = Number.parseFloat(raw);
  if (Number.isFinite(minutes) && minutes > 0) {
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
  }

  return raw.trim();
}

/**
 * "3d ago", "just now".
 *
 * Used for watch history, where the exact second is never interesting but
 * "when did I last watch this" always is. `Intl.RelativeTimeFormat` is used
 * rather than a hand-rolled table so the wording matches the user's locale.
 */
export function formatRelativeTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return '';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const deltaSeconds = unixSeconds - Date.now() / 1000;

  // Thresholds chosen so the unit never obscures the order of magnitude.
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.348],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = deltaSeconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) {
      return formatter.format(Math.round(value), unit);
    }
    value /= size;
  }
  return formatter.format(Math.round(value), 'year');
}

/** Transfer rate, e.g. `4.2 MB/s`. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Completion as a whole-number percentage, clamped.
 *
 * Clamping matters: a stream whose reported duration briefly underruns its
 * position would otherwise produce a progress bar wider than its track.
 */
export function formatPercent(fraction: number | null | undefined): number {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/**
 * Seconds left in an episode, as a rough ETA.
 *
 * Based on average throughput rather than instantaneous speed: segment speeds
 * fluctuate wildly on a CDN, and an ETA that swings between 2 and 40 minutes is
 * worse than one that is consistently a little off.
 */
export function formatEta(
  remainingBytes: number | null | undefined,
  bytesPerSecond: number | null | undefined,
): string {
  if (!remainingBytes || !bytesPerSecond || bytesPerSecond <= 0) return '--';
  return formatDuration(remainingBytes / bytesPerSecond);
}

/**
 * A title for a poster card's tooltip and accessible name.
 *
 * Falls back through progressively less useful text so a card is never
 * unlabelled: providers occasionally return an item with no title at all.
 */
/**
 * A title as it should appear next to a year: `Chernobyl (2019)`.
 *
 * The one place a year is appended to a title, and it runs the title through
 * [`cleanTitle`] first. This existed but nothing called it, and every caller
 * instead inlined `` `${title}${year ? ` (${year})` : ''}` `` -- four copies that
 * each forgot the title cleaning, so resume and favourite rows showed
 * `Chernobyl [Hindi][CAM] (2019)` while poster cards showed `Chernobyl`. The
 * duplication was the bug; this function is the fix.
 */
export function describeTitle(
  title: string | null | undefined,
  year: string | null | undefined,
): string {
  const clean = cleanTitle(title);
  return year ? `${clean} (${year})` : clean;
}

/** One bracketed group sitting at the very end of a title, with its lead-in space. */
const TRAILING_GROUP = /\s*[\[(][^\])]*[\])]\s*$/;

/** A bracketed group holding nothing but a four-digit year. */
const BRACKETED_YEAR = /^[\[(]\d{4}[\])]$/;

/**
 * Strip the release noise MovieBox appends to every title.
 *
 * `[Hindi]`, `[CAM]`, `[Full movie]` and friends are delivery metadata, not part
 * of the name, and they make a poster grid look like a search result page.
 *
 * ## Why it peels one group at a time
 *
 * Titles arrive as a *run* of trailing groups, and the run has to come off
 * together:
 *
 * | Upstream                        | Shown      |
 * |---------------------------------|------------|
 * | `Drishyam [Hindi][CAM]`         | `Drishyam` |
 * | `Midnight [18+] [Hindi]`        | `Midnight` |
 * | `KGF 2 [Hindi][CAM][1080p]`     | `KGF 2`    |
 *
 * A single pattern that matches the whole run cannot be used, because a year has
 * to *stop* it. `The Matrix (1999) [Hindi][CAM]` must lose the last two groups and
 * keep `(1999)`, and no single `(...)+$` regex can both span the run and decline
 * to span part of it. So each iteration takes off exactly the last group and then
 * re-tests, which gives the year a natural place to halt the loop.
 *
 * Peeling also sidesteps the trap a single-run pattern walks into: with the
 * separator `\s*` outside the repeated group, `Midnight [18+] [Hindi]` can only
 * ever match `[Hindi]`, because the repetition halts at the space before
 * `[18+]`.
 *
 * ## What survives
 *
 * A group holding only a four-digit year is the title, not noise, so it and
 * everything to its left are left alone: `Aliens (1986)` and `Black Mirror
 * (2011)` are already correct. A bracketed word in the *middle* of a title is
 * part of the name and is never touched, since only a suffix is ever examined.
 *
 * This is a presentation concern only; search and the API keep the raw title.
 */
export function cleanTitle(title: string | null | undefined): string {
  let text = (title ?? '').replace(/\s{2,}/g, ' ').trim();

  // Bounded by the string shrinking every pass, so this always terminates: each
  // iteration removes at least one character.
  for (;;) {
    const match = TRAILING_GROUP.exec(text);
    if (!match) break;

    const group = match[0].trim();
    // The year is the end of the title. Anything after it was noise, anything
    // before it is the name.
    if (BRACKETED_YEAR.test(group)) break;

    text = text.slice(0, match.index).trim();
  }

  // Reached by a title that was *only* noise (`[CAM]`), or by blank input --
  // `trim()` on whitespace leaves `''`, and an empty `h3` is worse than a
  // placeholder.
  return text || 'Untitled';
}

/**
 * Extracts dub, edition, audio, or season tags from raw title
 * (e.g., "[Hindi]", "[English]", "S1-S2", "[Hindi Dub]") so distinct variants
 * with identical base names can be clearly identified in search/grids.
 */
export function extractEditionTags(rawTitle: string | null | undefined): string[] {
  if (!rawTitle) return [];
  const tags: string[] = [];
  const bracketMatches = rawTitle.matchAll(/[\[(]([^\])]+)[\])]/g);
  for (const m of bracketMatches) {
    const content = m[1].trim();
    // Exclude 4-digit release year
    if (/^\d{4}$/.test(content)) continue;
    // Exclude basic noise like CAM / HD / TS
    if (/^(cam|hdcam|hd-ts|ts|hd|uhd|1080p|720p|4k)$/i.test(content)) continue;
    tags.push(content);
  }

  // Also check unbracketed season spans like "S1-S2", "S4", "Season 2"
  const seasonMatch = rawTitle.match(/\b(S\d+(?:-S?\d+)?|Season\s*\d+)\b/i);
  if (seasonMatch && !tags.some((t) => t.toLowerCase().includes(seasonMatch[1].toLowerCase()))) {
    tags.push(seasonMatch[1]);
  }

  return tags;
}