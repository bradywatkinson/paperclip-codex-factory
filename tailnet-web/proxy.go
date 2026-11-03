package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

const backendAddress = "127.0.0.1:8100"

func backendTransport() *http.Transport {
	return &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != backendAddress {
			return nil, errors.New("Unexpected backend")
		}
		return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, address)
	}, ForceAttemptHTTP2: false, MaxIdleConns: 10, MaxIdleConnsPerHost: 10, IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 30 * time.Second, TLSHandshakeTimeout: 10 * time.Second}
}
func proxyHandler(hostname string, transport http.RoundTripper) http.Handler {
	target := &url.URL{Scheme: "http", Host: backendAddress}
	if transport == nil {
		transport = backendTransport()
	}
	proxy := &httputil.ReverseProxy{Transport: transport, ErrorLog: log.New(io.Discard, "", 0), ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "Backend unavailable", http.StatusBadGateway)
	}, Rewrite: func(p *httputil.ProxyRequest) {
		p.SetURL(target)
		p.Out.Host = hostname
		p.SetXForwarded()
		p.Out.Header.Set("X-Forwarded-Host", hostname)
		p.Out.Header.Set("X-Forwarded-Proto", "https")
	}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Host != hostname && r.Host != hostname+":443") || r.URL.IsAbs() || r.URL.User != nil {
			http.Error(w, "Invalid host", http.StatusBadRequest)
			return
		}
		if r.Method == http.MethodConnect {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		r = r.Clone(r.Context())
		r.Header = r.Header.Clone()
		for key := range r.Header {
			lower := strings.ToLower(key)
			if lower == "forwarded" || strings.HasPrefix(lower, "x-forwarded-") {
				r.Header.Del(key)
			}
		}
		proxy.ServeHTTP(w, r)
	})
}

// HTTP Shutdown does not close upgraded connections; track their Close calls explicitly.
type upgradeConnection struct {
	net.Conn
	once   sync.Once
	remove func()
}

func (c *upgradeConnection) Close() error { err := c.Conn.Close(); c.once.Do(c.remove); return err }

type upgradeTracker struct {
	mu          sync.Mutex
	closing     bool
	connections map[*upgradeConnection]struct{}
}

func (t *upgradeTracker) register(conn net.Conn) (*upgradeConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closing {
		return nil, net.ErrClosed
	}
	if t.connections == nil {
		t.connections = make(map[*upgradeConnection]struct{})
	}
	tracked := &upgradeConnection{Conn: conn}
	tracked.remove = func() { t.mu.Lock(); delete(t.connections, tracked); t.mu.Unlock() }
	t.connections[tracked] = struct{}{}
	return tracked, nil
}
func (t *upgradeTracker) beginShutdown() { t.mu.Lock(); t.closing = true; t.mu.Unlock() }
func (t *upgradeTracker) closeConnections() {
	t.mu.Lock()
	connections := make([]*upgradeConnection, 0, len(t.connections))
	for conn := range t.connections {
		connections = append(connections, conn)
	}
	t.mu.Unlock()
	for _, conn := range connections {
		_ = conn.Close()
	}
}

type upgradeWriter struct {
	http.ResponseWriter
	tracker *upgradeTracker
}

func (w *upgradeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *upgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	tracked, err := w.tracker.register(conn)
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	return tracked, rw, nil
}
func appHTTPServer(handler http.Handler) (*http.Server, func()) {
	tracker := new(upgradeTracker)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(&upgradeWriter{w, tracker}, r) }), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768, ErrorLog: log.New(io.Discard, "", 0)}
	return server, shutdownHTTPServer(server, tracker)
}
func shutdownHTTPServer(server *http.Server, tracker *upgradeTracker) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			// Fence registration before draining native HTTP state. Hijack can already
			// have removed a connection from that state while its caller is descheduled.
			tracker.beginShutdown()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = server.Shutdown(ctx)
			tracker.closeConnections()
			_ = server.Close()
		})
	}
}
