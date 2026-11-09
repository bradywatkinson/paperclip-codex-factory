# Codex CLI 0.167.0 read-only compatibility observations

Captured on 2026-11-09 using the retained absolute 0.167.0 executable identified
and hashed in `manifest.json`. Each command records its literal argv, separate
stdout/stderr, UTC start/end, exit code, signal, timeout and redactions. No
credentials or authentication files were inspected. Task titles were redacted.

Version, help, saved ChatGPT sign-in, and the filtered Story Keeper environment
list all exited successfully. All six captured Cloud help stdout files are
byte-identical to their historical 0.166.0 counterparts under `../installed/`.
The list retained the repository label, nullable
environment ID, task ID/URL, status, summary counters and cursor needed by the
existing production parser. Its most recent task is an existing review task,
not a factory coding result produced during this capture.

The status command observed the prior accepted probe documented in
`../live/dispatch/manifest.json`. It returned `[READY]`, the Story Keeper label,
and `no diff`. This is a read-only observation of a task originally submitted
with 0.166.0; it does not prove submission or a lifecycle transition with 0.167.0.

No new task, actual exec/apply command, task reassignment, journal reconciliation,
service control or admission change was performed. Actual diff was not captured.
New-version dispatch, pending/ready transition, failure/deadline behavior and
application coding/test results remain unverified by these observations.

`tests/codex-0167-compatibility.test.mjs` consumes these captures through the
production list parser and checks their provenance and observed binding shape.
The 0.166.0 historical fixtures remain unchanged.
