# Paperclip → Codex Cloud dispatch bridge

Issue [#3](https://github.com/bradywatkinson/paperclip-codex-factory/issues/3) adds an external, one-shot bridge using Paperclip's supported `process` adapter. It submits an assigned task through the tested Codex Cloud CLI, records the receipt, gives the Paperclip task an explicit external-wait disposition, and exits. It does not keep a local worker running while Cloud performs the task.

The implementation is `lib/cloud-dispatch.mjs`, invoked by `scripts/cloud-dispatch.mjs`. It uses Node built-ins, including the transactional [execution journal](execution-journal.md), and changes no Paperclip core files. The reference versions are Paperclip `2026.1023.0`, Node `24.15.0`, and Codex CLI `0.166.0`. See the [Cloud compatibility matrix](codex-cloud/README.md) for the experimental CLI's observed behavior.

## Paperclip integration contract

The [official process-adapter reference](https://docs.paperclip.ing/reference/adapters/process/) describes a built-in command runner configured through the API or a company import. The UI currently labels this adapter “Coming soon.” Use an argument array: the installed adapter passes the array directly, without template expansion or a shell protocol.

This bridge uses these injected values:

- `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`: local API origin and a run-scoped agent credential.
- `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID`: the current run's scope.

The installed process adapter does **not** inject `PAPERCLIP_TASK_ID`. The bridge retrieves its own run through `GET /api/heartbeat-runs/:runId` and reads `contextSnapshot.issueId`. It checks the current agent, active run, issue assignment, company, project, repository workspace, and checkout result before submitting Cloud work. API calls use the injected bearer and matching `X-Paperclip-Run-Id` header. Credentials are never placed in command arguments or the project configuration.

The current bridge accepts only HTTP loopback API origins (`localhost`, `127.0.0.1`, or `::1`) without embedded credentials, extra paths, queries, or fragments. Redirects are rejected before a bearer can be forwarded. Remote controller access is separate work under #14.

## Trusted project configuration

Copy [the example](../examples/cloud-dispatch.project.json) into private controller storage outside application repositories, such as `~/.paperclip/instances/factory/config/cloud-dispatch-project.json`. Replace the placeholder company, project, repository, and environment values with the intended binding. Keep the file operator-controlled: it chooses the executable and Cloud target.

This JSON schema is a bridge convention. It is not a built-in Paperclip feature or the complete `.factory.yaml` format planned in #10.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `companyId`, `projectId` | Paperclip UUIDs; both must match the fetched task and project. |
| `workspaceId` | Optional UUID selecting a specific project workspace. Otherwise the primary/sole workspace or codebase binding is used. |
| `repository` | GitHub `owner/repository`, without `.git`. |
| `environmentId` | Explicit 32-character lowercase hexadecimal Cloud environment ID. It cannot be recovered reliably from Cloud list output, which may return null. |
| `branch` | Explicit requested base branch, validated as a conservative Git ref. |
| `mode` | `read_only` or `code_change`; determines the fixed dispatch policy. |
| `codexCommand` | Optional absolute executable path; defaults to the controller user's `~/.local/bin/codex`. |
| `attempt` | Optional logical attempt from 1 through 100; defaults to 1. A later attempt is explicit and requires every earlier attempt to be terminal. |
| `dispatchTimeoutMs` | Optional submission deadline, 1,000–60,000 milliseconds; defaults to 60,000. It does not cancel a Cloud task. |

The selected workspace must bind the same GitHub repository through an HTTPS GitHub URL or `git@github.com:` URL. An existing `repoRef`/`defaultRef` must match the configured branch. An arbitrary matching repository among several workspaces is not sufficient; use the primary workspace or an explicit `workspaceId`. If the task names `projectWorkspaceId`, that binding must match the selected workspace. The checkout response is checked again so a changed workspace cannot silently redirect the dispatch.

The receipt retains repository, environment, and requested branch. These describe dispatch input, not proof of the remote checkout's branch name or base ancestry. The Cloud spike reported a `work` branch despite requesting `main`.

## Agent configuration

Use a separate dispatcher agent. Configure absolute paths for the Node executable, bridge entrypoint, configuration file, and working directory. The example below targets the installed isolated Node runtime on this Mac; replace paths when installing elsewhere.

```json
{
  "name": "Factory Cloud Dispatcher Smoke",
  "role": "engineer",
  "adapterType": "process",
  "adapterConfig": {
    "command": "/Users/bradyw/.local/share/paperclip-runtime-next/node_modules/node/bin/node",
    "args": [
      "/Users/bradyw/dev/paperclip-codex-factory/scripts/cloud-dispatch.mjs",
      "--config",
      "/Users/bradyw/.paperclip/instances/factory/config/cloud-dispatch-project.json"
    ],
    "cwd": "/Users/bradyw/dev/paperclip-codex-factory",
    "timeoutSec": 180,
    "graceSec": 10
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "intervalSec": 0,
      "wakeOnDemand": true,
      "maxConcurrentRuns": 1
    }
  }
}
```

The smoke agent disables scheduled heartbeats and uses a single on-demand assigned task. Preserve any company hire-approval policy; use its approval flow if direct creation requires it. Do not repurpose the existing Chief of Staff agent.

For operator setup, use the supported Board CLI sign-in flow if needed:

```sh
./scripts/paperclip auth login --api-base http://127.0.0.1:8100 --no-browser
```

Approve the request in the normal browser flow. The CLI manages its private credential store. The dispatcher itself uses the injected run credential; it does not need a copied Board token or manually created agent key.

## Submission and handoff

The bridge performs these steps:

1. Validate context and configuration; fetch the current agent, running heartbeat, assigned issue, and project.
2. Validate a bounded prompt containing issue ID, repository, requested base branch, title, description, and acceptance criteria. Task title is limited to 500 bytes, description to 24,000 bytes, and the complete prompt to 32,000 bytes. Oversized content is rejected rather than silently truncated.
3. Check exact Codex version `0.166.0` and successful `Logged in using ChatGPT` status. The auth status may be on stderr; nonempty stderr alone is not a failure.
4. Check out the task for the current run, revalidate its scope and workspace binding, rebuild the prompt from the latest checkout title/description, then queue and atomically claim its logical execution in the journal. A durable compatibility fence precedes the claim.
5. Execute one `codex cloud exec --env … --branch … --attempts 1` with the entire prompt as one literal argument. No shell is used.
6. Accept only a single validated ChatGPT task URL as a receipt; retain the emitted URL and a `/remote/<taskId>` navigation URL separately.
7. Commit the accepted receipt in the journal, then atomically add a positive confirmation comment with the Cloud link and set the issue to `blocked` with a dispatcher-owned reconciliation action (`owner: { "agentId": "<current agent ID>" }`). The comment says the Cloud submission is confirmed and the task is waiting for result review/reconciliation. Return the receipt and exit.

`read_only` prompts prohibit changes, commits, pushes, PRs, deployment, installation, and project-script execution. `code_change` prompts request a reviewable patch and test evidence, with requested-base-branch delivery information for human review. The tested CLI does not guarantee PR creation. Both modes prohibit merges and deployments; task text is JSON-encoded and cannot replace the bridge's fixed policy.

The child environment is allowlisted. It retains the controller's normal ChatGPT auth location, executable paths, locale, proxy, and certificate settings, but strips the Paperclip API key and unrelated provider credentials. Subprocess output and API responses are bounded; errors expose stable codes rather than raw command output or response bodies.

Successful submission is **not** task completion. Leaving an issue `in_progress` after a successful process exit can trigger Paperclip's corrective heartbeat and dispatch the same work again. The explicit `blocked` disposition means “waiting for the external Cloud result and reconciliation.” It is not a report that the Cloud execution failed.

The bridge names the dispatcher agent as the structured unblock owner. In the installed Paperclip version, an agent-authenticated update cannot name the Board as owner; that request returns 403. Depending on runtime state, entering this self-owned blocked state may enqueue an `issue_unblock_requested` wake for that agent. No automatic self-wake was observed in the first live dispatch. A guarded re-invocation returns `already_dispatched` for the existing accepted receipt while the task is already blocked, without another PATCH or Cloud submission, so it does not itself create another unblock wake or dispatch loop. An operator can inspect the Cloud result and arrange a manual reconciliation/resume; structured unblock ownership remains with the dispatcher. The [#5 reconciler](cloud-reconcile.md) adds polling and human-only review-notification cards while preserving task status; operators retain the completion decision. Those cards have no continuation/addressee and do not wake the dispatcher. They avoid Board comment routes, which can implicitly reopen blocked/done tasks in the pinned release.

The local process waits only for API setup and submission, not Cloud execution. Each API request has a 10-second limit; each CLI preflight has a 10-second limit; the dispatch deadline comes from configuration. The example uses an outer process timeout of 180 seconds and a 10-second grace period to cover preflight, a 60-second submission, and bounded setup/handoff requests (approximately 150 seconds in the slow path). The previous 90-second outer budget could interrupt otherwise valid slow setup. A local deadline does not cancel already accepted Cloud work.

## Execution journal and recovery

The [execution journal](execution-journal.md), currently schema 4, is now authoritative. It lives at:

```text
~/.paperclip/instances/factory/data/cloud-dispatch/<companyId>/executions.sqlite
```

`PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` select the controller instance. Original `<issueId>.json` guards remain untouched on migration; new immutable JSON compatibility fences prevent an older writer from claiming the same issue. They are not the current status store. Use `scripts/execution-journal.mjs get` to inspect the execution, events, and run associations.

The journal keys each logical attempt by company, issue, and explicit attempt number. A repeated invocation with the same accepted record returns `already_dispatched` without another Cloud submission. For an already blocked task it makes no PATCH. A changed project/workspace/repository/environment/branch/mode mapping requires reconciliation. The receipt retains its original dispatch-run ID and now also includes the execution ID, attempt, and execution state.

An internal `running` row means accepted Cloud work, not confirmed completion. A safely queued execution can resume after fresh validation and checkout. An existing `dispatching` row is not reclaimed because a new run appeared: the bridge first verifies that its original Paperclip heartbeat is terminal. Active or unverifiable owners remain untouched. Unknown outcomes stay blocked from automatic submission; explicit later attempts require all prior attempts to be terminal.

Deadlines, signals, output overflow, nonzero submission exits, malformed receipts, and failed accepted-handoff recording retain an unknown outcome and any known Cloud ID. `SIGTERM`/`SIGINT` stops the local CLI process group and descendants; this does not cancel Cloud work. A committed intent survives an abrupt local stop and prevents a blind retry. No raw child errors, credentials, or task prompts enter journal records.

See [schema, state transitions, legacy migration, inspection, backup and cutover](execution-journal.md). Quiesce old dispatchers before migration or recovery; do not delete JSON fences or advance the attempt to bypass an unresolved submission. The [#5 reconciler](cloud-reconcile.md) polls known accepted Cloud IDs and posts review notifications without changing Paperclip task status; broader startup reconciliation remains #6.

## Journal migration verification — 2026-11-02

The [additive migration observation](evidence/issue-4-execution-journal/live-migration.json) verifies import of PAP-2's original accepted guard with the sole process dispatcher paused. The initial schema-2 and integrity checks passed; original, backup, and post-import guard hashes matched. The same Cloud ID and original Paperclip run were retained, and repeat import preserved execution ID, revision 0, and one event. This migration submitted no Cloud work and changed no Paperclip task state.

The imported journal state is `running` because the legacy guard proves acceptance only. It does not infer completion from PAP-2's manual closeout. Final schema-3 validation passed **63 reference-runtime tests**, including migration and crash-window tests. The [separate live schema upgrade](evidence/issue-4-execution-journal/schema-upgrade.json), performed after a stopped journal-directory backup, preserved the execution ID, receipt, original creation/dispatch times, revision, event count, and original guard bytes. It corrected import-audit timestamps to the recorded import observation time; it did not claim a new Cloud acceptance or change Paperclip task state. Full Mac-reboot and physical power-loss recovery remain untested. See [journal operations and verification](execution-journal.md).

## Observed live verification — 2026-11-02

The first live Paperclip-to-Cloud dispatch was observed with a separate read-only test task, **PAP-2** (`688630d3-a281-45ab-8707-37e5f3731663`). Paperclip run `3984a3d7-b366-4dec-bd54-146a185f1b26` succeeded in **18.688 seconds**; the recorded Cloud submission took **4.82 seconds**. The task remained `blocked`, with the dispatcher agent as structured unblock owner and one receipt comment.

The receipt points to [the Cloud task](https://chatgpt.com/remote/task_e_6ae8be3af9888325b7e16a152a0843a8). Subsequent CLI observation reported READY, one attempt, and zero file/line changes. The local worker had already exited after dispatch rather than waiting for that remote completion. **28 local tests passed.**

An explicit second local wake, run `d7390bf3-07c1-45aa-b4fa-64c9f2ab52e4`, succeeded with exit 0 in **2.669 seconds**. Its captured stdout returned `already_dispatched`, the same Cloud ID, and the original dispatch run ID. The guard stayed unchanged and there was no new receipt comment/PATCH or Cloud submission. This verifies guard reuse across run IDs; it was an explicit test wake, not an observed automatic self-wake.

A [user-supplied Cloud UI screenshot](evidence/issue-3-cloud-dispatch/cloud-result-user.png) then reported `FACTORY_CLOUD_ADAPTER_OK`, checked-out branch `work`, HEAD `20145a418c4ce2034b301253df8927ec266ace9c`, the Story Keeper README heading, and read-only operation. Its [transcribed provenance](evidence/issue-3-cloud-dispatch/cloud-result-user.json) identifies this as human-supplied visual evidence, not automated final-response retrieval or proof of requested-base ancestry.

After that human review, a Board operator manually completed PAP-2. The [closeout observation](evidence/issue-3-cloud-dispatch/manual-closeout.json) at `2026-11-02T16:54:47Z` records `status: done` and a null unblock descriptor. The earlier blocked snapshot remains intact in the evidence. This completion was a manual decision based on the reported Cloud result and predates the #5 polling/notification implementation. It does not verify that later reconciler.

See [the live evidence record](evidence/issue-3-cloud-dispatch/README.md) and [the sanitized Paperclip observations](evidence/issue-3-cloud-dispatch/paperclip-live.json). These verify dispatch, external-wait handoff, guarded re-invocation, user-reported output, and manual closeout. Base ancestry, PR delivery, remote failure/timeouts, and automated reconciliation remain unverified. No automatic self-wake was observed.

## Verification procedure

Run local checks with the supported Node runtime:

```sh
node --check lib/cloud-dispatch.mjs
node --check scripts/cloud-dispatch.mjs
node --test tests/cloud-dispatch.test.mjs
```

The tests use temporary state, fixture HTTP APIs and inert executables. They cover literal arguments, injection boundaries, strict scope/repository validation, credential separation, redirects, deadlines/output limits, malformed receipts, and duplicate/ambiguous submission guards. They do not submit real Cloud tasks.

For an authorized live smoke test:

1. Create a disposable Paperclip project bound to the authorized GitHub repository and Cloud environment. Populate its primary workspace and matching private configuration.
2. Create a separate `process` dispatcher agent with scheduled heartbeats disabled and no other assigned work.
3. Assign one disposable `todo` task with explicit read-only acceptance criteria. Assignment may enqueue its run; inspect the run before adding a separate manual wakeup.
4. Confirm the process uses its injected run ID to recover that task, submits exactly one Cloud job, returns a receipt promptly, and leaves the Paperclip task `blocked` with the Cloud link and dispatcher-owned reconciliation action.
5. Inspect the journal record and run associations for the issue/run mapping, attempt, state, configured environment and branch, Cloud ID, emitted URL, and navigation URL. After the first run has finished, observe any conditional `issue_unblock_requested` wake or request one explicit local wake. Verify guard reuse without another PATCH or Cloud submission, distinguishing a captured return value from inference based on run/receipt metadata.
6. Observe Cloud completion separately. Keep final response content, base ancestry, PR delivery, failure behavior, and any unavailable result fields explicitly unverified until there is corresponding evidence.

Capture sanitized command results and run/task IDs; exclude credentials and the sign-in approval URL. Keep each observed live result in the separate evidence record, with its provenance and unresolved checks. The observed smoke test predates the journal and does not establish journal cutover, full restart recovery, or the later reconciler behavior.

`read_only` is a prompt policy for the Cloud task, not an additional filesystem permission boundary enforced by this bridge. The disposable smoke agent is paused after verification; its completed task and receipts remain available for inspection.
