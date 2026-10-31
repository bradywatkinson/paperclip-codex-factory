# Operating the local control plane

Run repository commands from this checkout. `./scripts/paperclip` defaults to the `factory` instance and `~/.paperclip` home. It preserves existing `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` overrides, so confirm their scope before running commands and use overrides only intentionally.

## Installation

Install Node.js `24.14.0` for macOS arm64 from [the official release](https://nodejs.org/dist/v24.14.0/). Alternatively, with an existing working npm installation, install an isolated runtime without changing global npm configuration:

```sh
npm --cache "$HOME/.cache/npm" install --prefix "$HOME/.local/share/paperclip-runtime" node@24.14.0
export PATH="$HOME/.local/share/paperclip-runtime/node_modules/node/bin:$HOME/.local/bin:$PATH"
export PAPERCLIP_NODE="$HOME/.local/share/paperclip-runtime/node_modules/node/bin/node"
export npm_config_cache="$HOME/.cache/npm"
```

Keep its executable in a stable location. Recommend at least 10 GiB free disk for installer, build, and cache headroom; this is an estimate, not a verified minimum. Check available space with `df -h "$HOME"`. Confirm `node --version` and `uname -m` (`arm64`) before running:

```sh
./scripts/bootstrap
```

Bootstrap installs exactly `paperclipai@2026.1023.0` through the managed installer and stops without onboarding or starting a server. Next create the instance interactively:

```sh
./scripts/paperclip onboard
```

Select Quickstart, decline installation of the background service, and decline **Start Paperclip now**. This generates local configuration without starting an unauthenticated server. In this exact release, `onboard --yes` starts the foreground server; there is no supported `--no-run` switch. Do not use noninteractive onboarding here.

Before running any server, patch the generated config:

```sh
"${PAPERCLIP_NODE:-node}" scripts/configure-local.mjs "$HOME/.paperclip/instances/factory/config.json"
./scripts/paperclip doctor
```

Use the corresponding config path if you intentionally selected another home or instance. The config helper sets authenticated, private, loopback-only access. The onboarding defaults select `local_trusted`, which is insufficient for this factory's authentication requirement. Leave service installation until the first UI feedback step below.

Bootstrap invokes npm's `npx-cli.js` with the selected Node executable. This avoids shell version-manager wrappers silently selecting an older runtime; for example, mise's npm wrapper can select Node 22 despite the supplied `PATH`. A failed version-manager network bootstrap is not proof the selected runtime or Paperclip installation works. Check the installed runtime directly.

The intended server configuration is:

| Setting | Value |
| --- | --- |
| Deployment mode | `authenticated` |
| Exposure | `private` |
| Host / port | `127.0.0.1:8100` |
| Public browser origin | `http://127.0.0.1:8100` |
| Database | Embedded PostgreSQL, persistent instance directory |
| Secret provider | Local encrypted store |

If configuration needs interactive repair, stop the service, then run `./scripts/paperclip configure --section server`. Select Custom reachability, port `8100`, Authenticated, Private network, and bind host `127.0.0.1`. Keep the browser origin consistent. Run `doctor` before restarting.

Start the first run in the foreground with `./scripts/paperclip run`. First authenticated startup prints a board ownership claim URL. Open it locally, create or sign into your human account, and claim ownership. Store the account password in your password manager. Verify a private browser window cannot access board data without signing in. The claim URL and code are secrets.

After that UI check, stop the foreground server with Control-C, then install the login service:

```sh
./scripts/paperclip service install --instance factory
./scripts/paperclip service status --instance factory --json
```

## Start, stop, and inspect

```sh
./scripts/paperclip service status --instance factory --json
./scripts/paperclip service stop --instance factory
./scripts/paperclip service start --instance factory
./scripts/paperclip service restart --instance factory --wait
./scripts/paperclip service logs --instance factory
./scripts/paperclip doctor
```

The supported macOS service is a per-user LaunchAgent, normally `~/Library/LaunchAgents/ing.paperclip.paperclipai.factory.plist`. Service installation defaults to start now and start on login. It starts when this user logs in; it is not a boot-before-login system daemon. Inspect `service status` after signing out and back in. Logs can include ownership links or operational details: review and redact before sharing.

For foreground troubleshooting, stop the LaunchAgent first and run `./scripts/paperclip run`; exit with Control-C. Never run both processes against the same instance. Port conflicts must be resolved explicitly rather than accepting a different port as success.

## Persistent files and environment

| Path | Purpose |
| --- | --- |
| `~/.paperclip/cli/` | Managed payloads, current-version pointer, install metadata |
| `~/.local/bin/paperclipai` | Stable managed shim, including pinned Node path |
| `~/.paperclip/instances/factory/config.json` | Server, database, storage, and backup configuration |
| `~/.paperclip/instances/factory/.env` | Instance environment and generated authentication secret |
| `~/.paperclip/instances/factory/db/` | Embedded PostgreSQL data |
| `~/.paperclip/instances/factory/data/storage/` | Local uploads |
| `~/.paperclip/instances/factory/data/backups/` | Automatic logical database dumps |
| `~/.paperclip/instances/factory/secrets/master.key` | Key needed to decrypt local secrets |
| `~/.paperclip/instances/factory/logs/` | Runtime logs |
| `~/.paperclip/instances/factory/workspaces/` | Default agent workspaces |

`PAPERCLIP_HOME` chooses the base home and `PAPERCLIP_INSTANCE_ID` chooses the instance; the wrapper preserves explicitly set values. `PAPERCLIP_NODE` is this repository's Node selector. The wrapper defaults `PORT=8100`, including during onboarding; clear any conflicting `PORT` override to use the default. Do not accidentally point these at an application checkout. Environment overrides such as `PAPERCLIP_DEPLOYMENT_MODE` can supersede config; remove conflicting overrides during verification.

The generated instance `.env` contains `PAPERCLIP_AGENT_JWT_SECRET`, used by Paperclip's authentication setup. Preserve it across restarts and restores. If explicitly setting `BETTER_AUTH_SECRET`, generate and store it locally, never in tracked files. Do not paste credentials into shell command arguments, commit them, or include them in evidence. Use Paperclip's supported secret UI/provider references for future agent credentials. No provider credential is required merely to operate the local board.

Keep `~/.paperclip` private to this user and store backups in encrypted storage with owner-only permissions. A database dump alone cannot restore encrypted secrets: it also needs the matching master key. Changing or deleting the key is not a supported way to rotate stored credentials.

## Backup

Paperclip supports automatic database backups (hourly by default, with 30-day retention); check the actual instance settings. Automatic dumps stay on the same disk and exclude uploads, configuration, and key material. Also keep a full stopped-instance backup on separate encrypted storage.

First pause agents and wait for active work to finish. Create a logical backup while the instance is running:

```sh
./scripts/paperclip db:backup --json
./scripts/paperclip service stop --instance factory
./scripts/paperclip service status --instance factory --json
```

Confirm the server and embedded database have stopped before copying. With a fresh destination on your encrypted backup volume:

```sh
umask 077
BACKUP_DIR="/Volumes/EncryptedBackup/paperclip-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
ditto "$HOME/.paperclip" "$BACKUP_DIR/paperclip-home"
cp "$HOME/.local/bin/paperclipai" "$BACKUP_DIR/paperclipai-shim"
./scripts/paperclip service start --instance factory
```

Record the Paperclip/Node versions and Node executable path with the backup. Copy any external agent workspaces separately. Treat this directory as credentials-bearing material. Verify the copy contains the database, `.env`, master key, and storage before considering the backup complete. Perform the restore rehearsal below; copying files alone is not proof of recoverability.

## Restore

Use a stopped instance and the same Paperclip and PostgreSQL-compatible runtime as the backup. Do not overwrite a running database. Full-home restore is the foundation recovery path; SQL-only recovery requires upstream PostgreSQL tooling and is not automated here.

1. Stop the service and confirm the server and embedded database have exited. Preserve the current home under a new name for recovery; do not delete it.
2. Restore the complete `paperclip-home` copy to `~/.paperclip`, including hidden files, config, `.env`, database, storage, and secret key. On the same Mac, use `ditto` from the backup to the empty destination.
3. On a replacement Mac, install the pinned Node and Paperclip release and recreate the service registration. A copied managed shim or LaunchAgent can contain the old user's absolute paths: regenerate these rather than assuming they are portable. Preserve restored instance data and secrets.
4. Run `./scripts/paperclip doctor`, then start the service. Check loopback binding and authenticated access before reconnecting any agents.
5. Verify the smoke-test company, goal, task assignment, approval result, and an uploaded fixture. Verify a known stored test secret remains usable without printing its value. Record the result and elapsed time.

For an isolated rehearsal, restore to a separate home, configure a different HTTP and embedded PostgreSQL port, and run it in the foreground. Keep copied agents paused and never run two processes against the same home. Do not claim the restore test passed until data and secret decryption have been checked.

## Upgrade and rollback

Upgrade deliberately; the repository pin is not `latest`. Pause agents, finish active runs, make and verify a stopped full backup, then update to a reviewed exact release:

```sh
./scripts/paperclip update --version <reviewed-version>
./scripts/paperclip service restart --instance factory --wait
./scripts/paperclip doctor
```

Run the smoke test and record the installed version before updating the repository pin. Keep the old Node executable until the service has been reinstalled with the new supported runtime and verified. To change the shim's Node path, run the pinned `npx paperclipai@<version> install --version <version> --yes` with the new Node directory first on `PATH`; the old shim intentionally keeps using its old executable.

Managed installs retain two previous payloads and support `./scripts/paperclip update --rollback`. A code rollback does not undo database migrations. If the old release cannot read upgraded data, stop the service and restore the pre-upgrade full backup with the matching release. Never treat rollback as a substitute for a backup.

## Upstream contracts

This setup uses supported managed installation, instance configuration, service, and database-backup interfaces. No Paperclip core changes or experimental agent orchestration commands are required. Consult the [installation](https://docs.paperclip.ing/reference/cli/installation/), [service](https://docs.paperclip.ing/reference/cli/service/), [authentication](https://docs.paperclip.ing/how-to/enable-multi-user-login/), and [backup](https://docs.paperclip.ing/how-to/back-up-and-restore-a-company/) documentation when changing the pin.

## Disk budget override

Bootstrap defaults to a conservative 10 GiB free-space budget. This is not an upstream minimum. For a deliberate retry on a smaller disk, `PAPERCLIP_MIN_FREE_GIB=4 ./scripts/bootstrap` lowers only that preflight threshold. It does not limit extraction size or guarantee the installation fits. Watch available space and stop if it approaches exhaustion; never delete unrelated files to satisfy the check.
