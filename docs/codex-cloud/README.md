# Codex Cloud CLI compatibility spike

Issue: [#2 — Verify the experimental Codex Cloud CLI contract](https://github.com/bradywatkinson/paperclip-codex-factory/issues/2).

This spike records the installed CLI before an adapter is designed. The tested local binary is **codex-cli 0.166.0**, using **ChatGPT login**. Cloud commands identify themselves as experimental. No stable API contract is inferred from command names or a successful help command.

## Evidence and current limits

[Installed-command fixtures](fixtures/installed/manifest.json) record capture time, exact argv, exit code, stdout and stderr for version, login status, Cloud help, and all five supported subcommands. All eight commands exited 0. Their stderr includes a nonfatal local warning about creating PATH aliases being denied; this was retained rather than interpreted as an authentication failure. Authentication evidence contains only the login mode, with no credentials or account identity.

The installed help is the authority for accepted flags in this release. Official OpenAI documentation supplies product context and may describe a newer release. [Pre-dispatch list evidence](fixtures/live/list-before-dispatch.manifest.json) records a successful authenticated read returning [`tasks: []` and `cursor: null`](fixtures/live/list-before-dispatch.stdout.json). [Failure fixtures](fixtures/failures/README.md) separately verify parser rejection, a nonexistent-task lookup, and a forced local process deadline. Live task dispatch and its returned identifier, lifecycle states, result content, remote execution failure, and Cloud timeout behavior remain **pending** until separately captured. Successful login status is not proof that a task can run in a particular environment.

## Compatibility matrix

| Capability | Installed 0.166.0 contract | Verification and adapter implication |
| --- | --- | --- |
| Version | `codex --version` | Observed `codex-cli 0.166.0`; pin this exact compatibility baseline. |
| ChatGPT authentication | `codex login status` | Observed ChatGPT login; no logout, login reset, token extraction, or API key required by this spike. |
| Environment discovery | `codex cloud` opens an interactive terminal picker (TUI); `exec --env` requires an identifier | Help and official documentation agree. No environment-list subcommand or environment-list JSON contract is advertised. Confirm the target environment and repository before dispatch; [read-only TUI discovery](fixtures/live/environment-discovery.md) records the available option without authorizing its use. |
| Dispatch | `codex cloud exec --env ENV_ID [--branch BRANCH] [--attempts N] [QUERY]` | Help verified. Attempts default to 1; the official reference specifies 1–4. `--branch` defaults to the current branch, so this spike passes a known published branch explicitly. Live submission pending. |
| Machine-readable dispatch ID | `exec` does **not** advertise `--json` or a dedicated ID-output flag | Unverified gap. Capture successful stdout before deciding whether an ID can be extracted safely; do not assume JSON or a particular URL shape. |
| List | `codex cloud list [--env ENV_ID] [--limit N] [--cursor CURSOR] [--json]` | Help and a live empty-list response verified; limit 1–20, default 20. Only this Cloud subcommand advertises JSON. Observed `tasks: []` and `cursor: null`; actual nonempty task fields remain unverified. |
| Status | `codex cloud status TASK_ID` | Help verified, no advertised JSON flag. Lifecycle labels, terminal states and failure exit semantics require live fixtures. |
| Diff | `codex cloud diff TASK_ID [--attempt N]` | Help verified; attempt is 1-based. Intended output is unified diff. A diff is not the complete natural-language result or execution log. Live behavior pending. |
| Result text/log retrieval | No `cloud result` subcommand | Unsupported by the installed command surface. Do not invent a result endpoint or interpret an empty diff as proof of success. |
| Local application | `codex cloud apply TASK_ID [--attempt N]` | Present, but deliberately excluded from this read-only spike because it changes the local working tree. |
| PR creation | No Cloud CLI PR command or flag | Not exposed by this installed CLI. The Cloud product supports reviewed PR creation through its UI; remote task permission to open a PR is not established by local help. No PR will be opened in this spike. |
| Follow-up/resume | No Cloud CLI follow-up or resume command | Not exposed by this installed CLI. Cloud UI continuation is documented separately. Local `codex resume` is not evidence of remote task continuation. |
| Cancel/wait/deadline | No Cloud CLI cancel, wait, or timeout option | A deliberately forced 1 ms local subprocess deadline was verified. The caller must bound its own process/wait time; terminating it does not establish remote cancellation. Cloud execution timeout and dispatch-interruption behavior remain pending. |
| Dispatch failure | Official reference says failed submission exits nonzero | Observed parser failures exit 2; nonexistent-task lookup exits 1 with HTTP 404. These do not verify remote execution failure. A successful submission exit does not establish task completion. |

The official list JSON description includes task fields `id`, `url`, `title`, `status`, `updated_at`, `environment_id`, `environment_label`, `summary`, `is_review`, and `attempt_total`. These are documentation-derived expectations until a nonempty response from this installed release confirms them. Unknown fields and states must remain visible rather than silently coerced.

## Scope of the harmless probe

Use only an environment and repository authorized by the user, with one attempt and an explicit published branch. Use the exact [canonical read-only prompt](fixtures/live/probe-prompt.txt), including its `FACTORY_CLOUD_SPIKE_OK` marker; it prohibits file changes, commits, pushes, PRs, deployments, package installation, project-script execution and credential access. Merges are also outside this spike. This spike does not call `cloud apply`, attempt remote continuation, or turn local process termination into an assumed remote cancellation. No automatic retry of an ambiguous dispatch is permitted: a timed-out or interrupted submission may already have created a remote task.

The Cloud UI's ability to request follow-ups or open a PR is a product capability, not permission for this spike to exercise it. Record those operations as unverified when they were not performed.

## Repeatable verification procedure

1. Check the working tree and record the repository commit. Run `codex --version`, `codex login status`, `codex cloud --help`, and each subcommand's help. Compare with the installed fixtures before executing a saved command. Do not read authentication files or print environment credentials.
2. Discover the environment using the supported interactive terminal `codex cloud` picker (TUI). Confirm the exact repository, environment identifier, and published branch with the user when authorization is ambiguous. Do not substitute an unrelated environment just because it is available.
3. Capture a read-only baseline list. The existing [baseline manifest](fixtures/live/list-before-dispatch.manifest.json) and [empty JSON response](fixtures/live/list-before-dispatch.stdout.json) already verify this read-only operation:

   ```sh
   codex cloud list --json --limit 20
   ```

4. After the environment and branch are confirmed, submit one bounded read-only task using the saved canonical prompt as a single argument. Replace the quoted identifiers with approved values; do not rewrite the prompt or its marker:

   ```sh
   codex cloud exec --env '<authorized-environment-id>' --branch '<published-branch>' --attempts 1 "$(cat docs/codex-cloud/fixtures/live/probe-prompt.txt)"
   ```

   Capture stdout, stderr, exit code and elapsed time separately. Stop if the command or help differs from the recorded contract. Never add an assumed `--json`, `--wait`, or `--timeout` option.
5. Use the returned task identifier only after inspecting the actual output. Confirm it appears in the environment-filtered JSON list, then capture status and diff at known lifecycle points:

   ```sh
   codex cloud list --env '<authorized-environment-id>' --json --limit 20
   codex cloud status '<observed-task-id>'
   codex cloud diff '<observed-task-id>'
   ```

   Record the exact observed state and timestamps. Do not guess a terminal state from a substring or treat an empty diff as the final answer. Inspect the result in the Cloud UI if this CLI cannot retrieve its text; record that surface explicitly.
6. Compare failure handling with the [recorded failure fixtures](fixtures/failures/README.md): unsupported JSON/missing environment parser errors exit 2, while a nonexistent-task status read exits 1 with HTTP 404. Preserve command, exit code and sanitized error for any additional case. Label the case precisely: parser rejection is not a remote task failure. A deliberately failing remote task needs its own authorized, harmless fixture before remote failure acceptance can pass.
7. A forced 1 ms local deadline is already [recorded](fixtures/failures/list-local-deadline/manifest.json). Apply an external caller deadline when testing a bounded wait against an actual task. Record whether the process exited, was interrupted, or exceeded the deadline. Reconcile the task using its identifier and the list before deciding to retry. A deadline observed only against a local test process does not verify Cloud cancellation or remote task timeout.
8. Verify that the local working tree is unchanged and the probe did not create a PR or deploy anything. Save sanitized fixtures and update each acceptance row below with the actual result, limitation, and evidence path.

## Acceptance tracking

| Issue requirement | Status | Evidence needed |
| --- | --- | --- |
| Installed version and relevant help | Passed | [Command manifest](fixtures/installed/manifest.json) and associated stdout/stderr |
| Harmless authorized Cloud dispatch through ChatGPT login | Pending | Approved target, prompt, submission output and actual remote task |
| Machine-readable dispatch identity and list correlation | Partial | Empty `tasks`/null `cursor` JSON observed; dispatch ID/output and nonempty correlation pending |
| Status and completed result | Pending | Lifecycle fixture and result content, with CLI/UI surface identified |
| Failure and deadline behavior | Partial | Parser exit 2, invalid-ID lookup exit 1/HTTP404, and 1 ms local deadline verified in [failure fixtures](fixtures/failures/README.md); remote execution failure and Cloud timeout pending |
| PR and follow-up/resume capability boundaries | Partial | CLI absence and official UI documentation verified; no live PR or continuation attempted |
| Sanitized fixtures, matrix and upgrade policy | Partial | Installed, empty-list and failure fixtures plus matrix/policy recorded; dispatch lifecycle evidence pending |

## Upgrade policy

Treat every CLI change as a new compatibility candidate because `codex cloud` is experimental. Keep 0.166.0 as the last recorded local baseline until the replacement passes the same capture and harmless lifecycle procedure. Do not upgrade automatically as part of task dispatch.

For a reviewed upgrade, retain the prior fixtures, capture the new binary version and help in a separately versioned evidence directory, and compare accepted commands, flags, stream placement, JSON keys, state labels, identifiers and error/exit behavior. Repeat the authorized one-attempt probe before enabling that version for an adapter. Preserve distinct evidence for command-line parsing, transport/authentication, submission, execution failure and caller deadlines.

Fail closed on an unrecognized version, output schema or lifecycle state. Preserve sanitized diagnostic output and require contract review rather than silently changing parsers, re-dispatching a possibly created task, or scraping undocumented endpoints. Roll back the CLI only through the user's normal installation mechanism; keep versioned fixtures so the previous contract can be verified again. A CLI rollback does not undo remote tasks, PRs or other effects.

## Sources and provenance

- [Installed CLI fixtures](fixtures/installed/manifest.json): direct observations from this Mac; captured timestamps and exit codes are in the manifest.
- [Pre-dispatch list manifest](fixtures/live/list-before-dispatch.manifest.json) and [JSON response](fixtures/live/list-before-dispatch.stdout.json): authenticated empty inventory, exit 0.
- [Failure and deadline fixtures](fixtures/failures/README.md): command-level manifests and captured outputs distinguishing local parsing, remote lookup, and caller deadline behavior.
- [Canonical probe prompt](fixtures/live/probe-prompt.txt): the exact prospective dispatch instructions; its existence is not evidence that a task was submitted.
- [Official OpenAI developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli): Cloud maturity, dispatch options, environment picker and list JSON description. The former `developers.openai.com/codex/cli/reference/` URL redirects here.
- [Official Codex Cloud overview](https://learn.chatgpt.com/docs/cloud): UI review, follow-up and reviewed PR workflow.
- [Official Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments): published environments and reopening the same task to continue its work.

Official pages were fetched during this spike. No raw API response, token, cookie, API key, or authentication file is part of the installed fixtures. Before saving future task outputs, review them for credential-like values, private paths, repository content, and account identifiers; keep only what the contract test needs and label any redaction. Do not fabricate output to fill an unverified row.
