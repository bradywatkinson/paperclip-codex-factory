# Issue #6: controller recovery verification

Verified on November 2, America/Los_Angeles (`2026-11-03` UTC), with Node **24.15.0**, based on merged PR #19 (`08f9697`). The full local suite passed **140/140 tests**. Independent review found no remaining actionable defects after the retry-ceiling claim was fenced transactionally.

## Repeatable verification

From the repository root:

```sh
RECOVERY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
"$RECOVERY_NODE" --test tests/controller-recovery.test.mjs tests/controller-restart.test.mjs tests/recovery-journal.test.mjs
"$RECOVERY_NODE" --test tests/*.test.mjs
```

The focused suite passed **34/34 tests**: 25 controller/restart tests and nine recovery-journal tests. All provider commands and Paperclip responses were inert fixtures; no saved credentials, live Paperclip service, or real Cloud job were accessed.

## Actual controller-process restart

`tests/controller-restart.test.mjs` exercises the real dispatcher, journal, controller entrypoint, and subprocess command runner:

1. `dispatchFromPaperclip` submits once to an inert executable and records its accepted fixture Cloud ID.
2. A child controller runs `--loop`, reads fixture PENDING, and commits the observation.
3. The test kills that controller with `SIGKILL` between passes and waits for process exit.
4. The fixture remote state becomes READY. A test-only Node preload advances wall time between processes past the normal poll schedule; production code has no clock-test flag.
5. A fresh controller process runs `--once` against the same durable company directory.
6. The same execution ID and Cloud ID reach `succeeded`, with observations `pending` then `ready`, one delivered review card, exactly two Cloud list reads, and exactly one submission. Paperclip remains `blocked`.

A separate process test resumes polling through `--resume-poll` and verifies that the receipt and company cooldown survive. Resuming does not submit work, bypass cooldown, or reset uncertain notification delivery.

## Recovery and concurrency coverage

The focused tests cover terminal/active/unavailable/mismatched dispatch owners; revision races while owner reads are in flight; queued and unknown submissions without IDs; bounded rotating owner checks; live and expired poll leases; persisted retry ceilings and explicit resume; and read-only recovery of uncertain notifications without resending.

Two journal regressions verify that a stale inventory cannot claim a poll after another controller reaches its retry ceiling, and that paused rows are filtered before `LIMIT` so later due work remains eligible. Concurrent processes verify that cooldown extension is atomic and cannot shorten an existing deadline.

Synthetic quota diagnostics verify company-wide cooldown, privacy of raw errors, no additional provider calls during cooldown, and continued delivery of already durable READY notifications. A cooldown deferral does not consume a polling-error attempt; an actual quota-error response does.

## Limits of this evidence

This is a real local process-stop/restart test with simulated remote services, not a physical Mac sleep/reboot, live Paperclip service restart, full-instance restore, or power-loss experiment. No recovery LaunchAgent was installed. The pinned CLI still has no recorded live quota-error fixture; usage-limit text recognition remains an explicitly documented heuristic. These checks do not establish acceptance criteria, final assistant output retrieval, or PR metadata delivery.
