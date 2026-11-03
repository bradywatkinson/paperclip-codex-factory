# Issue #7 Cloud execution demo evidence

## Read-only preflight — 2026-11-03

Observed from branch `issue-7-cloud-execution-demo`, based on merged commit `ffa22371a233e60be8b69fd2a51eee1869a8a5f3` (PR #20). These checks did not submit a Cloud task, change Paperclip state, or restart a service.

| Check | Observed result |
| --- | --- |
| Node runtime | `24.15.0`, using the isolated absolute runtime path documented in the operations guide. |
| Paperclip CLI | `2026.1023.0`. |
| Codex CLI | `0.166.0`. It also emitted a nonfatal warning that PATH aliases could not be created in this session. |
| Loopback health | `GET http://127.0.0.1:8100/api/health` returned `status: ok`, authenticated deployment mode, private exposure, and bootstrap ready. |
| Local service | `service status --instance factory --json` reported the LaunchAgent installed, active, enabled, and healthy. |
| Paperclip CLI authentication | Supported project, agent-configuration, issue-list, and live-run reads succeeded using the normal saved CLI sign-in. Credentials were not read manually or copied. |
| Codex authentication | `codex login status` returned `Logged in using ChatGPT`. This is an authentication-status observation, not a new coding execution. |
| Cloud environment access | `codex cloud list --env 6a7aa92536508191bf085b59e7d6b8ba --limit 1 --json` succeeded and returned a task labeled `bradywatkinson/story-keeper`. Its `environment_id` was null, consistent with the recorded CLI contract. |
| Project binding | Project `a7fb8b31-92a3-4739-98bb-3293bf3a0cf4` and primary workspace `0809b177-68a3-416a-9453-bbd69087e14a` still identify `bradywatkinson/story-keeper` with requested/default ref `main`. |
| Existing smoke dispatcher | Agent `8dbe3519-3064-4038-a913-682b95b02ce3` was paused. Its process adapter uses Node `24.15.0`, the repository dispatch entrypoint, and private `cloud-dispatch-projects/issue3-smoke.json`. That configuration remains `read_only`; scheduled heartbeats are disabled and concurrency is 1. Preserve this setup when preparing a separate coding demo. |
| Local active work | Company `run live` returned an empty array. This is a point-in-time observation. |
| Recovery configuration | The documented private `config/cloud-reconcile.json` did not exist. A demo must provide an appropriate private recovery configuration before using the controller. |

## Pending live verification

No new #7 task has been submitted. This preflight provides no new coding patch, acceptance-test result, live controller-interruption proof, UI inspection, or PR-delivery evidence. Existing fixture tests and earlier read-only Cloud tasks do not satisfy those checks for this demo.

The documentation slice does not close [issue #7](https://github.com/bradywatkinson/paperclip-codex-factory/issues/7). A separately authorized coding task must still demonstrate the end-to-end lifecycle, auditable output, recovery of the same Cloud identity after local interruption, and the documented PR or patch fallback.
