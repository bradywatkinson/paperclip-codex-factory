package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Config struct {
	StateDirectory, Hostname string
	StartupTimeout           time.Duration
	AllowLogin               bool
}
type Event struct {
	Event     string `json:"event"`
	URL       string `json:"url,omitempty"`
	Code      string `json:"code,omitempty"`
	Transient bool   `json:"transient,omitempty"`
}
type nodeStatus struct{ CertDomains []string }
type node interface {
	Up(context.Context) (nodeStatus, error)
	ListenTLS(context.Context) (net.Listener, error)
	Close() error
}
type nodeFactory func(Config, func(string)) node

var errConfiguration = errors.New("Invalid configuration")
var labelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var authPathPattern = regexp.MustCompile(`^/a/[A-Za-z0-9]+$`)

func validateConfig(c Config) error {
	if !filepath.IsAbs(c.StateDirectory) || filepath.Clean(c.StateDirectory) != c.StateDirectory || strings.ContainsAny(c.StateDirectory, "\x00\r\n") || !labelPattern.MatchString(c.Hostname) || c.StartupTimeout < time.Second || c.StartupTimeout > 10*time.Minute {
		return errConfiguration
	}
	return nil
}
func authenticationURL(message string) string {
	if len(message) > 4096 {
		return ""
	}
	for _, field := range strings.Fields(message) {
		if len(field) > 512 {
			continue
		}
		parsed, err := url.Parse(field)
		if err == nil && parsed.Scheme == "https" && parsed.Host == "login.tailscale.com" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == "" && authPathPattern.MatchString(parsed.Path) {
			return parsed.String()
		}
	}
	return ""
}
func certificateHostname(domains []string) (string, error) {
	if len(domains) != 1 {
		return "", errConfiguration
	}
	host := strings.TrimSuffix(domains[0], ".")
	if len(host) > 253 || !strings.HasSuffix(host, ".ts.net") {
		return "", errConfiguration
	}
	for _, label := range strings.Split(host, ".") {
		if !labelPattern.MatchString(label) {
			return "", errConfiguration
		}
	}
	u, err := url.Parse("https://" + host)
	if err != nil || u.Hostname() != host || u.Port() != "" {
		return "", errConfiguration
	}
	return host, nil
}
func run(ctx context.Context, c Config, factory nodeFactory, output io.Writer) error {
	if err := validateConfig(c); err != nil {
		return err
	}
	lock, err := privateDirectory(c.StateDirectory)
	if err != nil {
		_ = emit(output, Event{Event: "needs_attention", Code: "STATE_UNAVAILABLE"})
		return err
	}
	defer lock.Close()
	publish := func(phase, webURL, code string) error {
		return writeStatus(c.StateDirectory, Status{Phase: phase, URL: webURL, Code: code})
	}
	fail := func(code string, err error) error {
		_ = publish("needs_attention", "", code)
		_ = emit(output, Event{Event: "needs_attention", Code: code})
		return err
	}
	if err = publish("starting", "", ""); err != nil {
		return fail("STATUS_UNAVAILABLE", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, c.StartupTimeout)
	defer cancel()
	authLinks := make(chan string, 1)
	n := factory(c, func(link string) {
		if safe := authenticationURL(link); safe != "" {
			select {
			case authLinks <- safe:
			default:
			}
		}
	})
	defer func() { cancel(); _ = n.Close() }()
	type startup struct {
		status nodeStatus
		err    error
	}
	started := make(chan startup, 1)
	go func() { st, err := n.Up(startCtx); started <- startup{st, err} }()
	seen := map[string]bool{}
	var status nodeStatus
wait:
	for {
		select {
		case link := <-authLinks:
			if err = publish("authentication_required", "", ""); err != nil {
				return fail("STATUS_UNAVAILABLE", err)
			}
			if !c.AllowLogin {
				_ = emit(output, Event{Event: "authentication_required", Code: "RUN_FOREGROUND_LOGIN"})
				return errors.New("Authentication required")
			}
			if !seen[link] && len(seen) < 4 {
				seen[link] = true
				if err = emit(output, Event{Event: "authentication_required", URL: link, Transient: true}); err != nil {
					return fail("OUTPUT_UNAVAILABLE", err)
				}
			}
		case result := <-started:
			if result.err != nil {
				if ctx.Err() != nil {
					_ = publish("stopped", "", "")
					return emit(output, Event{Event: "stopped"})
				}
				return fail("STARTUP_FAILED", result.err)
			}
			status = result.status
			break wait
		case <-startCtx.Done():
			if ctx.Err() != nil {
				_ = publish("stopped", "", "")
				_ = emit(output, Event{Event: "stopped"})
				return nil
			}
			return fail("STARTUP_TIMEOUT", startCtx.Err())
		}
	}
	hostname, err := certificateHostname(status.CertDomains)
	if err != nil {
		return fail("HTTPS_CONFIGURATION_REQUIRED", err)
	}
	ln, err := n.ListenTLS(startCtx)
	if err != nil {
		return fail("HTTPS_LISTENER_FAILED", err)
	}
	defer ln.Close()
	cancel()
	webURL := "https://" + hostname
	server, shutdown := appHTTPServer(proxyHandler(hostname, nil))
	defer shutdown()
	if err = publish("ready", webURL, ""); err != nil {
		return fail("STATUS_UNAVAILABLE", err)
	}
	if err = emit(output, Event{Event: "ready", URL: webURL}); err != nil {
		return fail("OUTPUT_UNAVAILABLE", err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(ln) }()
	select {
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return fail("PROXY_STOPPED", err)
		}
	case <-ctx.Done():
	}
	shutdown()
	if err = publish("stopped", webURL, ""); err != nil {
		return fail("STATUS_UNAVAILABLE", err)
	}
	return emit(output, Event{Event: "stopped"})
}
