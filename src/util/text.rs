//! Language, duration and size formatting helpers.
//!
//! Ported verbatim from the TUI's `src/tui/text.rs` so subtitle ordering and
//! history progress rendering stay identical between the two front-ends.

/// Language aliases, grouped as `(canonical label, accepted spellings)`.
///
/// Kept as data rather than a `match` so the lookup can be run twice — see
/// [`sanitize_language_label`].
const LANGUAGE_ALIASES: &[(&str, &[&str])] = &[
    ("Arabic", &["العربية", "Arabic", "ara", "ar"]),
    ("Urdu", &["اردو", "أردو", "Urdu", "urd", "ur"]),
    ("Bengali", &["বাংলা", "Bengali", "ben", "bn"]),
    ("Hindi", &["हिन्दी", "हिंदी", "Hindi", "hin", "hi"]),
    ("Filipino", &["Filipino", "Tagalog", "fil", "tl"]),
    ("Indonesian", &["Indonesian", "ind", "id", "in_id"]),
    ("English", &["English", "eng", "en"]),
    ("Spanish", &["Español", "Spanish", "spa", "es"]),
    ("French", &["Français", "French", "fra", "fre", "fr"]),
    ("German", &["Deutsch", "German", "deu", "ger", "de"]),
    ("Italian", &["Italiano", "Italian", "ita", "it"]),
    ("Portuguese", &["Português", "Portuguese", "por", "pt"]),
    ("Russian", &["Русский", "Russian", "rus", "ru"]),
    ("Turkish", &["Türkçe", "Turkish", "tur", "tr"]),
    ("Vietnamese", &["Tiếng Việt", "Vietnamese", "vie", "vi"]),
    ("Chinese", &["中文", "Chinese", "zho", "chi", "zh"]),
    ("Japanese", &["日本語", "Japanese", "jpn", "ja"]),
    ("Korean", &["한국어", "Korean", "kor", "ko"]),
    ("Thai", &["ไทย", "Thai", "tha", "th"]),
    ("Tamil", &["தமிழ்", "Tamil", "tam", "ta"]),
    ("Telugu", &["తెలుగు", "Telugu", "tel", "te"]),
    ("Malayalam", &["മലയാളം", "Malayalam", "mal", "ml"]),
    ("Kannada", &["ಕನ್ನಡ", "Kannada", "kan", "kn"]),
    ("Marathi", &["मराठी", "Marathi", "mar", "mr"]),
    ("Gujarati", &["ગુજરાતી", "Gujarati", "guj", "gu"]),
    ("Punjabi", &["ਪੰਜਾਬੀ", "Punjabi", "pan", "pa"]),
    ("Persian", &["فارسی", "Persian", "fas", "per", "fa"]),
    ("Hebrew", &["עברית", "Hebrew", "heb", "he"]),
    ("Greek", &["Ελληνικά", "Greek", "ell", "gre", "el"]),
    ("Polish", &["Polski", "Polish", "pol", "pl"]),
    ("Dutch", &["Nederlands", "Dutch", "nld", "dut", "nl"]),
    ("Swedish", &["Svenska", "Swedish", "swe", "sv"]),
    ("Norwegian", &["Norsk", "Norwegian", "nor", "no"]),
    ("Danish", &["Dansk", "Danish", "dan", "da"]),
    ("Finnish", &["Suomi", "Finnish", "fin", "fi"]),
    ("Czech", &["Čeština", "Czech", "ces", "cze", "cs"]),
    ("Hungarian", &["Magyar", "Hungarian", "hun", "hu"]),
    ("Romanian", &["Română", "Romanian", "ron", "rum", "ro"]),
    ("Ukrainian", &["Українська", "Ukrainian", "ukr", "ua"]),
];

/// Normalise a raw subtitle/dub language string to a canonical English label.
///
/// Provider APIs return a chaotic mix of native scripts, ISO-639 codes and
/// English names. Collapsing them to one canonical label is what makes the
/// de-duplication in `service.rs::get_ext_captions` work.
///
/// Lookup is exact first, then ASCII-case-insensitive. The second pass exists
/// because providers really do send `ENGLISH` and `Hindi` alongside `English`,
/// and a subtitle list showing both is a visible bug. ASCII-only folding is
/// deliberate: `eq_ignore_ascii_case` is allocation-free, and a fully Unicode
/// case fold would need a dependency to fix a case (`TÜRKÇE`) that does not
/// occur in the data. Anything unrecognised passes through as-is, so a new
/// language degrades to "shows its own name" rather than "Unknown".
pub fn sanitize_language_label(name: &str) -> String {
    // Providers occasionally tag Arabic with harakat — vowel marks that carry
    // no meaning for a language label but do break the match.
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(*c as u32, 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED))
        .collect();

    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return "Unknown".to_string();
    }

    for (canonical, aliases) in LANGUAGE_ALIASES {
        if aliases.contains(&trimmed) {
            return (*canonical).to_string();
        }
    }

    for (canonical, aliases) in LANGUAGE_ALIASES {
        if aliases
            .iter()
            .any(|alias| trimmed.eq_ignore_ascii_case(alias))
        {
            return (*canonical).to_string();
        }
    }

    trimmed.to_string()
}

/// Render a subtitle option name, mapping the literal "None" to a label.
pub fn format_subtitle_label(name: &str) -> String {
    if name == "None" {
        "No subtitles".to_string()
    } else {
        sanitize_language_label(name)
    }
}

/// Format seconds as `M:SS`, or `H:MM:SS` when an hour or more.
pub fn format_duration(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// Human-readable byte count. `bytes` is a float because callers sometimes
/// have a computed total rather than an exact `u64`.
pub fn format_file_size(bytes: f64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    const TB: f64 = GB * 1024.0;

    if bytes >= TB {
        format!("{:.2} TB", bytes / TB)
    } else if bytes >= GB {
        format!("{:.2} GB", bytes / GB)
    } else if bytes >= MB {
        format!("{:.0} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes / KB)
    } else {
        format!("{bytes:.0} B")
    }
}

/// Parse a provider duration string into seconds.
///
/// Accepts `SS`, `MM:SS`, `HH:MM:SS` and suffixed forms like `1h 30m`,
/// because providers are inconsistent about which they emit.
pub fn parse_duration_seconds(d: &str) -> Option<u64> {
    let s = d.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("n/a") {
        return None;
    }

    if s.contains(':') {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() == 2 {
            let m: u64 = parts[0].trim().parse().ok()?;
            let secs: u64 = parts[1].trim().parse().ok()?;
            return Some(m * 60 + secs);
        } else if parts.len() == 3 {
            let h: u64 = parts[0].trim().parse().ok()?;
            let m: u64 = parts[1].trim().parse().ok()?;
            let secs: u64 = parts[2].trim().parse().ok()?;
            return Some(h * 3600 + m * 60 + secs);
        }
        return None;
    }

    let mut total = 0u64;
    let mut current_num = String::new();
    let mut found_any = false;

    for c in s.chars() {
        if c.is_ascii_digit() {
            current_num.push(c);
        } else if c == 'h' || c == 'H' {
            if let Ok(n) = current_num.parse::<u64>() {
                total += n * 3600;
                found_any = true;
            }
            current_num.clear();
        } else if c == 'm' || c == 'M' {
            if let Ok(n) = current_num.parse::<u64>() {
                total += n * 60;
                found_any = true;
            }
            current_num.clear();
        } else if c == 's' || c == 'S' {
            if let Ok(n) = current_num.parse::<u64>() {
                total += n;
                found_any = true;
            }
            current_num.clear();
        } else if c.is_whitespace() || c == ',' {
            continue;
        } else {
            current_num.clear();
        }
    }

    // A trailing bare number with no unit is seconds.
    if let Ok(n) = current_num.parse::<u64>() {
        total += n;
        found_any = true;
    }

    if found_any { Some(total) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_labels_are_canonicalised() {
        assert_eq!(sanitize_language_label("eng"), "English");
        assert_eq!(sanitize_language_label("हिन्दी"), "Hindi");
        assert_eq!(sanitize_language_label("hi"), "Hindi");
        assert_eq!(sanitize_language_label("   "), "Unknown");
        assert_eq!(sanitize_language_label(""), "Unknown");
        // Unknown languages pass through untouched, trimmed.
        assert_eq!(sanitize_language_label("Klingon"), "Klingon");
        assert_eq!(sanitize_language_label("  Klingon  "), "Klingon");
    }

    #[test]
    fn language_lookup_is_ascii_case_insensitive() {
        // Providers really do send shouting-case labels; a subtitle list that
        // renders both "English" and "ENGLISH" is a visible bug.
        assert_eq!(sanitize_language_label("ENGLISH"), "English");
        assert_eq!(sanitize_language_label("english"), "English");
        assert_eq!(sanitize_language_label("HINDI"), "Hindi");
        assert_eq!(sanitize_language_label("SpA"), "Spanish");
    }

    #[test]
    fn language_dedup_collapses_every_spelling_of_one_language() {
        // The reason the function exists: `get_ext_captions` groups by this
        // label, so all of these must land on one bucket.
        for spelling in ["English", "eng", "en", "ENGLISH", "English "] {
            assert_eq!(
                sanitize_language_label(spelling),
                "English",
                "`{spelling}` did not collapse onto English"
            );
        }
    }

    #[test]
    fn arabic_harakat_are_stripped_before_matching() {
        // Providers tag Arabic subtitles with vowel marks that carry no meaning
        // for a label but do break an exact match.
        assert_eq!(sanitize_language_label("العَرَبِيَّة"), "Arabic");
    }

    #[test]
    fn subtitle_label_special_cases_none() {
        assert_eq!(format_subtitle_label("None"), "No subtitles");
        assert_eq!(format_subtitle_label("spa"), "Spanish");
    }

    #[test]
    fn durations_format_and_parse_round_trip() {
        assert_eq!(format_duration(65), "1:05");
        assert_eq!(format_duration(3725), "1:02:05");

        assert_eq!(parse_duration_seconds("90"), Some(90));
        assert_eq!(parse_duration_seconds("1:30"), Some(90));
        assert_eq!(parse_duration_seconds("2:00:00"), Some(7200));
        assert_eq!(parse_duration_seconds("1h 30m"), Some(5400));
        assert_eq!(parse_duration_seconds("n/a"), None);
        assert_eq!(parse_duration_seconds(""), None);
    }

    #[test]
    fn file_sizes_scale() {
        const KB: f64 = 1024.0;
        const MB: f64 = KB * 1024.0;
        const GB: f64 = MB * 1024.0;
        const TB: f64 = GB * 1024.0;

        assert_eq!(format_file_size(512.0), "512 B");
        assert_eq!(format_file_size(2.0 * KB), "2 KB");
        // MB/GB get no decimals; KB/TB get two.
        assert_eq!(format_file_size(5.0 * MB), "5 MB");
        assert_eq!(format_file_size(2.0 * GB), "2.00 GB");
        assert_eq!(format_file_size(3.0 * TB), "3.00 TB");
        assert_eq!(format_file_size(0.0), "0 B");
    }

    #[test]
    fn file_size_units_pick_the_largest_fitting_prefix() {
        // The boundary matters: a 1 GB file must not print as "1024.00 MB".
        const GB: f64 = 1024.0 * 1024.0 * 1024.0;
        assert!(format_file_size(GB - 1.0).ends_with("MB"));
        assert!(format_file_size(GB).ends_with("GB"));

        const TB: f64 = GB * 1024.0;
        assert!(format_file_size(TB - 1.0).ends_with("GB"));
        assert!(format_file_size(TB).ends_with("TB"));
    }
}