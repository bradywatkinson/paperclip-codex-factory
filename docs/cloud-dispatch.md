# Paperclip → Codex Cloud dispatch bridge

Issue [#3](https://github.com/bradywatkinson/paperclip-codex-factory/issues/3) adds an external, one-shot bridge using Paperclip's supported `process` adapter. It submits an assigned task through the tested Codex Cloud CLI, records the receipt, gives the Paperclip task an explicit external-wait disposition, and exits. It does not keep a local worker running while Cloud performs the task.

The implementation is `lib/cloud-dispatch.mjs`, invoked by `scripts/cloud-dispatch.mjs`. It uses Node built-ins and changes no Paperclip core files. The reference versions are Paperclip `2026.1023.0`, Node `24.15.0`, and Codex CLI `0.166.0`. See the [Cloud compatibility matrix](codex-cloud/README.md) for the experimental CLI's observed behavior.

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
| `dispatchTimeoutMs` | Optional submission deadline, 1,000–60,000 milliseconds; defaults to 60,000. It does not cancel a Cloud task. |

The selected workspace must bind the same GitHub repository through an HTTPS GitHub URL or `git@github.com:` URL. An existing `repoRef`/`defaultRef` must match the configured branch. An arbitrary matching repository among several workspaces is not sufficient; use the primary workspace or an explicit `workspaceId`.

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
    "timeoutSec": 90,
    "graceSec": 5
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
2. Build a bounded prompt containing issue ID, repository, requested base branch, title, description, and acceptance criteria. Task title is limited to 500 bytes, description to 24,000 bytes, and the complete prompt to 32,000 bytes. Oversized content is rejected rather than silently truncated.
3. Check exact Codex version `0.166.0` and successful `Logged in using ChatGPT` status. The auth status may be on stderr; nonempty stderr alone is not a failure.
4. Check out the task for the current run and create an exclusive issue-scoped dispatch guard.
5. Execute one `codex cloud exec --env … --branch … --attempts 1` with the entire prompt as one literal argument. No shell is used.
6. Accept only a single validated ChatGPT task URL as a receipt; retain the emitted URL and a `/remote/<taskId>` navigation URL separately.
7. Save the receipt, then atomically add a Paperclip comment and set the issue to `blocked` with a Board-owned reconciliation action. Return the receipt and exit.

`read_only` prompts prohibit changes, commits, pushes, PRs, deployment, installation, and project-script execution. `code_change` prompts request a reviewable patch and test evidence, with requested-base-branch delivery information for human review. The tested CLI does not guarantee PR creation. Both modes prohibit merges and deployments; task text is JSON-encoded and cannot replace the bridge's fixed policy.

The child environment is allowlisted. It retains the controller's normal ChatGPT auth location, executable paths, locale, proxy, and certificate settings, but strips the Paperclip API key and unrelated provider credentials. Subprocess output and API responses are bounded; errors expose stable codes rather than raw command output or response bodies.

Successful submission is **not** task completion. Leaving an issue `in_progress` after a successful process exit can trigger Paperclip's corrective heartbeat and dispatch the same work again. The explicit `blocked` disposition means “waiting for the external Cloud result and reconciliation.” It is not a report that the Cloud execution failed. Cloud polling, task completion, and automatic reconciliation belong to #5.

The local process waits only for API setup and submission, not Cloud execution. Each API request has a 10-second limit; each CLI preflight has a 10-second limit; the dispatch deadline comes from configuration. Ensure the process-adapter timeout covers the intended submission budget. A local deadline does not cancel already accepted Cloud work.

## Dispatch guard and recovery

The default guard path is:

```text
~/.paperclip/instances/factory/data/cloud-dispatch/<companyId>/<issueId>.json
```

`PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` select the controller instance. The bridge creates private directories and a mode-0600 intent before submission, then records the accepted receipt. The key is the issue, so another heartbeat/run ID cannot bypass it.

A repeated invocation with the same dispatched record returns `already_dispatched` without a second Cloud submission. A changed project/workspace/repository/environment/branch/mode mapping requires reconciliation. Existing blocked issues are not repeatedly commented merely to acknowledge the same receipt.

Timeouts, signals, output overflow, nonzero submission exits, malformed receipts, and failures recording the accepted handoff become `unknown`. Any known Cloud task ID is retained. The guard remains sticky, and the bridge makes no automatic retry. If the Paperclip update itself fails, the local intent/receipt still prevents redispatch.

Reconcile the guard and Cloud task inventory manually before any recovery. Do not remove a guard simply to force another submission. This is a minimal issue-level guard, not the complete durable execution journal, migration system, or restart reconciliation planned in #4 and #6.

## Verification

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
4. Confirm the process uses its injected run ID to recover that task, submits exactly one Cloud job, returns a receipt promptly, and leaves the Paperclip task `blocked` with the Cloud link and reconciliation action.
5. Confirm the guard contains the issue/run mapping, configured environment and branch, Cloud ID, emitted URL, and navigation URL. Verify a repeat invocation cannot submit another job.
6. Observe Cloud completion separately. Keep final response content, base ancestry, PR delivery, failure behavior, and any unavailable result fields explicitly unverified until there is corresponding evidence.

Capture sanitized command results and run/task IDs; exclude credentials and the sign-in approval URL. Live verification evidence is recorded separately after the test. This guide does not assert that the live Paperclip-to-Cloud smoke test has passed.
