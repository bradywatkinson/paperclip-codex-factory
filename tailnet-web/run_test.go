package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeNode struct {
	up     func(context.Context) (nodeStatus, error)
	listen func(context.Context) (net.Listener, error)
	closed atomic.Int32
}

func (n *fakeNode) Up(ctx context.Context) (nodeStatus, error) { return n.up(ctx) }
func (n *fakeNode) ListenTLS(ctx context.Context) (net.Listener, error) {
	if n.listen == nil {
		return nil, errors.New("Unexpected listener")
	}
	return n.listen(ctx)
}
func (n *fakeNode) Close() error { n.closed.Add(1); return nil }
func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{StateDirectory: filepath.Join(t.TempDir(), "private"), Hostname: "paperclip-factory-web", StartupTimeout: time.Second}
}
func observedStatus(t *testing.T, directory, phase string) Status {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var status Status
		if raw, err := os.ReadFile(filepath.Join(directory, "status.json")); err == nil && json.Unmarshal(raw, &status) == nil && status.Phase == phase {
			return status
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatalf("Status %s was not observed", phase)
	return Status{}
}
func TestNormalRunDoesNotPrintOrPersistAuthenticationURL(t *testing.T) {
	c := testConfig(t)
	var output bytes.Buffer
	n := &fakeNode{}
	n.up = func(ctx context.Context) (nodeStatus, error) { <-ctx.Done(); return nodeStatus{}, ctx.Err() }
	err := run(context.Background(), c, func(_ Config, auth func(string)) node { auth("https://login.tailscale.com/a/PRIVATEAUTH"); return n }, &output)
	if err == nil {
		t.Fatal("Missing login must stop normal service")
	}
	if strings.Contains(output.String(), "PRIVATEAUTH") {
		t.Fatal("Normal output leaked authlink")
	}
	if n.closed.Load() != 1 {
		t.Fatal("Node not closed")
	}
	status := observedStatus(t, c.StateDirectory, "authentication_required")
	if status.URL != "" {
		t.Fatal("Status leaked login link")
	}
	scanNoSecrets(t, c.StateDirectory, "PRIVATEAUTH")
}
func TestForegroundLoginEmitsOnlyTransientLinkAndStoresSafeReadyURL(t *testing.T) {
	c := testConfig(t)
	c.AllowLogin = true
	var output bytes.Buffer
	gate := make(chan struct{})
	n := &fakeNode{}
	n.up = func(ctx context.Context) (nodeStatus, error) {
		select {
		case <-gate:
			return nodeStatus{[]string{"paperclip-factory-web.example.ts.net"}}, nil
		case <-ctx.Done():
			return nodeStatus{}, ctx.Err()
		}
	}
	n.listen = func(context.Context) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, c, func(_ Config, auth func(string)) node { auth("https://login.tailscale.com/a/PRIVATEAUTH"); return n }, &output)
	}()
	observedStatus(t, c.StateDirectory, "authentication_required")
	scanNoSecrets(t, c.StateDirectory, "PRIVATEAUTH")
	close(gate)
	status := observedStatus(t, c.StateDirectory, "ready")
	if status.URL != "https://paperclip-factory-web.example.ts.net" {
		t.Fatal("Wrong node URL")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	events := []Event{}
	for decoder.More() {
		var event Event
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if len(events) != 3 || events[0].Event != "authentication_required" || !events[0].Transient || events[0].URL != "https://login.tailscale.com/a/PRIVATEAUTH" || events[1].Event != "ready" || events[2].Event != "stopped" {
		t.Fatalf("Unexpected bounded events: %+v", events)
	}
	scanNoSecrets(t, c.StateDirectory, "PRIVATEAUTH")
	if n.closed.Load() != 1 {
		t.Fatal("Node not closed")
	}
}
func TestStartupDeadlineAndErrorsNeverEmitRawSDKDiagnostics(t *testing.T) {
	for _, failure := range []string{"timeout", "provider"} {
		t.Run(failure, func(t *testing.T) {
			c := testConfig(t)
			var output bytes.Buffer
			n := &fakeNode{up: func(ctx context.Context) (nodeStatus, error) {
				if failure == "provider" {
					return nodeStatus{}, errors.New("Bearer PRIVATE_CREDENTIAL https://login.tailscale.com/a/PRIVATEAUTH")
				}
				<-ctx.Done()
				return nodeStatus{}, ctx.Err()
			}}
			started := time.Now()
			err := run(context.Background(), c, func(Config, func(string)) node { return n }, &output)
			if err == nil || time.Since(started) > 2*time.Second {
				t.Fatal("Startup not bounded")
			}
			if strings.Contains(output.String(), "PRIVATE") {
				t.Fatal("Raw diagnostics leaked")
			}
			scanNoSecrets(t, c.StateDirectory, "PRIVATE")
			if n.closed.Load() != 1 {
				t.Fatal("Node not closed")
			}
		})
	}
}
func TestInvalidCertificatesDoNotOpenListener(t *testing.T) {
	for _, domains := range [][]string{nil, {"evil.example"}, {"node.example.ts.net:443"}, {"node.example.ts.net", "second.example.ts.net"}, {"node/evil.ts.net"}} {
		c := testConfig(t)
		n := &fakeNode{up: func(context.Context) (nodeStatus, error) { return nodeStatus{domains}, nil }}
		var output bytes.Buffer
		if run(context.Background(), c, func(Config, func(string)) node { return n }, &output) == nil {
			t.Fatalf("Accepted unsafe certificate domains: %v", domains)
		}
		if !strings.Contains(output.String(), "HTTPS_CONFIGURATION_REQUIRED") {
			t.Fatal("Missing actionable code")
		}
	}
}
func TestCanceledStartupClosesNode(t *testing.T) {
	c := testConfig(t)
	ctx, cancel := context.WithCancel(context.Background())
	n := &fakeNode{up: func(ctx context.Context) (nodeStatus, error) { cancel(); <-ctx.Done(); return nodeStatus{}, ctx.Err() }}
	var output bytes.Buffer
	_ = run(ctx, c, func(Config, func(string)) node { return n }, &output)
	if n.closed.Load() != 1 {
		t.Fatal("Node not closed")
	}
	if strings.Contains(output.String(), "url") {
		t.Fatal("Unexpected URL")
	}
}
func TestOnlyExactSSOURLAccepted(t *testing.T) {
	for _, value := range []string{"http://login.tailscale.com/a/SECRET", "https://login.tailscale.com.evil/a/SECRET", "https://login.tailscale.com:443/a/SECRET", "https://login.tailscale.com/a/SECRET?token=secret", "https://evil@login.tailscale.com/a/SECRET", "https://login.tailscale.com/a/SECRET/extra", strings.Repeat("x", 5000)} {
		if authenticationURL(value) != "" {
			t.Fatalf("Accepted unsafe auth URL shape")
		}
	}
	if authenticationURL("go to https://login.tailscale.com/a/abc123") != "https://login.tailscale.com/a/abc123" {
		t.Fatal("Valid native link not captured")
	}
}
func scanNoSecrets(t *testing.T, directory, secret string) {
	t.Helper()
	count := 0
	err := filepath.WalkDir(directory, func(filename string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		if count > 1000 {
			t.Fatal("Unbounded fixture")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			t.Fatal("Unexpected symlink")
		}
		if !entry.IsDir() {
			raw, err := os.ReadFile(filename)
			if err != nil {
				return err
			}
			if bytes.Contains(raw, []byte(secret)) {
				t.Fatalf("Secret persisted in %s", entry.Name())
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
