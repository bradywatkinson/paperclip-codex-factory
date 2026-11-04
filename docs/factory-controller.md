# Managed factory queue and controller

The registered dispatcher, account scheduler, and controller work together. The controller observes Cloud and wakes eligible Paperclip dispatchers; the dispatcher alone can claim admission and submit. No application worker runs on the Mac.

## Run the registered factory

Use Node 24.15.0 and install repository dependencies with `npm ci --ignore-scripts`. First register and bootstrap repositories through the [onboarding CLI](repository-onboarding.md). The generated private plan binds the company, project, workspace, agent, runtime, journal directory, and shared scheduler directory.

```sh
FACTORY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
"$FACTORY_NODE" scripts/factory.mjs controller --once --json
"$FACTORY_NODE" scripts/factory.mjs controller --loop --json
```

The loop is foreground work. No controller login service is installed by these commands. Paperclip's own LaunchAgent is separate. `--once` exits nonzero when the report needs operator attention; a loop continues reconciling and emits bounded reports. Control-C/SIGTERM stops new work and interrupts waits.

## Admission and recovery

One shared account SQLite store enforces the global and repository ceilings across companies. Defaults are two active executions globally, one per repository, three logical attempts, and at least one second between admissions. FIFO applies within each eligible repository; a persisted service counter rotates between repositories.

Admission is committed before the journal dispatch claim and provider call. Admitted, submitted, and unknown entries occupy capacity without expiring. A process crash cannot free a slot. Only matching terminal journal evidence releases it. READY is a remote completion observation; it does not prove tests, review, or human approval.

Before admitting managed work, inventory validates all company journals under the configured root and imports their actual states. Unsupported schemas and unaudited legacy guards block cutover rather than being migrated silently. Follow the [journal backup/migration procedure](execution-journal.md) first and quiesce old adapters that do not use the admission gate. SQLite read-only inventory may create WAL/SHM bookkeeping sidecars; it does not migrate or update journal entries or guard contents.

The controller reconciles registered companies serially and shares recognized provider cooldowns. Pausing admission leaves observation and receipt recovery running. It verifies the current issue, original owner, registered agent, exact private dispatcher configuration, pinned task base, and repository/workspace binding before waking queued work. It never reopens human terminal or blocked tasks.

The pinned Paperclip release does not provide durable generic deduplication for arbitrary agent-wake idempotency keys. The controller therefore persists its own wake intent before sending. A lost response is sticky and is never automatically resent. A later delivered wake can be retried only after its run is confirmed terminal and a new explicit control/admission opportunity exists.

## Operator controls

The default scheduler directory is `~/.paperclip/instances/factory/onboarding/scheduler`. Pass `--directory /absolute/path` when using a different registered instance plan.

```sh
"$FACTORY_NODE" scripts/factory.mjs scheduler status --json
"$FACTORY_NODE" scripts/factory.mjs scheduler pause
"$FACTORY_NODE" scripts/factory.mjs scheduler resume
"$FACTORY_NODE" scripts/factory.mjs scheduler pause --repository owner/repository
"$FACTORY_NODE" scripts/factory.mjs scheduler resume --repository owner/repository
"$FACTORY_NODE" scripts/factory.mjs scheduler cooldown --milliseconds 900000
```

A bad queue head is held individually so healthy work can progress. Held rows preserve their execution ID and attempt, consume no active capacity, and require explicit intervention. Inspect the reason and current revision before resuming:

```sh
"$FACTORY_NODE" scripts/factory.mjs scheduler resume-execution \
  --execution EXECUTION_UUID --expected-revision CURRENT_REVISION
```

This resumes a held queue entry; it does not erase an unknown Cloud submission or ambiguous wake intent. An existing admitted/unknown slot requires reconciliation, not queue resumption or database deletion.

Limits have compare-and-swap revisions:

```sh
"$FACTORY_NODE" scripts/factory.mjs scheduler configure \
  --policy /absolute/private/factory-policy.yaml --expected-revision CURRENT_ACCOUNT_REVISION
"$FACTORY_NODE" scripts/factory.mjs scheduler configure-repo \
  --repository owner/repository --max-active 1 --max-attempts 2 \
  --expected-revision CURRENT_REPOSITORY_REVISION
```

Narrower explicit operator limits remain usable by registered dispatchers. Repository settings cannot exceed the registered contract's ceilings. Status reports queue depth, held attention, active Cloud IDs, duration, terminal counts and execution success rate; it does not claim token or subscription accounting. Bounded lists report truncation explicitly.

## Delivery evidence

`factory delivery inspect --help` documents the existing-journal and registry identifiers. The command collects the original Cloud diff, checks a supplied PR's exact repository/base/head/ancestry and patch, and observes required CI at that head. It stores a private patch and immutable observation. A patch fallback or missing/failed/pending checks never unlocks human approval. Successful inspection permits independent review only; the durable review/repair pipeline remains separate work.

See the [dated implementation evidence](evidence/epic-implementation-2026-11-03.md) and [full epic audit](epic-status.md). Fixture/process tests do not prove a live Cloud job survives a physical Mac interruption or that both real repositories are operational.
