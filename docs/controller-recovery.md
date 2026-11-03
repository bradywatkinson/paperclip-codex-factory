# Recover Cloud work after controller restart

Issue [#6](https://github.com/bradywatkinson/paperclip-codex-factory/issues/6) adds a local recovery pass around the [Cloud reconciler](cloud-reconcile.md). Restarting this controller resumes observation of existing journal executions; it never submits a Cloud job. Paperclip task status remains a human decision.

The entrypoint is `scripts/controller-recovery.mjs`. It uses the same private company configuration, pinned Codex CLI, saved Paperclip Board CLI sign-in, and schema-4 [execution journal](execution-journal.md) as the dispatcher and reconciler. There is no new schema migration or Paperclip core modification.

## Start or restart the controller

Select a supported Node runtime, and point to the existing private configuration outside application repositories:

```sh
RECOVERY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
RECOVERY_CONFIG="$HOME/.paperclip/instances/factory/config/cloud-reconcile.json"

"$RECOVERY_NODE" scripts/controller-recovery.mjs --config "$RECOVERY_CONFIG" --once

"$RECOVERY_NODE" scripts/controller-recovery.mjs --config "$RECOVERY_CONFIG" --loop
```

`--once` inventories current journal state and performs one bounded recovery/reconciliation pass. `--loop` repeats in the foreground. After stopping the process, reopening the same company directory resumes its durable work. Start this command again after a reboot or process restart; no recovery LaunchAgent is installed automatically. A running foreground process can continue after Mac sleep, but this implementation does not establish that macOS will keep it alive or start it after login.

Opening the journal still initializes or upgrades supported older schemas. Follow the [backup and cutover procedure](execution-journal.md#local-inspection-and-cutover) before first use against an older journal. Use normal Paperclip CLI sign-in; do not put credentials in configuration or arguments.

## What startup does

Every pass inventories all nonterminal executions and separately considers pending notification handoffs, including handoffs whose Cloud execution is already terminal. Startup checks for `dispatching` owners are bounded by `maxRecords`; the loop carries a cursor so one active or inaccessible owner cannot permanently prevent later entries from being checked. A one-pass invocation can report deferred owner checks; keep `--loop` running to visit those later entries.

| Journal state | Recovery behavior |
| --- | --- |
| `queued` | Preserve the unsent intent. Do not claim or submit it automatically; report the need for operator action. |
| `dispatching`, original Paperclip run queued/running | Preserve the active owner's claim and wait. A controller restart is not evidence that the dispatcher stopped. |
| `dispatching`, original Paperclip run confirmed terminal | Validate the returned run/company/issue binding, then use the recorded execution revision to change the interrupted claim to `unknown`. No Cloud ID means investigation is required. |
| `dispatching`, owner inaccessible or unverified | Preserve the claim and report attention needed; do not infer that the owner died. |
| `running` or `unknown` with a known Cloud ID | Reuse normal due polling, retry schedules, leases, and the exact stored Cloud ID. |
| `unknown` without a Cloud ID | Preserve the uncertainty and require investigation. Do not match a replacement by task title or submit another job. |

Recovery does not reset a poll lease, handoff lease, rate reservation, next-poll schedule, immutable JSON fence, receipt, or attempt number. An expired poll lease can be claimed normally; a live lease remains owned by its original caller. Revision checks prevent a stale recovery read from changing a later dispatcher or operator decision.

A lost submission response cannot be recovered by inventing an identity. Inspect the original run and external evidence before explicitly recording any resolution. Do not delete fences or advance the attempt merely to clear an unknown outcome.

## Bounded polling retries and usage cooldown

The existing configuration accepts these additional fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxPollErrors` | `8` | Maximum consecutive provider polling failures before automatic polling pauses for operator attention; integer 1–1000. |
| `usageLimitBackoffMs` | `900000` | Minimum company-wide cooldown after a recognized usage/rate-limit diagnostic; integer 1000–86400000, default 15 minutes. |

Ordinary provider failures keep their bounded exponential retry schedule. Once a record reaches `maxPollErrors`, controller restart does not reset the counter. The execution and receipt remain intact, and the recovery report identifies the record as needing attention. Successful polling clears the consecutive failure count. The threshold limits read retries; it never authorizes another Cloud submission.

Usage-limit recognition is conservative and experimental. The pinned CLI fixtures contain no captured live quota failure. Synthetic tests exercise explicit machine codes such as `usage_limit_reached`, `rate_limit_exceeded`, and `insufficient_quota`, plus HTTP 429 / “too many requests” diagnostics. These strings select a longer local cooldown; they do not prove a remote execution failed or was cancelled. Unrecognized diagnostics use generic failure/backoff handling. Raw stdout, stderr, provider error bodies, and credentials are excluded from stored evidence.

A cooldown is durable and company scoped. Setting another cooldown can extend an existing provider deadline, never shorten it. Poll-resume does not clear that deadline. While the deadline is pending, the controller skips provider reads without waiting through the cooldown or consuming polling-error attempts. Paperclip notification recovery can still run. An actual recognized quota-error response counts as a provider failure before starting the cooldown. You can impose a known cooldown without relying on diagnostic parsing:

```sh
"$RECOVERY_NODE" scripts/controller-recovery.mjs --config "$RECOVERY_CONFIG" \
  --once --cooldown-ms 900000
```

Use the duration reported by the provider or an intentional operator policy. A cooldown changes when the controller may make provider requests; it does not cancel work already running in Cloud or change Paperclip status.

## Resume read-only polling after investigation

First inspect the relevant execution and its sanitized observations using the [journal CLI](execution-journal.md#local-inspection-and-cutover). After resolving the cause of repeated polling failures, resume that execution explicitly:

```sh
"$RECOVERY_NODE" scripts/controller-recovery.mjs --config "$RECOVERY_CONFIG" \
  --resume-poll "<executionId>"
```

This resets the consecutive polling-error count and makes the same known Cloud ID eligible for a later due pass. It records `OPERATOR_RESUMED_POLLING` in observations without changing execution state, revision, identity, receipts, transition history, remote timestamp watermark, fences, or attempt. It rejects a currently leased poll and executions that are terminal, unsent, or missing a known receipt. A separate controller pass performs the next read; this command itself does not submit or poll Cloud work.

Resume does not reset notification delivery. An uncertain `sending`/`unknown` handoff remains a read-reconciliation case and is never automatically resent. See [ambiguous delivery handling](cloud-reconcile.md#durable-observations-and-delivery).

## Reports and verification limits

Controller output includes `recovery` inventory/attention details and the existing `reconciliation` statistics. Recovery counts are `scanned`, `interrupted`, `waiting`, and `deferred`, plus a `needsAttention` array. Attention entries identify the execution, Paperclip issue, local state, and a stable reason; a known Cloud task ID can be included. The rotating owner-check cursor is returned as `recoveryCursor` when present. Reconciliation can include `paused` and `providerRetryAt` alongside its normal counts.

| Controller status | Meaning |
| --- | --- |
| `needs_attention` | Inventory has an attention reason or this pass has an unresolved reconciliation outcome. |
| `recovering` | Unfinished work, a pending notification, or a provider cooldown remains without a current attention reason. |
| `reconciled` | No unfinished execution, pending notification, cooldown, or reported attention remains. |

Stable attention reasons are `queued_not_submitted`, `submission_outcome_unknown`, `owner_unavailable`, `owner_scope_mismatch`, `poll_retry_limit`, and `notification_outcome_unknown`. An active owner is counted as waiting; an owner check left outside the current budget is deferred. Keep those states separate from missing identity or exhausted retries when deciding what to investigate. A completed pass is not proof that every execution was resolved.

The controller resumes existing identities rather than starting remote work. READY still means remote completion awaiting review. It does not verify acceptance criteria, retrieve unavailable final assistant output or PR metadata, or complete a Paperclip task. Human completion, cancellation, and reassignment continue to suppress notification.

Local verification uses inert provider/HTTP fixtures, disposable journals, and actual controller processes. Process-stop/restart tests can establish that the same journal identity and Cloud ID survive a local interruption without another submission. They are separate from a real Mac sleep/reboot, Paperclip service restart, full-instance restore, or physical power-loss test; those operational claims require separate evidence. Existing [live polling](evidence/issue-5-cloud-poll.md) and [review-card checks](evidence/issue-5-reconciliation.md) remain historical #5 evidence and do not establish restart recovery.

The [#6 verification record](evidence/issue-6-controller-recovery.md) documents **140/140 passing tests**, including the actual controller-process SIGKILL/restart test with an inert remote provider, explicit polling resume, and transactional retry-limit regressions. It includes commands to repeat the focused and full suites.
