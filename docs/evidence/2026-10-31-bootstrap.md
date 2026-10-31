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
