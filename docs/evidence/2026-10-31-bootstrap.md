# Foundation verification — 2026-10-31

Issue: https://github.com/bradywatkinson/paperclip-codex-factory/issues/1

## Environment and pin

- Apple Silicon (`arm64`), macOS 27.0.1 (26A434).
- Existing default Node: 22.23.1; left unchanged.
- Isolated Node 24.14.0 installed at `~/.local/share/paperclip-runtime/node_modules/node/bin/node`; version command passed.
- Registry metadata reports `paperclipai@2026.1023.0`, Node requirement `>=24.11.0`.
- Published tarball integrity: `sha512-PA2gLYoJKcmen1YaNr7jtyyZK2xNyW92XEedgZ82S1MMeMEB2kdmk1okRMD4aFUV4OZPFBwk76pV0jCM2Fuy0g==`.
- This is a candidate pin, not a successfully installed or smoke-tested release.

## Observed installation blocker

`npm exec --package=paperclipai@2026.1023.0` dependency extraction failed with:

```text
npm warn tar TAR_ENTRY_ERROR ENOSPC: no space left on device, write
```

The disk had only 117 MiB available at the low point. Removed the partial npx install and task-only temporary Node/research directories. About 3 GiB was available afterward. No unrelated user files were removed. The isolated permanent Node runtime remains available. No factory server or LaunchAgent was started, and no application repositories were changed.

The version-manager install also failed with a network proxy tunnel error; installing the isolated runtime through npm succeeded. This does not validate Paperclip.

## Release-specific finding

Inspection of the downloaded `2026.1023.0` CLI bundle showed that `onboard --yes` starts the server immediately, even with `--no-install-service`; there is no `--no-run` option. Bootstrap therefore installs only. The documented interactive onboarding must decline service installation and immediate startup before applying authenticated loopback configuration.

## Local verification

User-selected default is authenticated loopback at `http://127.0.0.1:8100`. The wrapper supplies `PORT=8100` during onboarding, and the generated config is checked before first startup.

Shell syntax, JavaScript parsing, configuration behavior, and failure handling are covered by repository checks. See the test command in README. These checks do not prove a working Paperclip installation.

## Remaining acceptance

All live acceptance checks remain pending: managed installation/doctor, authenticated UI and anonymous denial, goals/projects/tasks, agent assignments, approvals/rejections, persistence, backup and restore, service registration and restart after login.

Next: provide at least 10 GiB free (a conservative bootstrap budget, not a measured upstream requirement), rerun the documented installation, then complete [the smoke test](../smoke-test.md). Retain this failed attempt as evidence; add a later verified result instead of rewriting it as success. No evidence has been posted to GitHub.

## Retry after additional space became available

A subsequent user-requested retry started with 5.1 GiB free. Added an explicit `PAPERCLIP_MIN_FREE_GIB` override while retaining the conservative 10 GiB default, then attempted the exact same release with a 4 GiB preflight threshold. Dependency extraction reached approximately 2 GiB before the execution tool terminated the process with:

```text
Network access to "nodejs.org" was blocked: domain is not on the allowlist for the current sandbox mode.
```

The npm log ended during the `cpu-features@0.0.10` native installation hook (`node-gyp rebuild`), without a completion footer. Node header download is the likely denied operation; that attribution is inferred from the hook, not a captured request URL. No network-policy bypass was attempted.

Current transitive dependencies also reported requiring Node 24.15 (`jsdom`, among others). Installed Node 24.15.0 separately at `~/.local/share/paperclip-runtime-next/node_modules/node/bin/node`; the original runtime and user's default Node remain unchanged. Updated the repository reference and bootstrap prerequisite to 24.15. The top-level Paperclip release remains pinned, but upstream transitive dependencies are not locked by this repository.

Automatic approval review rejected a concurrent replacement of the original isolated runtime because of disk exhaustion risk; the separate 24.15 runtime already installed can be used instead. It also rejected the external memory lookup as an unverified destination; repository and conversation context sufficed.

Removed only this retry's partial npx extraction. No managed payload, shim, factory config, server, or service was created. The next retry needs permitted access to `nodejs.org` for native prerequisites and sufficient disk space. Use `PAPERCLIP_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"` on this Mac. All live acceptance checks remain pending.

## Successful package installation and current runtime blocker

A further continuation found matching Node 24.15 headers already present in the installed npm runtime. Supplying their directory through supported `npm_config_nodedir` let native compilation finish without accessing the blocked domain. The managed installer then began a second package copy while disk space approached 1.4 GiB; stopped it before exhaustion and removed only that interrupted install's staging/extraction.

Used the supported traditional global npm installation with one dedicated payload instead:

```sh
PAPERCLIP_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node" \
npm_config_nodedir="$HOME/.local/share/paperclip-runtime-next/node_modules/node/node_modules/node-bin-darwin-arm64" \
PAPERCLIP_INSTALL_METHOD=global PAPERCLIP_MIN_FREE_GIB=3 \
NODE_USE_ENV_PROXY=1 ./scripts/bootstrap
```

Observed: **437 packages installed**, exit 0. `./scripts/paperclip --version` reports **2026.1023.0**. Persistent package prefix is `~/.local/share/paperclip-global`; the stable launcher `~/.local/share/paperclip-factory/bin/paperclipai` pins absolute Node 24.15 and its child PATH. Reclaimed the install attempts' npm download cache after installation; later disk check showed 4.1 GiB free.

Interactive `onboard --no-install-service` created factory configuration, authentication secrets, local encryption key, persistent directories, and port 8100 defaults, without a model provider. Declined immediate startup. Its optional telemetry request was blocked; disabled telemetry using supported `PAPERCLIP_TELEMETRY_DISABLED=1` and `telemetry.enabled=false` before subsequent CLI/server commands. Configured authenticated/private loopback access before attempting runtime startup.

`doctor` exited 0 with **12 passed**: valid config, authenticated loopback mode, JWT presence, local encryption key, writable storage/logs, embedded PostgreSQL configuration, optional no-LLM state, available 8100 port, Node 24.15, optional managed-install absence, and service diagnostics. Doctor does not initialize or verify the running database.

Foreground server failed before HTTP startup. Isolated probes with the exact packaged `initdb`, both ordinary and escalated, reproduced:

```text
FATAL: could not create shared memory segment: Operation not permitted
DETAIL: Failed system call was shmget(...).
```

Disposable probes cleaned up. Failed factory initialization also cleaned its database directory; no business records exist. No claim URL was generated and no account or provider credential was created.

Native `service install --instance factory` wrote a valid LaunchAgent, enabled it, but failed to start it. Status reports installed=true, enabled=true, active=false, pid=null. Direct registration returned `Bootstrap failed: 5: Input/output error`. Plist, executable paths, owner permissions, GUI domain, and writable logs were checked; no malformed configuration found. No service log files were created. System-log inspection was itself denied with `Cannot run while sandboxed`; a session restriction is likely but the exact launchd rejection cause remains unverified.

LaunchAgent: `~/Library/LaunchAgents/ing.paperclip.paperclipai.factory.plist`.

Next runtime check must run in a normal Terminal:

```sh
cd /Users/bradyw/dev/paperclip-codex-factory
./scripts/paperclip service start --instance factory
./scripts/paperclip service status --instance factory --json
```

Then check health on `http://127.0.0.1:8100/api/health` and complete the manual UI, persistence, backup/restore and login-start checks. Browser automation also reported an unavailable browser access host in this session, so no visual UI acceptance was performed. All eight local regression tests and syntax/whitespace checks passed. Evidence remains local; nothing was published to GitHub and issue #1 remains incomplete.

## LaunchAgent running after normal-Terminal start

The user ran the documented service start from a normal Terminal. launchd reported active=true, enabled=true, pid=25261. The immediate health check initially raced startup; the subsequent live check succeeded:

- `/api/health`: HTTP200, status=ok, deploymentMode=authenticated, deploymentExposure=private.
- Listener: Node bound **127.0.0.1:8100** (IPv4), verified with lsof.
- Service status: installed=true, active=true, enabled=true, health.ok=true.
- UI root: HTTP200. Anonymous `/api/companies`: HTTP403 while bootstrap pending. This proves that request did not disclose company data; it does not complete post-login/browser-session acceptance.
- Server-reported commit: `1b4c803816e82b0265c8422e1a804327a7ed8c54`; installed CLI2026.1023.0.

The normal service environment successfully initialized embedded PostgreSQL. The execution-sandbox initdb/launchctl failures remain documented above, but they no longer block the running service.

Plain `db:backup --json` succeeded using the supported CLI. Verified gzip integrity and a nonempty69,336-byte dump at `~/.paperclip/instances/factory/data/backups/paperclip-20261031-163305.sql.gz`; SHA256 `5f7c7c332b6e96441dfe9be37757026a6230047eb480d2400940809439d596e9`. Backup directory/file tightened to0700/0600. Health now reports databaseBackup.status=ok and no backup warnings. Retention is30days. No dump contents or credentials were exposed. This is a logical backup test, not a full stopped-copy or restore rehearsal.

First-owner setup remains pending. Source inspection of the shipped UI confirms the ordinary local URL guides an authenticated/private unclaimed instance through Sign in / Create account and Claim this instance; no startup token needs to be pasted into chat. The user has been asked to perform that browser step. No administrative account, company, goal, task, agent, or approval has been created by the agent.

Local regression suite:8tests passed after telemetry changes; targeted bootstrap tests2/2 passed again after tightening the supported Node version gate. Normal Terminal service start is verified; restart after logout/login, visual UI acceptance, full backup and restore remain unverified.

## Agent environment-test follow-up

The user reported a generic environment-test failure on the Chief of Staff onboarding screen with OpenAI Subscription selected. The supplied screenshot displayed no individual failed checks. Browser automation remained unavailable.

Found and fixed a service launcher PATH defect: it previously prepended only Node's directory to launchd's minimal PATH, omitting `~/.local/bin`, where this Mac's Codex and Claude executables live. Upstream command-resolution code reproduced `codex_command_unresolvable` for a CLI-configured agent with that original PATH; an absolute command resolved. The launcher now keeps the pinned Node first, then includes the user's local bin, Homebrew locations, and inherited/system PATH. Updated the live launcher without reinstalling packages. Regression coverage verifies actual command resolution under a launchd-style environment and preserves shell-quoting/injection checks; targeted tests2/2 passed.

The screenshot's default OpenAI subscription flow uses package-local ACP, so the CLI PATH defect alone did not establish the original failing check. A direct call to the installed adapter's exported `testEnvironment` using the onboarding default config passed all6checks: ACP engine, cwd, Node, command resolution, native subscription readiness, and runtime scaffold. This did not exercise server-side connection/environment resolution. No provider inference, credentials change, account creation, or hire was performed by the agent.

The session could not kickstart launchd (`Operation not permitted`). After the user restarted the service from normal Terminal and retried Connect, they explicitly reported **"Connect now works"**. This is the live end-to-end verification of the requested environment-test fix; the original detailed failure was not available for attribution. No hire was initiated by the agent. Goal/task/assignment/approval UI acceptance, logout/login recovery and full restore remain separate pending foundation checks.
