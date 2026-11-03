# Issue #5: live polling of the existing Cloud execution

Verified at `2026-11-03T04:36:03.733Z` (November 2, America/Los_Angeles), after the initial reference-runtime suite passed 99/99 tests. Final validation, including the configuration lease-budget check, passed **100/100 tests**. This was one bounded reconciler pass over the existing #3 Cloud execution. It submitted no Cloud job and created no Paperclip interaction or comment.

## Read-only preflight and backup

Python SQLite inspection used a `mode=ro` connection before any migration. It found schema **3**, `quick_check: ok`, and exactly one execution:

| Field | Before the pass |
| --- | --- |
| Company | `dc9439c0-a0d6-4233-b81f-2cc3adc2ec0b` |
| Execution | `ce51b48d-0f4a-4dce-bdb3-9712ef1043ed` |
| Paperclip task | `PAP-2`, `688630d3-a281-45ab-8707-37e5f3731663` |
| Cloud task | `task_e_6ae8be3af9888325b7e16a152a0843a8` |
| Execution state | `running`, attempt `1`, revision `0` |

The normal signed-in Paperclip CLI confirmed that PAP-2 was already `done`, with status version `3`, `updatedAt: 2026-11-02T16:54:46.961Z`, and a null unblock descriptor. No credential store was read manually.

Before opening the journal with the new code, SQLite's online backup API copied the read-only source to `/private/tmp/factory-issue-5-cloud-poll-l4gf2jkr/pre-schema-4.sqlite`. The private directory is mode `0700`; the backup and private configuration are mode `0600`. The backup passed `integrity_check: ok`, remained schema `3`, and had SHA-256:

```text
6d9db25b0ff17c9067393438f72ab6d5578c63136a3df28da3834cc3a0ab16ec
```

This is a temporary local SQLite backup, not a full-instance restore or power-loss test. Its contents and the private configuration were kept outside the repository.

## Bounded command and result

The private schema-1 reconciler configuration selected the exact company directory above, the controller's stable Codex and Paperclip executables, loopback `http://127.0.0.1:8100`, and `maxRecords: 1`. Other limits were `intervalMs: 30000`, `maxPages: 5`, `requestGapMs: 1000`, `commandTimeoutMs: 15000`, `leaseMs: 120000`, and `maxOutputBytes: 256000`.

The command used Node **24.15.0**:

```sh
/Users/bradyw/.local/share/paperclip-runtime-next/node_modules/node/bin/node \
  scripts/cloud-reconcile.mjs \
  --config /private/tmp/factory-issue-5-cloud-poll-l4gf2jkr/cloud-reconcile.json \
  --once
```

It exited `0` and returned:

```json
{"status":"reconciled","polled":1,"ready":1,"notified":0,"skipped":1,"unresolved":0}
```

The reconciler read the pinned Codex CLI version/login status and Cloud list output for the known execution. It did not invoke Cloud submission, apply, or any mutation command. Raw Cloud list output, unrelated tasks, and credentials are excluded from this evidence.

## Read-after verification

A read-only SQLite inspection and the normal Paperclip CLI confirmed:

| Check | Observed result |
| --- | --- |
| Journal schema / integrity | Schema `4`; `integrity_check: ok`. |
| Cloud observation | `ready`, remote update `2026-11-02T16:47:39.522Z`, observed locally `2026-11-03T04:36:03.733Z`. |
| Reported changes | `filesChanged: 0`, `linesAdded: 0`, `linesRemoved: 0`; error count `0`. |
| Execution | Same ID and Cloud receipt; state `succeeded`, revision `1`. |
| Preserved mapping | Company, issue, original dispatch run, project/workspace, repository, environment, branch, mode, attempt, Cloud ID, emitted/navigation URLs, and original creation/dispatch timestamps matched the backup. |
| Notification outbox | One `ready_for_review` entry, `mode: notify`, state `skipped`, code `PAPERCLIP_ALREADY_TERMINAL`. |
| Paperclip task | Still `done`; status version `3`, original `updatedAt`, and null unblock descriptor unchanged. |
| Original guard | SHA-256 unchanged: `a7e89d741ee8529969b89002357dddfee0c55d3b1aba21e97e4c74a2d877ce9b`. |

The observation records the old remote update time separately from the new local observation time. `succeeded` establishes remote Cloud completion, not acceptance of the task's work. PAP-2's earlier human completion remained intact; the outbox's stored review target did not cause a task-status update.

This verifies real CLI polling, additive schema migration, durable READY observation, and preservation of an already terminal human decision. [Separate disposable-task verification](issue-5-reconciliation.md) covers actual interaction-card delivery, idempotency, and the terminal-issue guard. Neither record verifies acceptance criteria, final assistant output retrieval, PR metadata, browser rendering, or full controller restart/power-loss recovery.
