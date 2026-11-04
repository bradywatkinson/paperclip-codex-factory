// tailnet-web exposes one authenticated Paperclip UI through an app-specific tsnet node.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	syscall.Umask(0077)
	clearAmbientTailscaleEnvironment()
	c, err := parseConfig(os.Args[1:], os.UserHomeDir)
	if err != nil {
		emit(os.Stdout, Event{Event: "needs_attention", Code: "INVALID_CONFIGURATION"})
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if run(ctx, c, newSDKNode, os.Stdout) != nil {
		os.Exit(1)
	}
}
