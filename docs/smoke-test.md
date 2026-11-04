# Fresh-Mac smoke test

Run this procedure as the desktop user on an Apple Silicon Mac without an existing `factory` instance. Existing installations need a backup before any recovery or upgrade test. This exercise creates disposable board records and does not require a production repository, deployment, provider key, or automatic merge.

## Install and persistence

1. Install the reference Node.js `24.15.0` at a stable path. Bootstrap also accepts later Node 24.x releases or Node 26 and newer; Node 25 is excluded. Record macOS version, `uname -m`, `node --version`, and `command -v node`. Check free space: at least 10 GiB is recommended as estimated installation/build/cache headroom, not a verified minimum. Confirm no unintended `PAPERCLIP_HOME` or `PAPERCLIP_INSTANCE_ID` overrides are set.
2. Clone this repository and run `./scripts/bootstrap`. Record the selected installation method (`managed` or `global`), exact repository commit, and installed Paperclip version. Confirm it matches `2026.1023.0`.
3. Run `./scripts/paperclip onboard --no-install-service` interactively: choose Quickstart and decline **Start Paperclip now**. Do not use `onboard --yes`, which starts the server in this release. Apply `"${PAPERCLIP_NODE:-node}" scripts/configure-local.mjs "$HOME/.paperclip/instances/factory/config.json"` before any server run, then run `./scripts/paperclip doctor`. Confirm instance `factory` and persistent root `~/.paperclip/instances/factory`. Start the first foreground run with `./scripts/paperclip run` only after the authenticated config is applied.
4. Inspect the listener with `lsof -nP -iTCP:8100 -sTCP:LISTEN`. It must bind `127.0.0.1`, not `*`, a LAN address, or an unintended port. Check `http://127.0.0.1:8100/api/health` responds successfully. Health alone does not prove authentication.
5. Open `http://127.0.0.1:8100`, select **Sign in / Create account**, create or sign into your human account, then select **Claim this instance**. This authenticated/private first-admin flow does not require the startup ownership link. Keep any ownership links/codes, passwords, cookies, and raw logs out of evidence. Open a private browser window at the ordinary board URL and verify it requires authentication and cannot read board data.

## Goals, tasks, assignments, and approvals

Use the UI labels exposed by the pinned release; record any differences encountered.

1. Create a disposable company named `Factory smoke YYYY-MM-DD`. Give it a mission describing this local verification.
2. Create a goal named `Verify local coordination` and a project named `Smoke project`. Link the project to the goal, then create a task named `Verify assignment persistence` within that project. Add a short description with a harmless unique marker. Verify the goal-to-project-to-task association; use a direct task goal field only if the pinned UI supports it.
3. Create a disposable inert agent with no provider credentials. Pause it and verify that it is paused **before** assigning the task. Reload the task and verify the assignee, project/goal association, description marker, and status persist. The test checks coordination, not an agent model run.
4. Create a hiring request using the UI's request-hire flow so it enters pending approval. Open Approvals as the board owner, inspect the request, approve it, then verify the result and the resulting agent record. Keep that agent paused. Repeat with a second disposable request and reject it; verify the decision persists. If the UI bypasses approval for the board owner, record that result as incomplete and use the supported agent-request path to generate a pending request before marking this check passed.
5. Attach a harmless text fixture to the task. Reload and download it; compare its contents. This provides a non-database fixture for restore verification.

## Restart and login service

1. Stop the foreground run with Control-C. Install the service using `./scripts/paperclip service install --instance factory`; check `./scripts/paperclip service status --instance factory --json`. Stop it using `./scripts/paperclip service stop --instance factory`. Confirm port `8100` no longer serves the app.
2. Start it with `./scripts/paperclip service start --instance factory`. Sign in again if needed and verify the company, goal, task assignment, attachment, and approval decisions persist.
3. Sign out of macOS and sign back in, or reboot and log in. Without manually starting Paperclip, check service status, loopback binding, authentication, and the saved records. This is the acceptance check for restart on login.

## Backup and recovery

1. Follow the [backup procedure](operations.md#backup), recording dump success and the full stopped-copy location without exposing secrets.
2. Follow the [restore procedure](operations.md#restore) using a recovery copy or isolated rehearsal. Verify the saved records, attachment, and local-secret decryption. Record the release, restore method, and outcome. Mark untested secret recovery explicitly if no stored test secret exists.
3. Preserve evidence, then archive the disposable company or leave it labeled as a verification fixture. Keep all disposable agents paused.

## Evidence

Record observed results rather than checking off expected behavior. Redact passwords, ownership links, tokens, cookies, connection strings, master-key contents, and provider credentials. Screenshots should show only the disposable fixture. Link the resulting evidence in [issue #1](https://github.com/bradywatkinson/paperclip-codex-factory/issues/1) when authorized to publish it.

| Check | Status | Evidence |
| --- | --- | --- |
| Pinned selected install and doctor | Passed | [Dated bootstrap follow-up](evidence/2026-10-31-bootstrap.md): pinned global install completed; doctor exited 0 with 12 checks. Earlier `ENOSPC` was resolved. |
| Loopback binding and health | Passed | Healthy API; lsof confirms 127.0.0.1:8100 only |
| Human login and anonymous denial | Partial | Anonymous company request denied403 during bootstrap; [2026-11-03 preflight](evidence/issue-7-cloud-execution-demo.md) confirms saved Board authentication works. Fresh interactive login acceptance remains unverified. |
| Goal and task persistence | Pending | Await browser check |
| Agent assignment | Pending | Await browser check |
| Approval and rejection | Pending | Await pending-request workflow |
| Stop/start persistence | Pending | Await live check |
| Restart after macOS login | Pending | LaunchAgent installed, enabled and active after Terminal start; logout/login still untested |
| Logical dump and stopped full backup | Partial | Initial logical dump verified; stopped full copy remains pending |
| Restore including files and secrets | Pending | Await recovery rehearsal |

For each completed row, add the date, macOS/architecture, repository commit, Paperclip/Node versions, exact command or UI action, result, and a sanitized artifact reference. Failed or blocked checks remain visible with the next step needed; script tests cannot satisfy the UI or login-service rows.
