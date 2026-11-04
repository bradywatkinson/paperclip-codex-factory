package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateIsPrivateAndExclusive(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	lock, err := privateDirectory(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if _, err := privateDirectory(directory); err == nil {
		t.Fatal("Second process could use same SDK state")
	}
	if err := writeStatus(directory, Status{Phase: "ready", URL: "https://node.example.ts.net"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".proxy.lock", "status.json"} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("Private file permissions incorrect")
		}
	}
	info, _ := os.Stat(directory)
	if info.Mode().Perm() != 0700 {
		t.Fatal("State directory not private")
	}
}
func TestStateAndStatusSymlinksArePreservedAndRefused(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "operator")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "redirect")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := privateDirectory(link); err == nil {
		t.Fatal("State symlink accepted")
	}
	directory := filepath.Join(root, "state")
	lock, err := privateDirectory(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	sentinel := filepath.Join(root, "sentinel")
	_ = os.WriteFile(sentinel, []byte("preserve"), 0600)
	_ = os.Symlink(sentinel, filepath.Join(directory, "status.json"))
	if writeStatus(directory, Status{Phase: "ready"}) == nil {
		t.Fatal("Status symlink accepted")
	}
	raw, _ := os.ReadFile(sentinel)
	if string(raw) != "preserve" {
		t.Fatal("Operator file changed")
	}
}

func TestUnownedDirectoryAndRedirectedSDKStateAreRefused(t *testing.T) {
	directory := t.TempDir()
	operator := filepath.Join(directory, "operator-document")
	_ = os.WriteFile(operator, []byte("preserve"), 0644)
	if _, err := privateDirectory(directory); err == nil {
		t.Fatal("Unowned existing directory accepted")
	}
	raw, _ := os.ReadFile(operator)
	if string(raw) != "preserve" {
		t.Fatal("Operator contents changed")
	}
	owned := filepath.Join(t.TempDir(), "state")
	lock, err := privateDirectory(owned)
	if err != nil {
		t.Fatal(err)
	}
	lock.Close()
	_ = os.Symlink(operator, filepath.Join(owned, "tailscaled.state"))
	if _, err := privateDirectory(owned); err == nil {
		t.Fatal("Native SDK symlink accepted")
	}
}
