# Single-repository Cloud delivery demo

Issue [#7](https://github.com/bradywatkinson/paperclip-codex-factory/issues/7) needs live evidence of a Paperclip task producing a reviewed coding result after a local interruption. The proposed coding slice fixes Story Keeper [#3465](https://github.com/bradywatkinson/story-keeper/issues/3465): reserve the `all` slug for new lists and add focused tests. No production rows or legacy URLs are changed. The earlier documentation-only prompt is retained as an unused tracer example; it is not the planned #7 submission.

This is a procedure, not a successful live verification record. The new Cloud submission, interruption, patch retrieval, and result review remain pending until separately recorded. Historical fixture tests and earlier read-only Cloud probes do not satisfy these checks.

## Prepare one approved task

Confirm the target repository, Cloud environment, requested published branch, full immutable base SHA, and exact task with the operator before submission. Previous authorization for a read-only probe does not authorize this change. Record the approved branch's SHA through GitHub or a trusted checkout at approval time; do not compare the eventual result only with a moving branch tip.

Use the existing [process dispatcher setup](cloud-dispatch.md#agent-configuration), with a separate private project configuration selecting `mode: "code_change"`, `attempt: 1`, and the approved repository/environment/branch/workspace binding. Configure absolute paths to the supported Node runtime and current factory scripts. Keep scheduled heartbeats disabled and concurrency at one. Preserve hire approvals. Do not alter the old read-only agent's configuration or task receipts.

Use the same company journal for dispatch and the [recovery controller](controller-recovery.md). There is no assumed preexisting controller config: copy [the reconciliation example](../examples/cloud-reconcile.json) to private controller storage and replace its company UUID, absolute `stateDir`, and executable paths. Keep configuration outside application repositories and credentials in the CLIs' normal private stores. Follow the journal backup procedure before opening an older journal.

Copy [the coding task](../examples/single-repository-coding-task.md) to a private task file and replace `<EXPECTED_BASE_SHA>` with the approved full SHA. Inspect the final file before assignment. The remote task stops on a base mismatch, dirty checkout, or an already-fixed defect; it does not choose a replacement base or manufacture a change.

Set these placeholders in a normal shell, from the factory repository root:

```sh
DEMO_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
DEMO_CODEX="$HOME/.local/bin/codex"
DEMO_COMPANY='<company UUID>'
DEMO_PROJECT='<project UUID>'
DEMO_AGENT='<dedicated configured dispatcher UUID>'
DEMO_ENVIRONMENT='<approved 32-character Cloud environment ID>'
DEMO_STATE="$HOME/.paperclip/instances/factory/data/cloud-dispatch/$DEMO_COMPANY"
DEMO_CONFIG='<absolute private reconciliation configuration path>'
DEMO_TASK='<absolute private task file with approved base SHA>'
DEMO_EVIDENCE='<absolute private evidence directory>'
mkdir -p "$DEMO_EVIDENCE"

"$DEMO_NODE" --version
"$DEMO_CODEX" --version
"$DEMO_CODEX" login status
./scripts/paperclip service status --instance factory --json
```

Reference versions are Node 24.15.0, Codex CLI 0.167.0, and Paperclip 2026.1023.0. Resolve a version mismatch before dispatch; do not upgrade or adapt the contract silently. If Board authentication is needed, use the normal [CLI sign-in flow](cloud-reconcile.md#configuration-and-sign-in), without reading or copying credentials. Do not publish login approval URLs or raw service/agent output without inspection.

## Dispatch once and retain the receipt

Only after the concrete remote task is approved, create one assigned task:

```sh
./scripts/paperclip issue create --company-id "$DEMO_COMPANY" \
  --project-id "$DEMO_PROJECT" --standalone \
  --title 'Factory Cloud coding demo: reserve the All list slug' \
  --description "$(cat "$DEMO_TASK")" --status todo \
  --assignee-agent-id "$DEMO_AGENT" \
  --api-base http://127.0.0.1:8100 --json
```

Assignment can immediately start the process dispatcher. Capture the returned issue UUID as `DEMO_ISSUE`, then inspect its runs rather than issuing another wake. Do not recreate the task or invoke `codex cloud exec` directly if submission seems slow or fails ambiguously. Investigate the original execution; preserve its attempt and immutable fence.

```sh
DEMO_ISSUE='<returned issue UUID>'
./scripts/paperclip issue get "$DEMO_ISSUE" \
  --api-base http://127.0.0.1:8100 --json
./scripts/paperclip issue runs "$DEMO_ISSUE" \
  --api-base http://127.0.0.1:8100 --json
"$DEMO_NODE" scripts/execution-journal.mjs get \
  --state-dir "$DEMO_STATE" --company-id "$DEMO_COMPANY" \
  --issue-id "$DEMO_ISSUE" --attempt 1 \
  > "$DEMO_EVIDENCE/journal-before-interruption.json"
```

Retain the original run's sanitized bridge receipt, execution ID, run ID, Cloud ID, emitted/navigation URLs, repository/environment/requested branch, attempt, and creation/acceptance timestamps. The journal contains these receipt fields; no raw run logs or injected environment is needed. Confirm the local dispatch run has exited and Paperclip is `blocked` awaiting external review. Successful submission is not task completion.

## Interrupt observation and resume the same identity

Run the controller in the foreground:

```sh
"$DEMO_NODE" scripts/controller-recovery.mjs --config "$DEMO_CONFIG" --loop
```

In a second terminal, inspect the journal using the command above. Require a recorded `pending` Cloud observation for this exact execution **before** stopping the controller with Control-C. Record UTC stop/start times and the observed Cloud `updated_at` timestamp. Leave Cloud running, preserve the journal, and keep the controller stopped long enough for remote work to continue. Do not stop Paperclip, delete state, reset leases, or advance attempts.

Restart the same controller command and capture the later journal:

```sh
"$DEMO_NODE" scripts/execution-journal.mjs get \
  --state-dir "$DEMO_STATE" --company-id "$DEMO_COMPANY" \
  --issue-id "$DEMO_ISSUE" --attempt 1 \
  > "$DEMO_EVIDENCE/journal-after-restart.json"
```

Check that the execution ID, original dispatch run, Cloud ID, attempt, and receipt match the pre-stop record. Require READY reconciliation and one delivered review card without a second submission. Independently inspect task runs and Cloud list evidence for duplicate submissions; unchanged journal identity alone is not a count of all provider jobs. If no PENDING observation was captured before stopping, mark the interruption experiment inconclusive rather than infer it passed.

This procedure establishes a local controller-process interruption only. Mac sleep, logout, reboot, physical power loss, and Paperclip service restart need separate operational evidence. An inaccessible provider or exhausted polling budget remains an attention state; use [documented recovery](controller-recovery.md) instead of submitting another job.

## Retrieve and review the output

Copy the exact Cloud ID from the accepted receipt:

```sh
DEMO_CLOUD_TASK='<accepted task_e_ ID>'
"$DEMO_CODEX" cloud list --env "$DEMO_ENVIRONMENT" --limit 20 --json \
  > "$DEMO_EVIDENCE/cloud-list.json"
"$DEMO_CODEX" cloud diff "$DEMO_CLOUD_TASK" --attempt 1 \
  > "$DEMO_EVIDENCE/cloud.patch"
```

Record each command's exit code and inspect output before publication. Match exact task IDs and sanitized timestamps; do not match by title. A missing item may be outside this page and is not proof of failure. The pinned CLI's empty-diff error does not prove the task is still running. Review the patch without applying it, and verify that it changes only the two approved files with the requested behavior and regression coverage. Do not run `cloud apply` in the working checkout.

Open the receipt's `https://chatgpt.com/remote/<taskId>` navigation URL manually. Capture the final response, initial/final commit, changed-file list, focused check output, and PR indicators with provenance labeled user UI evidence. Independently compare the reported initial commit with the approved immutable SHA. The factory cannot retrieve final assistant output or PR metadata through the pinned CLI. A `work` branch label does not verify base ancestry.

There is no CLI PR-creation command. This coding task requests no push or PR; its documented fallback is the retrieved patch, Cloud task link, verified base identity, and captured test evidence. PR publication remains a separate approved step. Require a nonzero executed test count from the focused collection suite; the wrapper's zero-exit behavior with no matching tests is insufficient. This does not verify the full application suite.

READY means remote completion requiring review. Resolving the review card does not complete the Paperclip task. Preserve human task status and make any completion decision explicitly after reviewing evidence.

Publish a sanitized evidence record linking the Paperclip issue/run, original receipt, before/after journal identities and observations, stop/start interval, Cloud task, patch hash, reviewed changed paths, test outcomes, and unresolved checks. Distinguish CLI observations, journal records, and user-supplied UI evidence. Mark #7 complete only after its entire live lifecycle and interruption criteria have been verified.
