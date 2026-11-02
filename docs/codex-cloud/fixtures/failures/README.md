# Failure and local-deadline fixtures

Captured against installed `codex-cli 0.166.0`. Every case records exact argv, exit/deadline metadata, stdout and stderr. IDs and prompts used here are synthetic. No task was submitted, resumed, cancelled, applied, or published by these probes.

| Fixture | Observation | Scope |
| --- | --- | --- |
| `exec-unsupported-json` | Exit 2; `--json` is rejected | Local argument parsing, before dispatch |
| `status-unsupported-json` | Exit 2; `--json` is rejected | Local argument parsing |
| `exec-missing-environment` | Exit 2; `--env` is required | Local argument parsing, before dispatch |
| `status-invalid-task-id` | Exit 1; read-only details GET returns HTTP 404, body says invalid task ID | Remote lookup failure; not a failed Cloud execution |
| `list-local-deadline` | Local subprocess exceeded a deliberately forced 1 ms deadline; no exit code or captured output | Client-process deadline only; no remote task was cancelled |

The Python subprocess wrapper kills and waits for the local process on deadline. That does not establish a Cloud task timeout, server-side cancellation, dispatch idempotency, or whether a task continues after dispatch-client termination. Remote task failure and timeout behavior require separate execution evidence.

The recurring PATH-alias warning is environmental stderr from this session, not a Cloud task failure. A nonempty stderr stream alone therefore cannot classify command failure; use the process exit status and operation-specific output.
