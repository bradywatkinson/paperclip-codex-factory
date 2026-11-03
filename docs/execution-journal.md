# Durable execution journal

Issue [#4](https://github.com/bradywatkinson/paperclip-codex-factory/issues/4) replaces the dispatch bridge's JSON-authoritative guard with a transactional SQLite execution journal. The implementation is `lib/execution-journal.mjs`; `scripts/execution-journal.mjs` provides local inspection, guard import, and interrupted-claim recovery.

The journal uses Node's built-in `node:sqlite`, with no package dependency. The reference runtime is Node **24.15.0**, where the [SQLite module is release candidate, stability 1.2](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html). The journal accepts Node 24.x from 24.15 onward or Node 26 and newer, and rejects Node 25. Keep the dispatcher agent's absolute Node path on a supported runtime.

This change stores execution state. Cloud polling, automatic Paperclip completion, and controller-startup reconciliation remain #5 and #6. A journal row marked `running` means an accepted Cloud receipt is recorded; it is not proof that Cloud work is still executing or has succeeded.

## Storage and identity

The default company directory remains:

```text
~/.paperclip/instances/factory/data/cloud-dispatch/<companyId>/
```

`PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` choose the instance. The directory contains `executions.sqlite`, any SQLite WAL/shared-memory sidecars, and retained `<issueId>.json` compatibility fences or original legacy guards. Directories are mode 0700 and the database is mode 0600.

Each execution stores company, Paperclip issue and dispatch-run IDs, project/workspace, repository, explicit Cloud environment, requested branch, mode, logical attempt, state, timestamps, revision, sanitized error code, and any accepted Cloud ID/emitted URL/navigation URL. Separate tables retain state-transition history and associated Paperclip run IDs, including later re-invocations. A queued attempt resumed by another run records the actual claimant as the dispatch run while retaining earlier run associations.

The database enforces:

- Uniqueness of `(company, issue, attempt)` and of non-null Cloud task IDs.
- At most one `queued`, `dispatching`, `running`, or `unknown` execution for an issue.
- An exclusive queued-to-dispatching claim, with the original claimant owning receipt acceptance.
- State/revision comparison before updates, so stale observations cannot silently overwrite newer state.

Project configuration adds optional `attempt`, an integer from 1 through 100, defaulting to 1. Increasing it is an explicit operator/reconciler decision. Attempts must be sequential and every preceding attempt must already be terminal. An unknown outcome cannot be bypassed by choosing another run ID or attempt number. Changed project/workspace/repository/environment/branch/mode bindings also require reconciliation.

## State model

| State | Meaning and permitted progress |
| --- | --- |
| `queued` | Durable intent exists, but submission has not been claimed. A validated later invocation may resume it. It can be claimed as `dispatching`, recorded as `failed`/`cancelled`, or conservatively marked `unknown`. |
| `dispatching` | The claim committed before launching Cloud submission. The original process may still be active. A valid receipt advances it to `running`; an interrupted or ambiguous submission becomes `unknown`. |
| `running` | A validated accepted Cloud receipt is stored. Later trusted reconciliation can record `succeeded`, `failed`, `cancelled`, or `unknown`. |
| `unknown` | Submission or recording outcome requires investigation. Known Cloud IDs are retained. Trusted reconciliation may resolve it to `running` or a terminal state; it never returns automatically to `queued` or `dispatching`. |
| `succeeded`, `failed`, `cancelled` | Terminal observations. They are immutable for that logical attempt. A later attempt requires a separate, explicit number. |

The bridge does not infer Cloud failure or cancellation from a local deadline, process signal, nonzero submission exit, or malformed receipt. It retains the intent and any known ID. A new caller is not evidence that the submitting process died: the bridge checks the original Paperclip heartbeat and recovers an interrupted claim only after that heartbeat is confirmed terminal. Active, inaccessible, or unverifiable owners remain untouched and require attention.

The existing stdout protocol is preserved: accepted dispatch returns `status: dispatched`, and receipt reuse returns `status: already_dispatched`. These receipts now also include execution ID, attempt, and execution state. Their original dispatch-run ID and explicit environment/branch remain available.

## Durability and schema migration

The database uses WAL mode, `synchronous=FULL`, `fullfsync=ON`, `checkpoint_fullfsync=ON`, foreign keys, a five-second busy timeout, prepared statements, and short `BEGIN IMMEDIATE` transactions. New directory entries, including newly created ancestors, are fsynced before journal creation; the compatibility fence and its directory are synced before submission. Network requests and CLI execution happen outside transactions. The committed dispatch claim precedes the remote call; accepted receipts are committed before the Paperclip handoff. These are requested durability mechanisms, not a physical power-loss test.

Application ID `0x46434a31` identifies the database. `PRAGMA user_version` tracks current schema version **3**:

1. Version 1 creates executions with identity, binding, state, receipt, timestamp, and error fields.
2. Version 2 adds revisions, the active-execution uniqueness index, transition history, run associations, and legacy-import provenance. Existing version-1 rows receive initial history/run records without changing their receipt or state.
3. Version 3 repairs untouched legacy-import snapshots whose initial event and `updatedAt` were backdated to the old guard creation time. It uses the recorded import observation time, preserving original `createdAt`/`dispatchedAt`, execution identity, state, and revision.

Known migrations and application/version metadata checks run inside one transaction under the writer lock. WAL activation uses a bounded busy retry after migration, so concurrent fresh openers do not combine inconsistent metadata snapshots. An unsupported future/foreign schema or a failed migration stops the operation; it is not deleted or silently recreated. Crash tests cover uncommitted transaction rollback and committed-intent survival. This does not claim recovery of metadata that never reached the controller: a Cloud task accepted just before local receipt persistence can remain unknown without a recoverable Cloud ID.

Only allowlisted fields enter execution records. Arbitrary legacy extras, prompts, command arguments, raw CLI/API errors, bearer values, and credential-store contents are not copied into the journal. Error values are stable allowlisted codes; an unrecognized value becomes `UNCLASSIFIED_ERROR`.

## Legacy guards and compatibility fences

Import reads each original version-1 guard and records its SHA-256 and import identity transactionally. The original file is kept byte-for-byte unchanged. Repeating an unchanged import is idempotent. A malformed, changed, inconsistent, or conflicting guard fails closed. Batch import validates the guards before committing them together. New imports retain the guard's original creation and dispatch times, while `updatedAt`, the initial audit event's `at`, and import provenance record the import observation time. They do not claim that the imported state was observed at the old creation time.

| Legacy guard | Journal interpretation |
| --- | --- |
| `dispatched` with a valid receipt | `running`: accepted, not remotely succeeded. |
| `dispatching` | `unknown`: the old process may have submitted before it stopped. |
| `unknown` | `unknown`, preserving a known valid receipt if present. |

Before a new SQLite claim, the bridge creates and fsyncs an exclusive version-1-shaped JSON fence, including its journal execution ID, and syncs the directory. This prevents a JSON-only older writer from claiming the same issue while the SQLite writer submits. If an old writer wins that file race after the journal queued an intent, the new writer does not submit; a matching original guard can reconcile only the unclaimed queued row. Claimed/conflicting records are not overwritten.

New fences remain immutable and may continue to say `dispatching` after the SQLite row advances. **Use the journal for current state.** Fences are duplicate-submission protection, not a second mutable status store. A later explicit attempt can reuse the existing same-issue fence only after previous executions are terminal. An orphan fence with no surviving database row imports as unknown rather than allowing another submission.

Do not remove a fence, edit a row, or increment an attempt simply to force a retry. Old binaries do not understand the journal's current states or later attempts; rolling one back after cutover is not a supported recovery procedure. Quiesce older dispatchers and reconcile first even though the compatibility fence protects the submission boundary.

## Local inspection and cutover

Select the supported Node runtime and replace the placeholders with the intended company and issue IDs. These commands do not require a Paperclip API key and do not submit Cloud work. Opening the journal initializes/upgrades a supported database, including for inspection commands.

```sh
JOURNAL_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
COMPANY_ID="<companyId>"
ISSUE_ID="<issueId>"
STATE_DIR="$HOME/.paperclip/instances/factory/data/cloud-dispatch/$COMPANY_ID"

"$JOURNAL_NODE" scripts/execution-journal.mjs list \
  --state-dir "$STATE_DIR" --company-id "$COMPANY_ID"

"$JOURNAL_NODE" scripts/execution-journal.mjs get \
  --state-dir "$STATE_DIR" --company-id "$COMPANY_ID" \
  --issue-id "$ISSUE_ID" --attempt 1
```

`list` returns the company's execution records. `get` returns the selected execution, transition events, and associated Paperclip runs. Outputs use a `journalSchemaVersion` plus `result` envelope; failures emit a stable `JOURNAL_`-prefixed `code` and exit nonzero.

For a cutover:

1. Pause the old process-dispatch agents and wait for active local dispatchers to stop. Disabling timer wakes alone does not stop on-demand or already-running work. Leave unrelated model agents unchanged.
2. Take a stopped full-instance backup following [the backup procedure](operations.md#backup). Keep original guards and all journal files. With WAL, copying only an open `executions.sqlite` file can omit committed data; stop all journal connections for a filesystem copy.
3. Install the upgraded bridge and supported Node runtime. Import a single guard, or omit `--issue-id` for all UUID-named guards in that company directory:

```sh
"$JOURNAL_NODE" scripts/execution-journal.mjs migrate-guards \
  --state-dir "$STATE_DIR" --company-id "$COMPANY_ID" \
  --issue-id "$ISSUE_ID" --quiesced
```

4. Inspect the record, compare the original guard hash before/after, and repeat the import to check idempotence. An old `dispatched` guard remains `running` even if someone previously completed its Paperclip task; that old guard alone does not establish the Cloud outcome.
5. Resume only upgraded dispatchers after the mappings and unresolved outcomes are reviewed. Do not automatically create new attempts for imported unknown records.

If a recorded submitting heartbeat is confirmed terminal and the old dispatcher is stopped, an operator can explicitly classify its interrupted claim:

```sh
"$JOURNAL_NODE" scripts/execution-journal.mjs recover \
  --state-dir "$STATE_DIR" --company-id "$COMPANY_ID" \
  --issue-id "$ISSUE_ID" --attempt 1 --quiesced
```

This changes a `dispatching` journal row to `unknown`; it **does not cancel a Cloud task, discover a missing Cloud ID, or retry submission**. The CLI trusts the operator's `--quiesced` assertion; unlike the bridge's own-run check, it does not query Paperclip to establish liveness.

## Verification

Run the journal and bridge tests with Node 24.15.0:

```sh
node --test tests/execution-journal.test.mjs tests/cloud-dispatch.test.mjs
node --test tests/*.test.mjs
```

Final schema-3 validation on Node 24.15.0 passed **63/63 tests**: 28 journal, 27 bridge, and 8 baseline tests. A separate fresh-start stress check completed **160/160 opens**; an automated regression uses five rounds of six concurrent constructors against new databases.

The tests use temporary journals, separate local processes, fixture HTTP APIs, and inert executables. They cover competing claims, killed processes before/after simulated remote acceptance, transaction rollback, schema upgrades/rollback, old-writer races, orphan/changed/corrupt guards, receipt uniqueness, state/revision checks, attempts, run associations, permissions, and exclusion of credentials/raw errors. They do not create real Cloud jobs or migrate live guards.

## Observed additive migration — 2026-11-02

The original PAP-2 guard was migrated after confirming that the company's sole process dispatcher was paused. The [sanitized initial live migration record](evidence/issue-4-execution-journal/live-migration.json) records the historical schema-2 stage, `integrity_check: ok`, and the following preserved identity:

- Paperclip issue `688630d3-a281-45ab-8707-37e5f3731663`, original run `3984a3d7-b366-4dec-bd54-146a185f1b26`.
- Cloud task `task_e_6ae8be3af9888325b7e16a152a0843a8`.
- Imported execution `ce51b48d-0f4a-4dce-bdb3-9712ef1043ed`, attempt 1, state `running`.

The original guard, its backup, and the guard after import shared SHA-256 `a7e89d741ee8529969b89002357dddfee0c55d3b1aba21e97e4c74a2d877ce9b`. Repeated import retained the execution ID, revision 0, and one initial event. The migration made no Cloud submission and changed no Paperclip task state. `running` is deliberately the conservative interpretation of the old accepted receipt, even though PAP-2 had already been manually completed.

The current implementation upgrades journal schemas through version 3. The initial live migration record above is preserved as schema-2 evidence. After a stopped journal-directory backup, the [separate schema-2 → schema-3 upgrade observation](evidence/issue-4-execution-journal/schema-upgrade.json) verified integrity and preserved the execution ID, accepted state, Cloud ID, original creation/dispatch timestamps, revision 0, one event, and the unchanged legacy guard hash.

Schema 3 corrected `updated_at` and the initial event's `at` to the already recorded original import time, `2026-11-02T17:47:08.305Z`. It did not invent a new remote acceptance time or use the later schema-upgrade time. Repeated import preserved the complete record. The upgrade submitted no Cloud work and changed no Paperclip task state; the process dispatcher remained paused.

The #3 [live dispatch evidence](evidence/issue-3-cloud-dispatch/README.md) remains a historical JSON-guard observation. Full Mac-reboot and physical power-loss recovery have not been tested. New polling and automatic completion remain #5; broader startup/restart reconciliation remains #6.
