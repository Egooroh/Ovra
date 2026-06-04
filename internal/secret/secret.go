// Package secret encrypts small sensitive values (YouGile API keys) at rest
// using AES-256-GCM. The encryption key is derived from APP_SECRET so no key
// material is stored in the database alongside the ciphertext.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
)

// ErrNoKey is returned by New when the passphrase is empty.
var ErrNoKey = errors.New("secret: empty APP_SECRET")

// Cipher seals and opens values with a fixed key.
type Cipher struct {
	aead cipher.AEAD
}

// New derives a 256-bit key from passphrase (SHA-256) and builds an AES-GCM
// cipher. An empty passphrase is rejected so secrets are never "encrypted"
// under a predictable zero key.
func New(passphrase string) (*Cipher, error) {
	if passphrase == "" {
		return nil, ErrNoKey
	}
	key := sha256.Sum256([]byte(passphrase))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}
	return &Cipher{aead: aead}, nil
}

// Seal encrypts plaintext, returning nonce-prefixed ciphertext. Empty input
// yields empty output (so "no token" round-trips cleanly).
func (c *Cipher) Seal(plaintext string) ([]byte, error) {
	if plaintext == "" {
		return nil, nil
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	return c.aead.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

// Open reverses Seal. Empty input yields an empty string.
func (c *Cipher) Open(ciphertext []byte) (string, error) {
	if len(ciphertext) == 0 {
		return "", nil
	}
	ns := c.aead.NonceSize()
	if len(ciphertext) < ns {
		return "", errors.New("secret: ciphertext too short")
	}
	nonce, body := ciphertext[:ns], ciphertext[ns:]
	plain, err := c.aead.Open(nil, nonce, body, nil)
	if err != nil {
		return "", fmt.Errorf("open: %w", err)
	}
	return string(plain), nil
}
