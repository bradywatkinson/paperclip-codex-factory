package main

import (
	"context"
	"io"
	"net/http"
	"tailscale.com/logtail"
	"tailscale.com/types/logid"
	"testing"
	"time"
)

// No test calls Start, Up, or ListenTLS on the actual SDK server.
func TestSDKConstructionHasOnlyAppScopedDefaultsAndNoStart(t *testing.T) {
	c := testConfig(t)
	n := newSDKNode(c, func(string) {}).(*sdkNode)
	if n.started || n.server.Dir != c.StateDirectory || n.server.Hostname != c.Hostname || n.server.Tun != nil || n.server.RunWebClient || n.server.Ephemeral || n.server.AuthKey != "" || n.server.ControlURL != "" {
		t.Fatal("Unexpected native SDK configuration")
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := n.Up(context.Background()); err == nil {
		t.Fatal("Closed native adapter started")
	}
}
func TestDisabledSDKLogtailDropsAuthenticationBytesBeforeBuffering(t *testing.T) {
	_ = newSDKNode(testConfig(t), func(string) {})
	id, err := logid.NewPrivateID()
	if err != nil {
		t.Fatal(err)
	}
	buffer := logtail.NewMemoryBuffer(4)
	logger := logtail.NewLogger(logtail.Config{Collection: logtail.CollectionNode, PrivateID: id, Buffer: buffer, Stderr: io.Discard, HTTPC: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("Disabled SDK logging attempted HTTP")
		return nil, context.Canceled
	})}}, func(string, ...any) {})
	logger.Logf("To authenticate visit https://login.tailscale.com/a/PRIVATEAUTH")
	if line, err := buffer.TryReadLine(); err != nil || len(line) != 0 {
		t.Fatal("Authentication bytes reached SDK spool buffer")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = logger.Shutdown(ctx)
}
