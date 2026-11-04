# Managed factory controller on macOS

The user LaunchAgent `ing.paperclip.codex-factory.controller` keeps the account controller loop running after login. It is separate from the Paperclip service, which continues to own authenticated loopback access on `127.0.0.1:8100`. This service opens no network listener and changes no Paperclip authentication, firewall, host, or tunnel settings.

Its program is the pinned Node 24.15.0 executable plus the repository's service runner. The runner starts `scripts/factory-controller.mjs --loop` with the existing private registry and scheduler. It reconciles known Cloud work and wakes eligible queued dispatchers; Cloud submission still goes through the dispatcher's durable admission gate. The working directory is the private factory instance, preventing an application repository's `.env` from becoming controller configuration. A fixed environment supplies the private home/instance, disabled telemetry, locale, and an absolute minimal PATH. No tokens or credential values are stored in the plist or copied from the invoking shell.

## Install and operate

Bootstrap the repository registration and run `factory controller --once` successfully before service installation. The registry and scheduler databases must already exist. The installer checks regular readable files, supported database schemas, executable paths, and the exact Node version; it never replaces a missing database with a new one.

Use the supported Node runtime from the factory repository:

```sh
FACTORY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
"$FACTORY_NODE" scripts/controller-service.mjs dry-run --json
"$FACTORY_NODE" scripts/controller-service.mjs install --json
"$FACTORY_NODE" scripts/controller-service.mjs start --json
"$FACTORY_NODE" scripts/controller-service.mjs status --json
"$FACTORY_NODE" scripts/controller-service.mjs stop --json
```

Defaults use `~/.paperclip/instances/factory`, its `repositories` registry, and `onboarding/scheduler`. To review different paths, write a private JSON file containing only the desired fields and pass its absolute path with `install --config`. Supported fields are `nodeCommand`, `controllerEntrypoint`, `runnerEntrypoint`, `registryDirectory`, `schedulerDirectory`, `instanceDirectory`, `logDirectory`, `intervalMs`, `graceMs`, and the bounded log limits. All paths must be absolute and are normalized; entrypoint basenames and the current user's home binding are checked. Installation verifies real paths too, so traversal and ancestor symlinks cannot place the private working directory inside the application repository. `--instance-dir` selects an existing nondefault private factory instance for subsequent commands.

A dry-run prints the complete XML plist, immutable configuration paths, and changed fields. It creates no configuration, LaunchAgent or SQLite sidecar files and sends no `launchctl` operation. It checks database file presence/readability, leaving schema inspection to actual installation. Loaded-job ownership is checked during actual installation because the dry-run sends no native operation. A successful plan is not proof that macOS will allow registration or that the controller can reach its providers.

Installation writes the plist under `~/Library/LaunchAgents/`. Immutable private configurations and ownership receipts live under the instance's `managed-controller/` directory. A receipt binds the exact generated plist and configuration hashes. Repeating the same installation is idempotent. An existing unowned or manually altered plist is refused, including when `--replace` is present. Actual installation also inspects any loaded job with this label before publishing files. Its complete native program and argument vector must match a validated current or prior immutable configuration and ownership receipt. Unknown, malformed, or foreign loaded jobs are reported for attention and are never unloaded, restarted, or adopted. A config path appearing elsewhere in native output does not prove ownership.

For an intentional change to an owned installation, inspect the new plan, then use:

```sh
"$FACTORY_NODE" scripts/controller-service.mjs install --config /absolute/private/controller-service.json --dry-run --json
"$FACTORY_NODE" scripts/controller-service.mjs install --config /absolute/private/controller-service.json --replace --json
"$FACTORY_NODE" scripts/controller-service.mjs start --json
```

Replacement publishes the new configuration and ownership receipt before the plist changes. A running old configuration continues until `start` unloads that owned job and bootstraps the newly installed configuration. It does not overwrite an unrecognized service or silently change an existing configuration.

`stop` unloads the job with `launchctl bootout`, allowing SIGTERM shutdown. `start` uses the current user's `gui/<uid>` domain and enables/bootstrap-loads an absent job; it leaves an already running matching configuration alone. RunAtLoad, KeepAlive and a 30-second throttle provide login startup and bounded restart frequency. This is a user login service, not proof of operation before login, while the Mac sleeps, or during network loss.

`status` reports the actual `launchctl print` result, including loaded state, active PID, last exit code, and whether the loaded arguments match the installed immutable configuration. A plist's presence never establishes active health. Permission or host-access errors remain unknown/attention. Restricted sessions may be unable to register the service; resolve that in the normal macOS user session without changing authentication or exposing a port.

## Logs and shutdown

The runner combines stdout and stderr in `logs/factory-controller/controller.log`, retaining at most **five files of 5 MiB each**, including the current file. Rotated files use `.1` through `.4`. Individual pending lines are limited to 32 KiB; oversized lines are replaced with `LOG_LINE_DROPPED`. Smaller limits can be configured, but the maximum bounds cannot be increased. Old owned log generations outside a newly reduced bound are discarded.

Common bearer, Paperclip/OpenAI key, credential-field, and URL-token patterns are redacted across chunk boundaries. The controller already emits sanitized codes and summaries rather than provider diagnostics. This defensive redaction is not an arbitrary-secret detector. Log files are private, and launchd stdout/stderr go to `/dev/null` so there is no second unbounded log stream.

`managed-controller/runtime.json` is bounded metadata containing the runner/child PID, configuration hash, latest recognized controller status, and exit information. It is an observation file, not independent liveness proof; compare it with the current launchctl PID and timestamps. Operator diagnostics should inspect the private bounded log and the normal controller status rather than publish raw private files.

SIGTERM and SIGINT are forwarded to the child controller. Its existing cancellation path stops new work and interrupts local reads. The runner waits for graceful exit, with a configurable maximum 20-second grace before killing an unresponsive local child. Accepted Cloud tasks are not cancelled or forgotten. An exceptional metadata/log failure also shuts down the child instead of leaving an orphan controller.

## Uninstall and verification

```sh
"$FACTORY_NODE" scripts/controller-service.mjs uninstall --json
```

Uninstall first verifies unload, then removes only the owned LaunchAgent plist. It preserves configuration receipts, bounded logs, the registry, scheduler, execution journals and Cloud receipts. Repeating uninstall is safe when the job and plist are absent.

```sh
node --test tests/controller-service.test.mjs
```

Tests use temporary state and a stub launchctl provider, plus an actual runner/child fixture for private cwd, environment filtering, bounded logs and graceful SIGTERM. They verify plist escaping, ownership, idempotence, explicit replacement, current native-status interpretation, permission failures, database/runtime rejection and uninstall preservation. They never install a real LaunchAgent, call live Paperclip/Cloud services, or prove a physical Mac reboot. Live install/start/status and login recovery must be recorded separately.
