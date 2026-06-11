package yougile

import (
	"testing"

	"golang.org/x/text/encoding/charmap"
)

// mojibakeOf reproduces the corruption: interpret a correct UTF-8 string's bytes
// as Windows-1251, yielding the garbled form YouGile sometimes returns.
func mojibakeOf(t *testing.T, correct string) string {
	t.Helper()
	out, err := charmap.Windows1251.NewDecoder().String(correct)
	if err != nil {
		t.Fatalf("mojibakeOf(%q): %v", correct, err)
	}
	return out
}

func TestFixMojibakeRepairsGarbledTitles(t *testing.T) {
	for _, want := range []string{"Сделать", "В работе", "Ревью", "Готово", "Тестирование", "Срочно"} {
		garbled := mojibakeOf(t, want)
		if garbled == want {
			t.Fatalf("%q did not change under mojibake — bad fixture", want)
		}
		if got := fixMojibake(garbled); got != want {
			t.Errorf("fixMojibake(%q) = %q, want %q", garbled, got, want)
		}
	}
}

func TestFixMojibakeLeavesCorrectTitlesUnchanged(t *testing.T) {
	// Correctly-encoded titles (Cyrillic, Latin, emoji, mixed) must pass through.
	for _, s := range []string{
		"Сделать", "В работе", "Ревью", "Готово", "Тестирование", "Срочно",
		"Backlog", "To Do", "In Progress", "Done",
		"🔥 Срочно", "QA / Тест", "", "Ёлка",
	} {
		if got := fixMojibake(s); got != s {
			t.Errorf("fixMojibake(%q) = %q, want unchanged", s, got)
		}
	}
}
