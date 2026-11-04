# Bounded independent review orchestration

This workflow is implemented and fixture-tested in the local factory suite. Three real role agents are provisioned and repeat-bootstrap IDs are stable, while the source dispatcher remains unchanged. A current-code controller pass is idle with no review tasks or model executions; no live #9 review/QA/repair Cloud batch is recorded. See [dated implementation and live evidence](evidence/epic-implementation-2026-11-03.md).

Review is an explicitly approved batch following a verified delivery. Inspecting delivery never starts agents. Provisioning creates separate reviewer, QA and repair process agents; it preserves the registered project, primary workspace and original implementation agent. Hire approval remains a native Paperclip requirement. Each role has an immutable private configuration, no scheduled heartbeat and one concurrent local run.

```sh
FACTORY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
"$FACTORY_NODE" scripts/factory-review.mjs bootstrap owner/repository --dry-run --json
"$FACTORY_NODE" scripts/factory-review.mjs bootstrap owner/repository --json
"$FACTORY_NODE" scripts/factory-review.mjs status owner/repository --json
```

Use the existing repository registry, with `--registry /absolute/private/directory` when nondefault. The dry-run shows role configurations and process adapters, creates no files and performs no remote operation. It uses a placeholder binding UUID; actual ownership IDs are durably allocated before agent creation. A changed role configuration or ownership marker is refused rather than silently editing an existing agent. Re-running bootstrap verifies fresh agent metadata and the separate native configuration projection.

Start with a private observation JSON and patch emitted by `factory delivery inspect`. Choose exact required CI check names that verify application tests:

```sh
"$FACTORY_NODE" scripts/factory-review.mjs start owner/repository \
  --observation /absolute/private/observation.json \
  --patch /absolute/private/patch.patch \
  --test-check 'unit-tests' --approve-dispatch --json
```

Starting requires the actual registered execution journal receipt, a succeeded implementation execution and fresh read-only Cloud/GitHub inspection. It re-verifies repository, PR, immutable base/head, complete patch and required CI. The approved batch is limited by repair and handoff ceilings (`--max-repairs 2`, `--max-handoffs 8` by default), capped by registered attempt policy. Missing test-check names prevent starting. The actual implementation task title and acceptance criteria are snapshotted into the approved activation and included verbatim as JSON data in child task payloads. Later parent text changes or human completion stop new assignments, direct role dispatch and deferred queue wakes. Role reports always remain `evidenceVerified:false`.

The `factory controller` loop reconciles approved review batches. The managed service source is implemented and its plist installed, but native bootstrap is blocked in this environment; the dated temporary bounded runner observation is separate from login-service acceptance. Standalone `factory review once owner/repository` and `loop owner/repository` run that same account controller, including registered company recovery and its existing capacity wake outbox. This can advance other previously approved batches in the account. No Cloud submission occurs directly in the controller; the authenticated role dispatcher still queues and obtains shared admission first.

Each collector pass selects at most ten pipelines across the account by default. Persisted repository and pipeline cursors rotate bounded batches; `processedPipelines` and `deferredPipelines` make the scope explicit. A stuck or paused row cannot freeze later approved work, and completed/attention job history does not consume active-job limits. Cursor CAS and native intent ledgers survive controller restart; this is local durability evidence, not physical reboot proof.

For each role, the controller inspects a real GitHub branch and creates an owned secondary workspace without changing the primary workspace. Reviewer checkout requires the immutable base still be available at the registered base branch; an advanced branch is attention, never guessed checkout provenance. Reviewer inspects the complete supplied patch against that base without applying it. QA and repair require the published same-repository PR head and its branch to match exactly. Oversized complete source prompts fail rather than truncate.

Only new assigned child tasks are created, linked to the original implementation issue. Existing tasks are never reassigned or reopened. Task payload, approved checkout and create intent are durable before the native create call. A native assignment wake arriving before the actual task ID is bound returns `binding_pending` without journaling or submitting Cloud work; a separately fenced prequeue wake handles that handoff after binding. Once queued, the account controller validates the trusted role profile and uses its existing wake journal. An interrupted local queue can be bound only from its exact real journal identity and verified native run owner.

Reviewer and QA Cloud tasks may create only `.factory/reviews/<actual-execution-UUID>.json`, plus Git intent-to-add for that one file. The controller collects the known completed task's actual `codex cloud diff --attempt 1` and accepts only a complete new evidence file with exact pipeline/job/source/role-execution/PR/base/head/patch bindings. Final response prose cannot establish review or QA completion. Missing/malformed artifacts and infrastructure reports remain attention.

A blocking review or failed QA creates a bounded repair job. The controller waits for real PR publication; the role agent cannot push or create a PR under its fixed policy. A patch produced by repair must therefore be published through the separately authorized delivery workflow. The read-only repair adapter verifies the Cloud delta against previous-head→new-head GitHub comparison and retains the complete original-base→new-head PR patch. Fresh review and QA then run for that new immutable head. At approval, the same typed delivery inspector is rerun, including actual configured test checks and required CI.

Only a native human-only confirmation with `continuationPolicy:none` is created after these gates. Its stable key is tied to the pipeline and exact head. It does not merge, deploy or update the parent task status. Human terminal statuses prevent further child creation and confirmation.

```sh
"$FACTORY_NODE" scripts/factory-review.mjs pause owner/repository --pipeline PIPELINE_UUID --json
"$FACTORY_NODE" scripts/factory-review.mjs resume owner/repository --pipeline PIPELINE_UUID --json
```

Account or pipeline pause retains observations and artifact collection, while preventing new assigned tasks and prequeue wakes. Resume restores that approved batch's scheduling permission; it does not clear ambiguous native writes, resubmit Cloud jobs or bypass budgets. Sending/unknown create intents recover only by exact owned-marker, payload, parent and actor reads. Unknown wakes never resend automatically. Status exposes the durable job and execution IDs needed for reconciliation; an unresolved ambiguous wake requires operator investigation, not a blind retry.

All provider calls are bounded and use normal CLI credential stores. No raw Board key is read, copied to configuration or emitted. Tests use inert providers, actual temporary SQLite journals, real role-dispatch integration and strict artifact parsing; they do not provision live agents, assign live tasks or submit Cloud work.
