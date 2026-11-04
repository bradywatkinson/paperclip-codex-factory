package main

import (
	"context"
	"fmt"
	"net"
	"sync"
	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

type sdkNode struct {
	server  *tsnet.Server
	mu      sync.Mutex
	started bool
	closed  bool
}

func newSDKNode(c Config, auth func(string)) node {
	// SDK UserLogf is also mirrored to its logtail spool unless disabled before Start.
	logtail.Disable()
	return &sdkNode{server: &tsnet.Server{Dir: c.StateDirectory, Hostname: c.Hostname, Ephemeral: false, RunWebClient: false, Logf: func(string, ...any) {}, UserLogf: func(format string, args ...any) {
		if link := authenticationURL(fmt.Sprintf(format, args...)); link != "" {
			auth(link)
		}
	}}}
}
func (n *sdkNode) Up(ctx context.Context) (nodeStatus, error) {
	n.mu.Lock()
	if n.closed || ctx.Err() != nil {
		n.mu.Unlock()
		return nodeStatus{}, context.Canceled
	}
	err := n.server.Start()
	n.started = true
	n.mu.Unlock()
	if err != nil {
		return nodeStatus{}, err
	}
	st, err := n.server.Up(ctx)
	if err != nil {
		return nodeStatus{}, err
	}
	return nodeStatus{CertDomains: st.CertDomains}, nil
}
func (n *sdkNode) ListenTLS(ctx context.Context) (net.Listener, error) {
	type result struct {
		listener net.Listener
		err      error
	}
	done := make(chan result)
	go func() {
		ln, err := n.server.ListenTLS("tcp", ":443")
		select {
		case done <- result{ln, err}:
		case <-ctx.Done():
			if ln != nil {
				_ = ln.Close()
			}
		}
	}()
	select {
	case r := <-done:
		return r.listener, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (n *sdkNode) Close() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	if !n.started {
		return nil
	}
	n.started = false
	return n.server.Close()
}
