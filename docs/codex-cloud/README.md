# Codex Cloud CLI compatibility spike

Issue: [#2 — Verify the experimental Codex Cloud CLI contract](https://github.com/bradywatkinson/paperclip-codex-factory/issues/2).

This spike records the installed CLI before an adapter is designed. Its captured binary is **codex-cli 0.166.0**, using **ChatGPT login**. Cloud commands identify themselves as experimental. No stable API contract is inferred from command names or a successful help command.

The adapter's current source baseline is **codex-cli 0.167.0**, selected explicitly by the maintainer during Story Keeper onboarding. The fixtures and lifecycle results below remain historical 0.166.0 evidence; they were not recaptured or relabelled as 0.167.0 results. Local adapter tests use synthetic 0.167.0 responses. A new authorized 0.167.0 Cloud lifecycle probe is still pending, and this source update does not restart the running controller or authorize dispatch.

[Versioned 0.167.0 read-only observations](fixtures/0.167.0/manifest.json) separately record its command surface, authentication mode and existing-task reads. They do not establish a new dispatch lifecycle, repair, or controller-restart result for that version.

## Evidence and current limits

[Installed-command fixtures](fixtures/installed/manifest.json) record capture time, exact argv, exit code, stdout and stderr for version, login status, Cloud help, and all five supported subcommands. All eight commands exited 0. Their stderr includes a nonfatal local warning about creating PATH aliases being denied; this was retained rather than interpreted as an authentication failure. Authentication evidence contains only the login mode, with no credentials or account identity.

The installed help is the authority for accepted flags in this release. Official OpenAI documentation supplies product context and may describe a newer release. [Pre-dispatch list evidence](fixtures/live/list-before-dispatch.manifest.json) records a successful authenticated read returning [`tasks: []` and `cursor: null`](fixtures/live/list-before-dispatch.stdout.json). [Failure fixtures](fixtures/failures/README.md) separately verify parser rejection, a nonexistent-task lookup, and a forced local process deadline. The user authorized one read-only Story Keeper probe on 2026-11-01. Its [dispatch manifest](fixtures/live/dispatch/manifest.json) records exit 0 within the caller's 60-second deadline, no retry and no credential redactions. [Stdout](fixtures/live/dispatch/stdout.txt) contains exactly one task URL plus a newline; [stderr](fixtures/live/dispatch/stderr.txt) is empty. The raw task identifier is recoverable from that observed URL path. An [initial status read](fixtures/live/task-observations/initial-status.manifest.json) returned `[PENDING]` with process exit 1; the [nonempty JSON list](fixtures/live/task-observations/initial-list.stdout.txt) independently correlated the same raw ID and `pending` state. The task later reached [READY with exit 0](fixtures/live/task-observations/terminal-status.manifest.json), independently matched by [list JSON `status: ready`](fixtures/live/task-observations/terminal-list.stdout.txt). This was observed 63 seconds after monitoring began, approximately 114 seconds after dispatch finished—not a measured 63-second task runtime. Attempt 1 had zero files/lines changed, but [diff retrieval](fixtures/live/task-observations/terminal-diff-attempt-1.manifest.json) exited 1 with empty stdout and a no-diff error. The user subsequently supplied the [final Cloud UI response verbatim](fixtures/live/user-reported-result/response.txt), including the requested marker, branch `work`, HEAD `dffa2116f78ac4fce5386f33af965e65ac365cad`, and README-heading text. This is [user-reported evidence](fixtures/live/user-reported-result/manifest.json), not CLI output or a browser scrape. The requested dispatch branch was `main`; the response reports `work`. This does not prove `main` was ignored: the base branch, commit-to-main match, and ancestry were not independently verified. The trailing `README.md` is retained verbatim and may be copied citation text; do not silently normalize the reported heading. UI changed-files/PR controls or state, remote execution failure, and Cloud timeout remain unverified.

## Compatibility matrix

| Capability | Installed 0.166.0 contract | Verification and adapter implication |
| --- | --- | --- |
| Version | `codex --version` | Observed `codex-cli 0.166.0`; historical captured baseline, distinct from the adapter's current source baseline above. |
| ChatGPT authentication | `codex login status` | Observed ChatGPT login; no logout, login reset, token extraction, or API key required by this spike. |
| Environment discovery | `codex cloud` opens an interactive terminal picker (TUI); `exec --env` requires an identifier | Help and official documentation agree. No environment-list subcommand or environment-list JSON contract is advertised. Confirm the target environment and repository before dispatch; [read-only TUI discovery](fixtures/live/environment-discovery.md) records the available option without authorizing its use. |
| Dispatch | `codex cloud exec --env ENV_ID [--branch BRANCH] [--attempts N] [QUERY]` | Help verified. Attempts default to 1; the official reference specifies 1–4. `--branch` defaults to the current branch. The authorized probe explicitly used Story Keeper environment `6a7aa92536508191bf085b59e7d6b8ba`, branch `main`, one attempt, and the canonical prompt; observed submission exit 0. |
| Machine-readable dispatch ID | `exec` does **not** advertise `--json` or a dedicated ID-output flag | Observed stdout is one URL: `https://chatgpt.com/codex/tasks/task_e_6ae76e6a06948325b7310562482caa13` plus newline. Its final path component supplies raw ID `task_e_6ae76e6a06948325b7310562482caa13`. This is an observed text contract, not a versioned JSON schema; the first nonempty JSON list independently matched its ID and URL. Validate host/path and repeat correlation before trusting a parser on another release. |
| List | `codex cloud list [--env ENV_ID] [--limit N] [--cursor CURSOR] [--json]` | Empty and nonempty JSON responses verified; limit 1–20, default 20. The task matched the dispatch ID/URL with observed states `pending` then `ready`, one attempt and zero changed files/lines. `environment_id` was null despite the explicit environment at dispatch; persist the submitted environment ID separately and do not reconstruct it from this nullable field. Cursor was null. |
| Status | `codex cloud status TASK_ID` | No advertised JSON flag. Observed `[PENDING]` returned **exit 1**, followed by `[READY]` with **exit 0**. Both include title/environment/age and `no diff`. Nonzero status exit alone does not establish remote execution failure; only these two states and exit behaviors are verified. |
| Diff | `codex cloud diff TASK_ID [--attempt N]` | Attempt is 1-based. After READY, `diff TASK_ID --attempt 1` returned **exit 1**, empty stdout and `No diff available ...; it may still be running.` That wording is not a reliable task-state test. A diff is not the assistant answer or execution log. |
| Result text/log retrieval | No `cloud result` subcommand | Unsupported by the installed command surface. Status/list/diff did not expose the answer; the user supplied its [verbatim text](fixtures/live/user-reported-result/response.txt) from the [Cloud UI](https://chatgpt.com/remote/task_e_6ae76e6a06948325b7310562482caa13). Marker and reported fields are verified from that supplied text, not via CLI or browser automation. Requested branch `main` versus reported `work` remains unexplained. |
| Local application | `codex cloud apply TASK_ID [--attempt N]` | Present, but deliberately excluded from this read-only spike because it changes the local working tree. |
| PR creation | No Cloud CLI PR command or flag | Not exposed by this installed CLI. The Cloud product supports reviewed PR creation through its UI; remote task permission to open a PR is not established by local help. No PR was requested or opened by the probing agent. Remote PR state was not inspected; zero changed files is not proof that no PR exists. |
| Follow-up/resume | No Cloud CLI follow-up or resume command | Not exposed by this installed CLI. Cloud UI continuation is documented separately. Local `codex resume` is not evidence of remote task continuation. |
| Cancel/wait/deadline | No Cloud CLI cancel, wait, or timeout option | A deliberately forced 1 ms local subprocess deadline was verified. The caller must bound its own process/wait time; terminating it does not establish remote cancellation. Cloud execution timeout and dispatch-interruption behavior remain pending. |
| Dispatch failure | Official reference says failed submission exits nonzero | Observed parser failures exit 2; nonexistent-task lookup exits 1 with HTTP 404. These do not verify remote execution failure. A successful submission exit does not establish task completion. |

The official list JSON description includes task fields `id`, `url`, `title`, `status`, `updated_at`, `environment_id`, `environment_label`, `summary`, `is_review`, and `attempt_total`. The initial nonempty response contains those fields, but nullable values remain significant: this task returned `environment_id: null`. Unknown fields, nulls and states must remain visible rather than silently coerced.

## Scope of the harmless probe

The user authorized the Story Keeper environment for this single harmless probe on 2026-11-01; the captured dispatch used one attempt and explicit branch `main`. Do not repeat that submission automatically. For future probes, use only an environment and repository authorized by the user, with one attempt and an explicit published branch. Use the exact [canonical read-only prompt](fixtures/live/probe-prompt.txt), including its `FACTORY_CLOUD_SPIKE_OK` marker; it prohibits file changes, commits, pushes, PRs, deployments, package installation, project-script execution and credential access. Merges are also outside this spike. This spike does not call `cloud apply`, attempt remote continuation, or turn local process termination into an assumed remote cancellation. No automatic retry of an ambiguous dispatch is permitted: a timed-out or interrupted submission may already have created a remote task.

The Cloud UI's ability to request follow-ups or open a PR is a product capability, not permission for this spike to exercise it. Record those operations as unverified when they were not performed. The probing agent requested no PR, but did not inspect remote PR state.

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

   Record the exact observed state and timestamps. The captured task moved from `[PENDING]`/exit 1 to `[READY]`/exit 0. Use operation-specific output and JSON list correlation, not generic nonzero-exit classification. After READY, diff attempt 1 still exited 1 with `No diff available ...; it may still be running.`; do not use that error text as a task-state signal. Do not guess a terminal state from a substring or treat an empty diff as the final answer. Inspect the result in the Cloud UI if this CLI cannot retrieve its text; record that surface explicitly. Browser automation was unavailable in this session; the user supplied [the final response](fixtures/live/user-reported-result/response.txt) and verified the [UI navigation link](https://chatgpt.com/remote/task_e_6ae76e6a06948325b7310562482caa13). Record this provenance rather than representing the answer as CLI output or a browser scrape.
6. Compare failure handling with the [recorded failure fixtures](fixtures/failures/README.md): unsupported JSON/missing environment parser errors exit 2, while a nonexistent-task status read exits 1 with HTTP 404. Preserve command, exit code and sanitized error for any additional case. Label the case precisely: parser rejection is not a remote task failure. A deliberately failing remote task needs its own authorized, harmless fixture before remote failure acceptance can pass.
7. A forced 1 ms local deadline is already [recorded](fixtures/failures/list-local-deadline/manifest.json). Apply an external caller deadline when testing a bounded wait against an actual task. Record whether the process exited, was interrupted, or exceeded the deadline. Reconcile the task using its identifier and the list before deciding to retry. A deadline observed only against a local test process does not verify Cloud cancellation or remote task timeout.
8. Verify that the local working tree is unchanged. Separately inspect remote PR/deployment state when making claims about those effects; zero diff is insufficient. This probe did not request PR creation or deployment, but remote PR state was not inspected. Save sanitized fixtures and update each acceptance row below with the actual result, limitation, and evidence path.

## Acceptance tracking

| Issue requirement | Status | Evidence needed |
| --- | --- | --- |
| Installed version and relevant help | Passed | [Command manifest](fixtures/installed/manifest.json) and associated stdout/stderr |
| Harmless authorized Cloud dispatch through ChatGPT login | Passed | User-approved Story Keeper environment, branch `main`, canonical prompt, one attempt; [dispatch exit 0](fixtures/live/dispatch/manifest.json) and task URL captured |
| Machine-readable dispatch identity and list correlation | Passed for observed contract | Raw ID recovered from URL text and matched in pending/ready list JSON; no dispatch JSON flag/versioned schema |
| Status and completed result | Passed with user-reported UI evidence | Pending/ready verified by CLI; user supplied final marker and reported fields [verbatim](fixtures/live/user-reported-result/response.txt). No CLI result retrieval or independent browser scrape; requested `main` versus reported `work` is unexplained |
| Failure and deadline behavior | Partial | Parser exit 2, invalid-ID lookup exit 1/HTTP404, and 1 ms local deadline verified in [failure fixtures](fixtures/failures/README.md); remote execution failure and Cloud timeout pending |
| PR and follow-up/resume capability boundaries | Partial | CLI absence and official UI documentation verified; no PR/continuation requested by agent, remote PR state not inspected |
| Sanitized fixtures, matrix and upgrade policy | Partial | Installed, list, failure, dispatch, pending/ready/diff and user-reported result fixtures recorded; remote execution-failure and Cloud-timeout evidence pending |

## Upgrade policy

Treat every CLI change as a new compatibility candidate because `codex cloud` is experimental. Version 0.166.0 remains the last captured lifecycle baseline; the explicitly requested source update to 0.167.0 does not establish that lifecycle evidence. Complete the same capture and authorized harmless lifecycle procedure before activating the updated controller for dispatch. Do not upgrade automatically as part of task dispatch.

For a reviewed upgrade, retain the prior fixtures, capture the new binary version and help in a separately versioned evidence directory, and compare accepted commands, flags, stream placement, JSON keys, state labels, identifiers and error/exit behavior. Repeat the authorized one-attempt probe before enabling that version for an adapter. Preserve distinct evidence for command-line parsing, transport/authentication, submission, execution failure and caller deadlines.

Fail closed on an unrecognized version, output schema or lifecycle state. Preserve sanitized diagnostic output and require contract review rather than silently changing parsers, re-dispatching a possibly created task, or scraping undocumented endpoints. Roll back the CLI only through the user's normal installation mechanism; keep versioned fixtures so the previous contract can be verified again. A CLI rollback does not undo remote tasks, PRs or other effects.

## Sources and provenance

- [Installed CLI fixtures](fixtures/installed/manifest.json): direct observations from this Mac; captured timestamps and exit codes are in the manifest.
- [Pre-dispatch list manifest](fixtures/live/list-before-dispatch.manifest.json) and [JSON response](fixtures/live/list-before-dispatch.stdout.json): authenticated empty inventory, exit 0.
- [Failure and deadline fixtures](fixtures/failures/README.md): command-level manifests and captured outputs distinguishing local parsing, remote lookup, and caller deadline behavior.
- [Canonical probe prompt](fixtures/live/probe-prompt.txt): the exact read-only instructions used by the authorized one-attempt dispatch.
- [Live dispatch manifest](fixtures/live/dispatch/manifest.json), [stdout](fixtures/live/dispatch/stdout.txt), and [stderr](fixtures/live/dispatch/stderr.txt): observed submission exit 0, single task URL, no stderr, and no automatic retry.
- [Lifecycle observations](fixtures/live/task-observations/README.md), [initial status](fixtures/live/task-observations/initial-status.manifest.json), [terminal status](fixtures/live/task-observations/terminal-status.manifest.json), [terminal list](fixtures/live/task-observations/terminal-list.manifest.json), and [attempt-1 diff](fixtures/live/task-observations/terminal-diff-attempt-1.manifest.json): pending exit 1 → ready exit 0, correlated identity, nullable environment ID and no-diff exit 1.
- [User-reported result](fixtures/live/user-reported-result/response.txt) and [provenance manifest](fixtures/live/user-reported-result/manifest.json): supplied by the user on 2026-11-01, not CLI output or a browser scrape. Use the [user-verified Cloud UI link](https://chatgpt.com/remote/task_e_6ae76e6a06948325b7310562482caa13) for navigation. The original CLI-emitted `/codex/tasks/` URL remains unchanged in raw fixtures and is evidence of CLI output, not the user-verified navigation route.
- [Polling timeline](fixtures/live/task-observations/polling.json): READY observed 63 seconds after monitoring began, approximately 114 seconds after dispatch finished; not a precise execution duration.
- [Official OpenAI developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli): Cloud maturity, dispatch options, environment picker and list JSON description. The former `developers.openai.com/codex/cli/reference/` URL redirects here.
- [Official Codex Cloud overview](https://learn.chatgpt.com/docs/cloud): UI review, follow-up and reviewed PR workflow.
- [Official Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments): published environments and reopening the same task to continue its work.

Official pages were fetched during this spike. No raw API response, token, cookie, API key, or authentication file is part of the installed fixtures. Before saving future task outputs, review them for credential-like values, private paths, repository content, and account identifiers; keep only what the contract test needs and label any redaction. Do not fabricate output to fill an unverified row.
