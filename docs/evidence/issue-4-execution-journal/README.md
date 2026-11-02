# Execution journal verification

Verified on 2026-11-02 for [issue #4](https://github.com/bradywatkinson/paperclip-codex-factory/issues/4), using Node `24.15.0` and its built-in SQLite binding. No new Cloud job was submitted for this change.

## Implemented behavior

- SQLite schema version 3 stores company/issue/run IDs, project/workspace/repository/environment/requested branch, explicit attempt, execution state, Cloud receipt, timestamps, safe error codes, and transition/run history.
- Bound statements and short writer transactions enforce unique logical attempts, one active execution per issue, receipt uniqueness, and compare-and-swap transitions.
- The bridge records queued intent and an exclusive, fsynced compatibility fence before claiming submission. A committed `dispatching` state precedes the Cloud subprocess; an accepted receipt is committed before the Paperclip handoff.
- Unknown outcomes never automatically become a new submission. Later attempts are explicit and require all previous executions to be verified terminal. A safely queued attempt may resume before any claim.
- Legacy JSON guards are imported transactionally with their source hashes and kept byte-for-byte unchanged. `dispatched` maps to accepted/`running`, while uncertain guards map to `unknown`. Missing legacy historical transitions are not invented.
- The existing outward dispatch/receipt protocol is preserved. Active or unverifiable earlier Paperclip runs are not declared interrupted; automatic recovery requires a confirmed terminal earlier run.

## Local validation

**63/63 tests passed** on reference Node `24.15.0`: 28 journal tests, 27 bridge tests and eight existing foundation tests.

```sh
node --test tests/*.test.mjs
```

Tests use temporary directories, local fixture APIs, inert CLI executables and actual child processes. Coverage includes:

- Concurrent claims and first-time schema initialization, including five fresh-directory rounds of six processes with exactly one claimant per round.
- Killed processes before acknowledgement, simulated external acceptance followed by a lost local receipt, and uncommitted SQLite transaction rollback.
- Populated schema upgrades, failed-migration rollback, future/foreign schema rejection, and atomic/idempotent legacy imports.
- Lost-database/orphan-fence recovery, a legacy writer winning the file fence, explicit later attempts, stale revisions, receipt ownership and immutable terminal states.
- Private file permissions, credential-field exclusion, safe error-code storage, API redirects, scope and checkout drift, argument injection, and process-tree cancellation.
- Instrumented filesystem ordering verifies new ancestor-directory fsyncs before database creation and fence fsync before the simulated submission boundary.

During initial schema-2 validation, independent review reproduced an initialization race. After coherent metadata locking and bounded SQLite busy handling were added, its original stress probe passed **160/160 fresh-process opens**. The final schema-3 suite also passes the automated five-by-six fresh-constructor regression. Review also identified the new-directory durability ordering gap, which was fixed and covered by the filesystem-ordering test.

These are measured process-crash/reopen and filesystem-ordering tests. No physical power-loss or actual macOS reboot test is claimed. SQLite uses WAL, synchronous FULL, and explicit fullfsync/checkpoint-fullfsync settings; a stopped full-directory backup or SQLite backup API is required rather than copying only an active database file.

## Dry-run and live legacy import

The original disposable dispatcher was paused and had no nonterminal runs during the dry-run preflight. Migration first passed on a temporary copy. Immediately before the live import, the company process-agent list was checked again: its sole process agent was paused.

The initial additive live migration imported the existing PAP-2 mapping into schema 2; that historical observation is retained separately from the schema-3 upgrade below. See [the sanitized live migration record](live-migration.json).

| Check | Observed result |
| --- | --- |
| Paperclip issue | `688630d3-a281-45ab-8707-37e5f3731663` (PAP-2) |
| Original dispatch run | `3984a3d7-b366-4dec-bd54-146a185f1b26` |
| Preserved Cloud ID | `task_e_6ae8be3af9888325b7e16a152a0843a8` |
| Journal execution ID | `ce51b48d-0f4a-4dce-bdb3-9712ef1043ed` |
| Schema / imported state / attempt | `2` / `running` (accepted) / `1` |
| Repeated import | Same execution ID, revision `0`, one initial event, one run association |
| Integrity check | `ok` |
| Database permissions | `0600`; containing directory `0700` |
| Original JSON and private backup | Identical SHA-256 before and after |
| Cloud submission / Paperclip task mutation | None |

The original guard SHA-256 remains `a7e89d741ee8529969b89002357dddfee0c55d3b1aba21e97e4c74a2d877ce9b`. A private backup was made before the import. Neither the legacy file nor the paused agent was changed.

Importing an accepted receipt does not infer remote completion from PAP-2's earlier manual closeout. Polling/reconciliation remains #5, and controller startup recovery remains #6. An operator must not resume an old JSON-only binary after cutover; the retained compatibility fence prevents duplicate submission but is not a rollback mechanism.

## Schema-3 audit correction

Final review identified that an imported initial state snapshot could carry the old guard creation time, predating its known dispatch time. Schema 3 records the import observation time for that snapshot while preserving original creation and dispatch timestamps. The migration narrowly repairs old imported snapshots; later real transitions and their timestamps remain untouched. New imports use consistent observation timestamps from the start.

After the final 63-test suite passed, the paused journal was backed up as a complete stopped directory, then upgraded from 2 to 3. [The upgrade evidence](schema-upgrade.json) confirms:

- The same execution ID, Cloud ID, original timestamps, revision and single event were retained.
- The initial snapshot event and row update time now match the original import-ledger observation. No remote event time was inferred.
- Integrity remains `ok`; repeat import is stable and the original JSON hash is unchanged.
- No Cloud submission or Paperclip task mutation occurred.

The current live journal is schema 3. The earlier schema-2 fixture is historical evidence, not the current schema declaration.

## Review and operating procedure

- [Journal API and cutover guide](../../execution-journal.md)
- [Dispatch integration guide](../../cloud-dispatch.md)
- [Journal implementation](../../../lib/execution-journal.mjs)
- [Journal regression tests](../../../tests/execution-journal.test.mjs)
- [Bridge regression tests](../../../tests/cloud-dispatch.test.mjs)

The existing ChatGPT and Paperclip credentials were used only through their normal clients; no credential values, prompts, raw subprocess errors, or unrelated account data are stored in the journal or these fixtures.
