# Private Paperclip web access

`tailnet-web` is an app-specific Tailscale node that proxies one HTTPS listener to the existing authenticated Paperclip UI at `http://127.0.0.1:8100`. It uses `tailscale.com/tsnet` pinned to **1.104.5**, built with **Go 1.27.3**. It requires neither administrator privileges nor a system Tailscale daemon, VPN configuration, kernel extension, host TCP443 listener, or global tailnet policy change. Tailscale's encrypted UDP transport still uses OS network sockets.

The current implementation is a local build/test slice. A successful build, fixture test, or `ready` event does **not** prove remote connectivity, Paperclip login, phone use, login recovery, or operation after a reboot. Record those separately.

## Why an app-specific node

The general `tailscaled --tun=userspace-networking` implementation can forward incoming node ports to the same ports on localhost. That could make unrelated loopback services reachable under a permissive tailnet policy. This proxy instead uses `tsnet.Server.ListenTLS("tcp", ":443")`. The pinned SDK intercepts unregistered TCP/UDP flows and rejects them rather than forwarding them to localhost. The app registers no fallback handlers, Funnel listener, custom TUN, web client, or loopback SOCKS/LocalAPI listener. It never calls the Serve CLI or exposes a database, filesystem, or MCP HTTP endpoint.

See the [pinned tsnet flow handler](https://github.com/tailscale/tailscale/blob/v1.104.5/tsnet/tsnet.go#L1221), the [SDK API documentation](https://tailscale.com/docs/reference/tsnet-server-api), and the [general daemon's localhost forwarding](https://github.com/tailscale/tailscale/blob/v1.104.5/wgengine/netstack/netstack.go#L1698). Existing tailnet access controls still apply to HTTPS; a policy that denies 443 may need a narrow allow rule. App listener isolation avoids removing or broadening unrelated tailnet policy.

## Build and review

From this repository, with at least 2 GiB free and a working Go installation:

```sh
./scripts/build-tailnet-web /private/tmp/paperclip-tailnet-web
```

The script uses `GOTOOLCHAIN=go1.27.3+auto`, `GOMODCACHE=$HOME/.cache/paperclip-factory-go/mod`, and `GOCACHE=$HOME/.cache/paperclip-factory-go/build`. It downloads the pinned toolchain/dependencies, resolves a missing initial module lock, verifies modules, runs Go race tests, and compiles the binary. It never runs the compiled app. Once `go.sum` exists, tidy must report no dependency changes. Keep the generated lock in version control.

If local dependency downloads are blocked by the environment's network policy, the read-only-permission `Factory checks` GitHub Actions workflow runs Node 24.15.0 factory tests, Go 1.27.3 fixture/race tests, and a CGO-disabled `darwin/arm64` cross-build. The first run may bootstrap `go.mod`/`go.sum` and includes them in its artifact for review and a subsequent commit. Later runs require the committed module lock to remain unchanged. The binary is not executed by CI. The artifact includes the exact checked-out source SHA, toolchain version, and SHA256 checksums. Accept it only from a successful run for the reviewed repository/head; binary build success is separate from the Node job's result. No workflow publishes a release, modifies a PR, installs a service, authenticates Tailscale, merges, or deploys.

## Foreground authentication

After code/build review, run the binary directly in a foreground terminal for the first login:

```sh
/private/tmp/paperclip-tailnet-web --login
```

The default hostname is `paperclip-factory-web`. The default private state directory is `~/.paperclip/instances/factory/tsnet/paperclip-web`. Optional flags are `--state-dir ABS_DIRECTORY`, `--hostname DNS_LABEL`, and `--startup-timeout 5m` (1 second–10 minutes). There are no configurable backend, port, auth-key, public-access, or tunnel options.

A fresh run emits one bounded JSON event containing the interactive SSO URL, marked `"transient":true`. Open that URL privately and complete Tailscale sign-in. Device approval may also be required by your tailnet. Do not redirect or copy the foreground login output into persistent service logs, issue comments, screenshots, or shared transcripts. Normal mode, without `--login`, suppresses login links and exits with `RUN_FOREGROUND_LOGIN` if authentication is needed. The process strips ambient `TS_`/`TSNET_` authentication and behavior overrides. The SDK's backend logs are discarded; its logtail buffering/upload path is disabled before startup so the interactive URL is not mirrored into the SDK's spool.

TLS requires MagicDNS and HTTPS certificates enabled for the tailnet. Missing HTTPS configuration stops startup with `HTTPS_CONFIGURATION_REQUIRED`; enabling it can require another human admin action. Certificate issuance records the node's DNS name in public certificate-transparency logs, while application access remains private. Choose a nonsensitive node name. See [HTTPS requirements](https://tailscale.com/docs/how-to/set-up-https-certificates).

The `ready` event supplies the exact `https://<node>.<tailnet>.ts.net` URL. The private `status.json` contains only bounded phase/code/timestamp and this public node URL. It contains no SSO link, peer list, token, session, or TLS private key. Native SDK state and certificate files remain private and must never be published. A status file is an observation, not independent liveness or authentication proof.

## Paperclip hostname and acceptance

Keep Paperclip authenticated/private, bound to loopback on 8100, and retain `auth.baseUrlMode=auto` for the first slice. Once the exact new hostname is known, add only that hostname with the supported CLI, then restart Paperclip:

```sh
./scripts/paperclip allowed-hostname EXACT_NODE_HOSTNAME
./scripts/paperclip service restart --instance factory --wait
```

These commands are later operator actions; the proxy never changes Paperclip configuration or restarts it. Do not add wildcard hosts, enable public exposure, change the loopback bind, disable authentication, or replace existing private settings. The proxy accepts only the exact node Host (with optional 443), removes client-supplied forwarding headers, and supplies the known HTTPS host/protocol to its fixed backend. It preserves application cookies, Origin, paths, queries, and WebSocket upgrades. Paperclip remains responsible for login, sessions, CSRF checks, and Board authorization.

For acceptance, use a phone with its normal Tailscale client connected to the same tailnet, preferably over cellular rather than the Mac's LAN. Verify the exact HTTPS URL, login, read existing task/run state, create an unassigned disposable draft, and logout/login. Check that raw node port 8100 and actual database ports are unreachable; disconnect Tailscale on the phone and verify the URL is inaccessible. Also verify Mac loopback operation and that stopping the proxy closes remote access. A rootless tsnet process does not add host routes or system DNS, so the Mac's ordinary browser may need its own separate Tailscale client to open the node URL; that limitation does not establish phone failure.

## Shutdown and persistence

SIGTERM/SIGINT cancel startup or stop accepting work, allow HTTP shutdown for at most 10 seconds, close upgraded connections, and close the embedded node. No Paperclip, Cloud job, journal, or task status is modified. Persistent SDK state avoids repeating login until the node credentials expire or are revoked. An exclusive state lock rejects concurrent processes using the same directory. New state directories are 0700; app metadata/lock files are 0600. Existing nonempty unowned directories, redirected SDK files, and symlink status destinations are refused.

Start the proxy manually without `--login` to reuse approved state. A managed login service, bounded service logs, actual restart/login recovery, phone acceptance, and remote MCP client access need their own implementation or verification; this slice does not claim them complete.
