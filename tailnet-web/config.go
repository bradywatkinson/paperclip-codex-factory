package main

import (
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"time"
)

func parseConfig(args []string, home func() (string, error)) (Config, error) {
	dir, err := home()
	if err != nil {
		return Config{}, err
	}
	c := Config{StateDirectory: filepath.Join(dir, ".paperclip/instances/factory/tsnet/paperclip-web"), Hostname: "paperclip-factory-web", StartupTimeout: 5 * time.Minute}
	f := flag.NewFlagSet("tailnet-web", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	f.StringVar(&c.StateDirectory, "state-dir", c.StateDirectory, "Private absolute tsnet state directory")
	f.StringVar(&c.Hostname, "hostname", c.Hostname, "App-specific node hostname")
	f.DurationVar(&c.StartupTimeout, "startup-timeout", c.StartupTimeout, "Bounded authentication/startup wait")
	f.BoolVar(&c.AllowLogin, "login", false, "Permit transient SSO URL events in this foreground session")
	if err = f.Parse(args); err != nil {
		return Config{}, err
	}
	if f.NArg() != 0 {
		return Config{}, errConfiguration
	}
	return c, validateConfig(c)
}
func clearAmbientTailscaleEnvironment() {
	for _, item := range os.Environ() {
		for i := 0; i < len(item); i++ {
			if item[i] == '=' {
				name := item[:i]
				if len(name) >= 3 && (name[:3] == "TS_" || len(name) >= 6 && name[:6] == "TSNET_") {
					_ = os.Unsetenv(name)
				}
				break
			}
		}
	}
}
func emit(w io.Writer, event Event) error { return json.NewEncoder(w).Encode(event) }
