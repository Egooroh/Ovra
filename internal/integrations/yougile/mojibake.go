package yougile

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// fixMojibake repairs a string whose UTF-8 bytes were decoded as Windows-1251 and
// re-encoded as UTF-8 — a common import artifact in YouGile boards, e.g.
// "РЎРґРµР»Р°С‚СЊ" instead of "Сделать".
//
// Detection is deliberately conservative so correctly-named columns are never
// changed. We re-encode the string to CP1251 (recovering the original byte
// sequence for genuine mojibake) and only accept the result when ALL hold:
//   - every rune was representable in CP1251 (no emoji / exotic chars);
//   - the recovered bytes are valid UTF-8 — a correctly-typed Cyrillic title
//     ("Тестирование") yields INVALID UTF-8 here, so it is left untouched;
//   - the recovered text contains real Cyrillic letters;
//   - the input carries the tell-tale mojibake markers ('Р'/'С'/'Ð'/'Ñ'),
//     which Russian-via-CP1251 mojibake always produces.
func fixMojibake(s string) string {
	if s == "" || !strings.ContainsAny(s, "РСÐÑ") {
		return s
	}
	raw, err := charmap.Windows1251.NewEncoder().String(s)
	if err != nil || raw == s {
		return s
	}
	if !utf8.ValidString(raw) || !hasCyrillic(raw) {
		return s
	}
	return raw
}

// hasCyrillic reports whether s contains a Russian Cyrillic letter (А..я, Ё/ё).
func hasCyrillic(s string) bool {
	for _, r := range s {
		if (r >= 0x0410 && r <= 0x044F) || r == 'Ё' || r == 'ё' {
			return true
		}
	}
	return false
}
