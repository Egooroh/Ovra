package columns

import (
	"context"
	"errors"
	"testing"
)

type fakeClassifier struct {
	out         []string
	err         error
	gotTitles   []string
	called      bool
}

func (f *fakeClassifier) Classify(_ context.Context, titles []string) ([]string, error) {
	f.called = true
	f.gotTitles = titles
	return f.out, f.err
}

func TestResolveWithAIPlacesUnknownColumn(t *testing.T) {
	// "Котёл" is unknown to the dictionary; В работе/Готово are dictionary hits.
	c := cols("c1", "Котёл", "c2", "В работе", "c3", "Готово")
	ai := &fakeClassifier{out: []string{"todo"}} // classifies the one unused column

	res, err := ResolveWithAI(context.Background(), c, ai)
	if err != nil {
		t.Fatalf("ResolveWithAI: %v", err)
	}
	if !ai.called || len(ai.gotTitles) != 1 || ai.gotTitles[0] != "Котёл" {
		t.Fatalf("classifier got %v", ai.gotTitles)
	}
	if res.Mapping.Todo != "c1" {
		t.Fatalf("AI should map Котёл→todo, mapping=%+v", res.Mapping)
	}
	if res.Assignments[0].Method != "ai" {
		t.Fatalf("expected method ai, got %q", res.Assignments[0].Method)
	}
}

func TestResolveWithAINotCalledWhenConfident(t *testing.T) {
	c := cols("1", "Сделать", "2", "В работе", "3", "Ревью", "4", "Готово")
	ai := &fakeClassifier{out: []string{"todo"}}

	res, err := ResolveWithAI(context.Background(), c, ai)
	if err != nil || !res.Confident {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if ai.called {
		t.Fatal("classifier must not be called when dictionary is confident")
	}
}

func TestResolveWithAIErrorStillCompletesViaOrdinal(t *testing.T) {
	c := cols("1", "Зона", "2", "Песочница", "3", "Архив")
	ai := &fakeClassifier{err: errors.New("provider down")}

	res, err := ResolveWithAI(context.Background(), c, ai)
	if err == nil {
		t.Fatal("expected classifier error to be surfaced")
	}
	// Ordinal still fills it: first→todo, last→done.
	if res.Mapping.Todo != "1" || res.Mapping.Done != "3" {
		t.Fatalf("ordinal fallback failed: %+v", res.Mapping)
	}
}

func TestResolveWithNilClassifierEqualsResolve(t *testing.T) {
	c := cols("1", "Сделать", "2", "Зона", "3", "Готово")
	a, _ := ResolveWithAI(context.Background(), c, nil)
	b := Resolve(c)
	if a.Mapping != b.Mapping {
		t.Fatalf("nil classifier diverged: %+v vs %+v", a.Mapping, b.Mapping)
	}
}
