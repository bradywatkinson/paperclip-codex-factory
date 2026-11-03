# Codex Cloud polling and review notifications

Issue [#5](https://github.com/bradywatkinson/paperclip-codex-factory/issues/5) adds a local reconciler for accepted Cloud executions recorded in the [execution journal](execution-journal.md). It polls the pinned CLI, records sanitized observations, and creates a review-notification interaction card in Paperclip when Cloud reports READY. **It preserves every Paperclip task status.** A blocked task stays blocked until an operator reviews the result and decides what to do.

The implementation is `lib/cloud-reconcile.mjs`, invoked by `scripts/cloud-reconcile.mjs`. Reference versions are Node **24.15.0**, Codex CLI **0.166.0**, and Paperclip **2026.1023.0**. It uses the supported CLIs and the local schema-4 journal; it changes no Paperclip core files. Broader controller startup recovery remains #6.

## What READY establishes

The observed Cloud list contract recognizes `pending` and `ready`. A pending observation keeps a known execution running; READY records the remote execution as `succeeded` and queues a notification. That journal state means the Cloud job completed and needs review. It does not verify acceptance criteria or complete the Paperclip task.

The interaction card includes the stable `https://chatgpt.com/remote/<taskId>` link and a deterministic execution marker. The CLI does not expose the final assistant response or PR metadata. The card says those fields are unavailable; the reconciler does not invent result text, PR links, or acceptance evidence. Summary counts describe reported file and line changes, without treating zero changes as a failure. The card offers **Reviewed** and **Needs follow-up**. Either response resolves the handoff card only: it does not verify acceptance criteria, mark the task done, resume an agent, or submit another Cloud execution.

Unknown statuses, missing tasks, malformed output, environment or URL mismatches, local command failures, and timeouts remain unresolved and use bounded retry backoff. They do not prove remote failure, cancellation, or completion. The pinned `cloud status` command's pending exit code and `cloud diff`'s empty output are not used as terminal evidence. See [the observed CLI contract](codex-cloud/README.md).

## Configuration and sign-in

Copy [the example](../examples/cloud-reconcile.json) to private controller configuration, outside application repositories. Replace the example user paths and company ID. `stateDir` must select the same company journal used by the dispatcher. Paths are absolute strings; no shell or `~` expansion is performed.

| Field | Purpose and default |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `companyId` | Intended Paperclip company UUID. |
| `stateDir` | Absolute company journal directory. |
| `codexCommand` | Absolute Codex executable; defaults to `~/.local/bin/codex` resolved for the controller user. |
| `paperclipCommand` | Absolute Paperclip CLI executable; defaults to the stable launcher `~/.local/share/paperclip-factory/bin/paperclipai`. This repository's absolute `scripts/paperclip` path also works. |
| `apiBase` | Authenticated HTTP loopback origin, default `http://127.0.0.1:8100`. |
| `intervalMs` | Delay between foreground passes; default `30000`. |
| `maxRecords` | Maximum executions polled and maximum handoffs checked per pass, independently; default `10` for each phase. |
| `maxPages` | Maximum Cloud list pages per execution; default `5`. |
| `requestGapMs` | Shared minimum gap between provider requests; default `1000`. |
| `commandTimeoutMs` | Per-command local deadline; default `15000`. It does not cancel remote work. |
| `leaseMs` | Durable work-claim lifetime; default `120000`. It must exceed the configured worst-case command budget described below. |
| `maxOutputBytes` | Bound on captured command output; default `256000`. |

There is no task-status mode in the reconciler configuration. Delivery is notification only.

`leaseMs` must be greater than `max(maxPages × (commandTimeoutMs + requestGapMs), 5 × commandTimeoutMs) + requestGapMs`. Configuration that cannot fit its own polling/delivery command budget is rejected before work starts. Contention can still consume a lease; a command is bounded by its remaining lease deadline, and an expired result cannot commit.

Use the normal Paperclip Board CLI sign-in flow, with the same user who will run the reconciler:

```sh
./scripts/paperclip auth login --api-base http://127.0.0.1:8100 --no-browser
```

Approve the request in the browser. The Paperclip CLI manages its private credentials. Do not copy a Board token into configuration or a command argument. Codex must already report the pinned version and ChatGPT subscription sign-in. The reconciler does not dispatch work or sign in automatically.

## Run one pass or poll periodically

Use a supported Node executable. These example commands run from the repository root:

```sh
RECONCILE_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
RECONCILE_CONFIG="$HOME/.paperclip/instances/factory/config/cloud-reconcile.json"

"$RECONCILE_NODE" scripts/cloud-reconcile.mjs --config "$RECONCILE_CONFIG" --once

"$RECONCILE_NODE" scripts/cloud-reconcile.mjs --config "$RECONCILE_CONFIG" --loop
```

`--once` performs a bounded pass. `--loop` repeats in the foreground; Control-C requests a stop between commands. No background service or LaunchAgent is installed automatically. Opening the journal upgrades a supported older schema, including during a one-pass run. Follow the [stopped-backup procedure](execution-journal.md#local-inspection-and-cutover) before the first run against an existing journal.

Only due `running` or `unknown` records with a validated stored Cloud ID are eligible. Queued and dispatching submissions are not polled. Unknown submissions without an ID require operator investigation; the reconciler does not guess a match from titles, search for a replacement execution, or submit a retry. A later attempt still requires an explicit sequential attempt number after the previous attempt is confirmed terminal.

## Durable observations and delivery

Each pass runs commands serially, with one command in flight. Per-execution leases prevent competing local processes from observing the same execution concurrently. A shared company rate reservation bounds provider request frequency across processes. Commands run outside SQLite transactions. Recording a valid observation checks its lease and execution revision, then commits the observation, any terminal execution transition, and the notification outbox entry together. A stale remote timestamp cannot overwrite a newer accepted observation, and a stale observer cannot change a later operator decision.

The journal persists only task identity, validated timestamps/statuses, bounded summary counts, schedules, lease metadata, stable error codes, and the fixed generated notification. It excludes raw command output, stderr, task titles, prompts, API response bodies, and credentials. Pending notification delivery is tracked separately from execution state, so a completed execution remains eligible for its undelivered notification.

Before notification, the reconciler checks the current Paperclip company, project/workspace and repository binding, task assignment, and original dispatch ownership. Only an unchanged task still in `blocked` is notified. Completed/cancelled tasks, tasks already in review or another status, and changed bindings or assignees are preserved and delivery is skipped. It never changes task status or assignment.

A queued or running original dispatch run can still be finishing its Paperclip handoff after Cloud reports READY. For a task still in the same scope and assignment, notification remains `pending` with `PAPERCLIP_DISPATCH_ACTIVE` and is checked again after the configured interval. Once the original run finishes, the usual task-status and binding checks decide delivery. Cloud is not polled again after READY; the pending notification is handled independently.

The notification uses the supported `issue interaction:create` CLI with an idempotency key `factory-cloud-review:<executionId>`, kind `request_confirmation`, resolver policy `human_only`, and continuation policy `none`. Its custom target is distinct from Paperclip's native completion-review workflow. It has no addressee or source-run ID. The server locks the issue while creating the card and atomically rejects a terminal issue without changing its status. The card does not wake a dispatcher or continue an agent run. The dispatch bridge's duplicate-submission guard remains protection against independent wakes.

The outbox records `sending` durably before invoking interaction creation. An expired lease that never reached `sending` can be retried. An interrupted, timed-out, or otherwise ambiguous write becomes a read-reconciliation case: **it is never automatically sent again**. Later passes use `issue interactions` to search for an exact matching card body and idempotency key created by the currently signed-in Board user. A confirmed matching card marks delivery complete. An absent or unverifiable match remains unknown for operator attention and bounded later read checks. An agent-created card or copied marker is not sufficient proof of delivery; changing Board users can also prevent automatic confirmation of an earlier write.

Do not delete fences, reset outbox rows, increment attempts, or create a replacement card manually merely to clear an unknown state. Inspect the existing Paperclip interactions and journal evidence first. The stable interaction idempotency key provides server-side duplicate protection; the local outbox also refuses to replay ambiguous writes.

Source inspection of the pinned Paperclip release showed that Board-authenticated issue comments, including comments supplied through issue PATCH, can implicitly reopen `blocked` or `done` tasks as `todo`. Omitting a status argument does not make those routes status preserving. This reconciler therefore uses interaction cards and never uses Board comments as notifications. This behavior was discovered before any live notification write; it is source evidence, not a live status-change experiment.

## Inspection and verification

Each CLI pass prints JSON with `polled`, `ready`, `notified`, `skipped`, and `unresolved` counts. Its status is `reconciled` when `unresolved` is zero and `needs_attention` otherwise. Operational failures can remain unresolved with a future retry schedule; a completed pass is not proof that every notification was delivered. Startup/configuration failures also emit `status: needs_attention`, a stable error code, and a nonzero exit.

Use `scripts/execution-journal.mjs get` with the company, issue, and attempt to inspect execution state, polling schedule, observations, and handoffs. The [journal inspection guide](execution-journal.md#local-inspection-and-cutover) shows the full command. A `succeeded` execution with a pending/unknown handoff is a completed Cloud job with unresolved notification delivery, not an accepted Paperclip task.

```sh
node --check lib/cloud-reconcile.mjs
node --check scripts/cloud-reconcile.mjs
node --test tests/reconciliation-journal.test.mjs tests/cloud-reconcile.test.mjs
node --test tests/*.test.mjs
```

Tests use disposable journals and inert CLI fixtures. Journal coverage includes concurrent claims and rate reservations, expired leases, stale timestamps/revisions, atomic READY/outbox commits, schema upgrades, safe evidence storage, and ambiguous-write fencing. These checks do not establish live notification delivery or restart/power-loss behavior. No new Cloud job is needed to verify polling of an existing accepted task; any live verification should retain its separate provenance and exclude credentials.

Final reference-runtime validation passed **100/100 tests**. A [disposable local Paperclip task](evidence/issue-5-reconciliation.md) verified interaction creation, unchanged blocked status, idempotent replay, and rejection on a terminal task. A [separate pass over the existing accepted Cloud task](evidence/issue-5-cloud-poll.md) migrated its backed-up journal to schema 4, recorded READY, and skipped notification because PAP-2 was already done. It returned `polled: 1`, `ready: 1`, `notified: 0`, `skipped: 1`, `unresolved: 0`; PAP-2's status version and update timestamp were unchanged. Neither live check submitted a Cloud job.
