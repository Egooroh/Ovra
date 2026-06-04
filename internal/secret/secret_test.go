package secret

import "testing"

func TestSealOpenRoundTrip(t *testing.T) {
	c, err := New("test-passphrase")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	const token = "yg-api-token-123456"

	ct, err := c.Seal(token)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if string(ct) == token {
		t.Fatal("ciphertext equals plaintext")
	}

	got, err := c.Open(ct)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got != token {
		t.Fatalf("round trip = %q, want %q", got, token)
	}
}

func TestEmptyValuesRoundTrip(t *testing.T) {
	c, _ := New("k")
	ct, err := c.Seal("")
	if err != nil || ct != nil {
		t.Fatalf("Seal(\"\") = %v, %v; want nil, nil", ct, err)
	}
	got, err := c.Open(nil)
	if err != nil || got != "" {
		t.Fatalf("Open(nil) = %q, %v; want \"\", nil", got, err)
	}
}

func TestWrongKeyFails(t *testing.T) {
	a, _ := New("key-a")
	b, _ := New("key-b")
	ct, _ := a.Seal("secret")
	if _, err := b.Open(ct); err == nil {
		t.Fatal("Open with wrong key should fail")
	}
}

func TestEmptyPassphraseRejected(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Fatal("New(\"\") should return ErrNoKey")
	}
}
