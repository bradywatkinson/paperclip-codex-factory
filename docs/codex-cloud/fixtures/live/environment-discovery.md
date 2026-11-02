# Read-only environment discovery

Observed with installed `codex-cli 0.166.0`, using the existing ChatGPT login. No credentials or authentication-file contents were inspected or captured. Login status reported ChatGPT authentication.

The installed CLI has no environment-list subcommand. The supported discovery route is the interactive browser:

1. Run `codex cloud` in a terminal.
2. Press `o` for **Set Env**.
3. Inspect **Select Environment**. Use a wide terminal so the identifier is not truncated; this probe used 160 columns.
4. Press Escape to close the picker, then `q` to quit. Do not press New Task or submit a prompt.

Exactly one named environment was listed, in addition to the global All Environments view:

| Field | Observed value |
| --- | --- |
| Display label | `bradywatkinson/story-keeper` |
| Environment identifier | `6a7aa92536508191bf085b59e7d6b8ba` |
| Factory-specific environment | None listed |

The label suggests association with that repository; the picker did not expose structured repository binding or a default branch, so that association remains an inference. Viewing the environment establishes list visibility, not permission to dispatch tasks.

A separate read-only `git ls-remote --symref https://github.com/bradywatkinson/story-keeper.git HEAD` check reported `refs/heads/main` and HEAD `631d29372f61496448012413467d1989d4590881`. That establishes the named repository's default branch, not the Cloud environment's binding.

No task was submitted or changed during discovery. Both temporary TUI sessions were closed. `list-before-dispatch.*` separately records the successful noninteractive task inventory, which returned an empty task array and null cursor at capture time.
