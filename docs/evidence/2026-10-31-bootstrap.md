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

Shell syntax, JavaScript parsing, configuration behavior, and failure handling are covered by repository checks. See the test command in README. These checks do not prove a working Paperclip installation.

## Remaining acceptance

All live acceptance checks remain pending: managed installation/doctor, authenticated UI and anonymous denial, goals/projects/tasks, agent assignments, approvals/rejections, persistence, backup and restore, service registration and restart after login.

Next: provide at least 10 GiB free (a conservative bootstrap budget, not a measured upstream requirement), rerun the documented installation, then complete [the smoke test](../smoke-test.md). Retain this failed attempt as evidence; add a later verified result instead of rewriting it as success. No evidence has been posted to GitHub.
