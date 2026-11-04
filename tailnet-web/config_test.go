package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCLIHasFixedServiceBoundaries(t *testing.T) {
	home := t.TempDir()
	resolve := func() (string, error) { return home, nil }
	c, err := parseConfig(nil, resolve)
	if err != nil || c.StateDirectory != filepath.Join(home, ".paperclip/instances/factory/tsnet/paperclip-web") || c.Hostname != "paperclip-factory-web" || c.StartupTimeout != 5*time.Minute || c.AllowLogin {
		t.Fatal("Defaults changed")
	}
	for _, args := range [][]string{{"--backend", "http://evil"}, {"--listen", ":8100"}, {"--auth-key", "secret"}, {"--funnel"}, {"--state-dir", "relative"}, {"--startup-timeout", "20m"}, {"--hostname", "evil/host"}, {"extra"}} {
		if _, err := parseConfig(args, resolve); err == nil {
			t.Fatal("Accepted unsupported boundary configuration")
		}
	}
	c, err = parseConfig([]string{"--login"}, resolve)
	if err != nil || !c.AllowLogin {
		t.Fatal("Explicit foreground login unavailable")
	}
}
func TestAmbientTailscaleAuthenticationAndBehaviorOverridesAreRemoved(t *testing.T) {
	for _, name := range []string{"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_ID", "TS_CLIENT_SECRET", "TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL", "TSNET_FORCE_LOGIN", "TS_LOG_TARGET", "TS_DEBUG_NETSTACK_SUBNETS"} {
		t.Setenv(name, "PRIVATE_FIXTURE")
	}
	t.Setenv("FACTORY_TEST_UNRELATED", "preserve")
	clearAmbientTailscaleEnvironment()
	for _, name := range []string{"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_ID", "TS_CLIENT_SECRET", "TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL", "TSNET_FORCE_LOGIN", "TS_LOG_TARGET", "TS_DEBUG_NETSTACK_SUBNETS"} {
		if _, ok := os.LookupEnv(name); ok {
			t.Fatal("Ambient Tailscale override survived")
		}
	}
	if os.Getenv("FACTORY_TEST_UNRELATED") != "preserve" {
		t.Fatal("Unrelated environment changed")
	}
}
