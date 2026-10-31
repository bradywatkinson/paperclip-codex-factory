# Paperclip Codex Factory

A reusable, local Paperclip coordination service for an Apple Silicon Mac. The control plane lives outside application repositories; this repository holds its version pins, setup scripts, and operating procedures.

Initial scope: persistent storage, authenticated local UI, backups, and a macOS login service. Application integration, production deployments, and automatic merges are outside this foundation.

## Versions and prerequisites

- Paperclip: `2026.1023.0`, installed through the supported managed installer or an optional global npm installation.
- Node.js: `24.15.0` reference runtime; bootstrap requires at least `24.15.0` for current transitive dependencies.
- Apple Silicon macOS, Git, npm/npx, and a signed-in desktop user for the LaunchAgent.
- Bootstrap requires 10 GiB free disk for install/build/cache headroom; this is a conservative budget, not a measured upstream minimum.

Keep the Node executable at a stable path: the managed shim and this repository's global launcher record its absolute path, and launchd does not load shell version managers. Put the chosen Node `bin` directory first on `PATH`; `PAPERCLIP_NODE` may select its absolute executable for repository scripts.

## Start here

```sh
git clone https://github.com/bradywatkinson/paperclip-codex-factory.git
cd paperclip-codex-factory
node --version
export PAPERCLIP_TELEMETRY_DISABLED=1
./scripts/bootstrap
./scripts/paperclip onboard --no-install-service
# Choose Quickstart; decline “Start Paperclip now”.
"${PAPERCLIP_NODE:-node}" scripts/configure-local.mjs "$HOME/.paperclip/instances/factory/config.json"
./scripts/paperclip doctor
./scripts/paperclip run
# After claiming the board and completing the initial UI checks, stop with Control-C:
./scripts/paperclip service install --instance factory
./scripts/paperclip service status --instance factory --json
```

Follow the foreground startup output to claim the authenticated board in your browser at `http://127.0.0.1:8100`. Claim links contain credentials; keep them out of commits and issue evidence. Install the login service after that first UI check. See [operations](docs/operations.md) for installation details and [the fresh-Mac smoke test](docs/smoke-test.md) for acceptance checks.

Bootstrap only installs the CLI. For a single-payload alternative to managed installation, run `PAPERCLIP_INSTALL_METHOD=global ./scripts/bootstrap`; see [installation methods](docs/operations.md#global-npm-alternative). Do not start Paperclip until onboarding has finished and `configure-local.mjs` has applied authentication. In this release, `onboard --yes` starts the foreground server and offers no `--no-run` switch, so use the interactive choices above.

The wrapper defaults to `PORT=8100`, `PAPERCLIP_HOME=$HOME/.paperclip` and `PAPERCLIP_INSTANCE_ID=factory`; existing environment overrides select a different scope only when intentional. Managed code lives in `~/.paperclip/cli`, the stable CLI entrypoint is `~/.local/bin/paperclipai`, and instance state lives in `~/.paperclip/instances/factory`. With global installation, code lives in `~/.local/share/paperclip-global` and its launcher in `~/.local/share/paperclip-factory/bin/paperclipai`. The wrapper prefers that launcher when present and supplies its path to the native service. No application checkout is the service's working storage.

## Verification status

The pinned global package is installed and reports `2026.1023.0`; `doctor` passed all 12 checks. Live startup remains blocked in this session: embedded PostgreSQL initialization gets a shared-memory permission error, and native LaunchAgent registration returns macOS error 5. The service file is installed and enabled but inactive. UI, backup/restore, and login recovery remain unverified. See [dated evidence](docs/evidence/2026-10-31-bootstrap.md) and [the smoke-test checklist](docs/smoke-test.md#evidence).

Issue: [#1 — Bootstrap Paperclip local control plane](https://github.com/bradywatkinson/paperclip-codex-factory/issues/1).

## Local checks

```sh
bash -n scripts/bootstrap scripts/paperclip
node --check scripts/configure-local.mjs
node --test tests/*.test.mjs
```

The tests need loopback port `8100` available and use disposable configuration files and an inert CLI fixture.

## Upstream references

- [Managed installation](https://docs.paperclip.ing/reference/cli/installation/)
- [Service lifecycle](https://docs.paperclip.ing/reference/cli/service/)
- [Enable multi-user login](https://docs.paperclip.ing/how-to/enable-multi-user-login/)
- [Database](https://docs.paperclip.ing/deploy/database/)
- [Backup and restore](https://docs.paperclip.ing/how-to/back-up-and-restore-a-company/)

Upstream documentation may describe newer versions. This repository's scripts and recorded evidence apply to the pinned release.
