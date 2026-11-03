package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testHostname = "paperclip-factory-web.example.ts.net"

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestFixedBackendPreservesAppRequestAndReplacesUntrustedForwardingHeaders(t *testing.T) {
	called := false
	handler := proxyHandler(testHostname, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called = true
		if r.URL.Scheme != "http" || r.URL.Host != backendAddress || r.Host != testHostname || r.URL.RequestURI() != "/api/issues?limit=2" {
			t.Fatal("Proxy target or app route changed")
		}
		if r.Header.Get("X-Forwarded-Host") != testHostname || r.Header.Get("X-Forwarded-Proto") != "https" || r.Header.Get("X-Forwarded-For") != "100.64.0.7" || r.Header.Get("Forwarded") != "" || r.Header.Get("X-Forwarded-Password") != "" {
			t.Fatalf("Untrusted forwarding headers retained: %v", r.Header)
		}
		if r.Header.Get("Cookie") != "session=fixture" || r.Header.Get("Origin") != "https://"+testHostname {
			t.Fatal("App auth headers changed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Set-Cookie": []string{"session=next; HttpOnly; Secure"}}, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	}))
	r := httptest.NewRequest("GET", "/api/issues?limit=2", nil)
	r.Host = testHostname
	r.RemoteAddr = "100.64.0.7:5000"
	r.Header.Set("Cookie", "session=fixture")
	r.Header.Set("Origin", "https://"+testHostname)
	for _, name := range []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-For", "X-Forwarded-Password"} {
		r.Header.Set(name, "attacker")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if !called || w.Code != 200 || w.Header().Get("Set-Cookie") == "" {
		t.Fatal("App response lost")
	}
}
func TestHostAndTunnelGuardsRunBeforeBackend(t *testing.T) {
	handler := proxyHandler(testHostname, roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("Guarded request reached backend")
		return nil, nil
	}))
	for _, fixture := range []struct {
		host, method, target string
		code                 int
	}{{"evil.example", "GET", "/", 400}, {testHostname + ":8100", "GET", "/", 400}, {testHostname, "CONNECT", "/", 405}, {testHostname, "GET", "http://evil.example/", 400}} {
		r := httptest.NewRequest(fixture.method, fixture.target, nil)
		r.Host = fixture.host
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != fixture.code {
			t.Fatalf("Guard result %d expected %d", w.Code, fixture.code)
		}
	}
}
func TestBackendTransportNeverUsesEnvironmentProxyOrOtherAddress(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	transport := backendTransport()
	if transport.Proxy != nil {
		t.Fatal("Environment proxy accepted")
	}
	if _, err := transport.DialContext(context.Background(), "tcp", "127.0.0.1:5432"); err == nil {
		t.Fatal("Unexpected backend accepted")
	}
}
func TestWebSocketUpgradeAndBidirectionalBytesWithOnlyLoopbackFixtures(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" {
			t.Error("Upgrade missing")
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = rw.Flush()
		_, _ = io.Copy(conn, conn)
	}))
	defer backend.Close()
	backendURL, _ := url.Parse(backend.URL)
	transport := backendTransport()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != backendAddress {
			t.Error("Wrong fixed backend address")
		}
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", backendURL.Host)
	}
	defer transport.CloseIdleConnections()
	proxy := httptest.NewServer(proxyHandler(testHostname, transport))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	conn, err := net.DialTimeout("tcp", proxyURL.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(conn, "GET /api/live HTTP/1.1\r\nHost: "+testHostname+"\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 101 {
		t.Fatalf("Upgrade returned %d", response.StatusCode)
	}
	_, _ = conn.Write([]byte("fixture-ping"))
	echo := make([]byte, len("fixture-ping"))
	if _, err = io.ReadFull(reader, echo); err != nil {
		t.Fatal(err)
	}
	if string(echo) != "fixture-ping" {
		t.Fatal("Upgrade bytes changed")
	}
}

func TestShutdownClosesUpgradedConnections(t *testing.T) {
	server, shutdown := appHTTPServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = rw.Flush()
		_, _ = io.Copy(conn, conn)
	}))
	defer shutdown()
	if server.ReadHeaderTimeout != 10*time.Second || server.IdleTimeout != 60*time.Second || server.MaxHeaderBytes != 32768 {
		t.Fatal("HTTP limits changed")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	conn, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil || response.StatusCode != 101 {
		t.Fatal("Upgrade fixture failed")
	}
	done := make(chan struct{})
	go func() { shutdown(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not close upgrade promptly")
	}
	one := make([]byte, 1)
	if _, err := conn.Read(one); err == nil {
		t.Fatal("Upgraded connection survived shutdown")
	}
}

type pausedNativeHijack struct {
	http.ResponseWriter
	hijacked chan struct{}
	release  <-chan struct{}
}

func (w *pausedNativeHijack) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	close(w.hijacked)
	<-w.release
	return conn, rw, nil
}
func TestLateHijackRegistrationCannotSurviveCompletedShutdown(t *testing.T) {
	tracker := new(upgradeTracker)
	hijacked := make(chan struct{})
	release := make(chan struct{})
	handlerDone := make(chan error, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		guarded := &upgradeWriter{&pausedNativeHijack{w, hijacked, release}, tracker}
		conn, rw, err := guarded.Hijack()
		if err != nil {
			handlerDone <- err
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = rw.Flush()
		_, _ = io.Copy(conn, conn)
		handlerDone <- nil
	})}
	shutdown := shutdownHTTPServer(server, tracker)
	defer shutdown()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(client, "GET / HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	select {
	case <-hijacked:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("Native hijack not observed")
	}
	stopped := make(chan struct{})
	go func() { shutdown(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("Shutdown blocked while native hijack was paused")
	}
	close(release)
	_, err = http.ReadResponse(bufio.NewReader(client), nil)
	if err == nil {
		t.Fatal("Late hijack returned101 after shutdown")
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("Late hijack connection remained open")
	}
	select {
	case err := <-handlerDone:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatal("Late registration did not fail closed")
		}
	case <-time.After(time.Second):
		t.Fatal("Late hijack handler did not exit")
	}
	tracker.mu.Lock()
	remaining := len(tracker.connections)
	tracker.mu.Unlock()
	if remaining != 0 {
		t.Fatal("Late connection remained tracked")
	}
}
