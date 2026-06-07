package columns

import (
	"testing"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
)

func cols(pairs ...string) []yougile.Column {
	var out []yougile.Column
	for i := 0; i < len(pairs); i += 2 {
		out = append(out, yougile.Column{ID: pairs[i], Title: pairs[i+1]})
	}
	return out
}

func TestResolveRussianStandard(t *testing.T) {
	r := Resolve(cols("c1", "Сделать", "c2", "В работе", "c3", "Ревью", "c4", "Готово"))
	if !r.Confident {
		t.Fatal("expected confident dictionary match")
	}
	if r.Mapping != (Mapping{Todo: "c1", InProgress: "c2", Review: "c3", Done: "c4"}) {
		t.Fatalf("mapping = %+v", r.Mapping)
	}
}

func TestResolveEnglishStandard(t *testing.T) {
	r := Resolve(cols("a", "To Do", "b", "In Progress", "c", "Review", "d", "Done"))
	if !r.Confident || !r.Mapping.Complete() {
		t.Fatalf("not resolved: %+v", r)
	}
	if r.Mapping.Todo != "a" || r.Mapping.Done != "d" {
		t.Fatalf("mapping = %+v", r.Mapping)
	}
}

func TestResolveCreativeNames(t *testing.T) {
	// Backlog/Doing/QA/Closed — all in the dictionary.
	r := Resolve(cols("1", "Backlog", "2", "Doing", "3", "QA", "4", "Closed"))
	if !r.Confident {
		t.Fatalf("expected dictionary match, got %+v", r.Assignments)
	}
	if r.Mapping.InProgress != "2" || r.Mapping.Review != "3" {
		t.Fatalf("mapping = %+v", r.Mapping)
	}
}

func TestResolveOrdinalFallback(t *testing.T) {
	// "Спринт" and "На согласовании"->review(dict); todo/done by dict, middle by ordinal.
	r := Resolve(cols("x", "Входящие", "y", "Спринт", "z", "Готово"))
	if r.Confident {
		t.Fatal("should not be confident with an unknown column")
	}
	// Входящие → todo (dict), Готово → done (dict), Спринт → ordinal in_progress.
	if r.Mapping.Todo != "x" || r.Mapping.Done != "z" {
		t.Fatalf("dict mapping wrong: %+v", r.Mapping)
	}
	if r.Mapping.InProgress != "y" {
		t.Fatalf("ordinal should put Спринт in in_progress: %+v", r.Mapping)
	}
	if r.Assignments[1].Method != "ordinal" {
		t.Fatalf("expected ordinal method, got %q", r.Assignments[1].Method)
	}
}

func TestResolveThreeColumnsNoReview(t *testing.T) {
	r := Resolve(cols("1", "Сделать", "2", "В работе", "3", "Готово"))
	if r.Mapping.Review != "" {
		t.Fatalf("review should be empty, got %q", r.Mapping.Review)
	}
	if r.Mapping.Complete() {
		t.Fatal("mapping should be incomplete (no review column)")
	}
	if r.Mapping.Todo != "1" || r.Mapping.InProgress != "2" || r.Mapping.Done != "3" {
		t.Fatalf("mapping = %+v", r.Mapping)
	}
}

func TestResolveAllUnknownOrdinal(t *testing.T) {
	// Nothing in the dictionary → pure ordinal: first→todo, last→done, middle fill.
	r := Resolve(cols("1", "Идеи", "2", "Зона", "3", "Песочница", "4", "Архив"))
	if r.Confident {
		t.Fatal("not confident with all-unknown names")
	}
	if r.Mapping.Todo != "1" || r.Mapping.Done != "4" {
		t.Fatalf("ordinal ends wrong: %+v", r.Mapping)
	}
	if r.Mapping.InProgress != "2" || r.Mapping.Review != "3" {
		t.Fatalf("ordinal middle wrong: %+v", r.Mapping)
	}
}

func TestNormalizeStripsEmojiAndCase(t *testing.T) {
	if got := normalize("  🔥 В РАБОТЕ!! "); got != "в работе" {
		t.Fatalf("normalize = %q", got)
	}
	if _, ok := matchStatus(normalize("✅ Готово")); !ok {
		t.Fatal("emoji-prefixed Готово should match done")
	}
	_ = domain.StatusDone
}
