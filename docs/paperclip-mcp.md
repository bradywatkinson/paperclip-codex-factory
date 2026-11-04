# Scoped local Paperclip MCP

This factory convention exposes five Paperclip operations over the MCP stdio protocol. It runs as a local child process with the controller user's existing Paperclip Board CLI sign-in. It opens no HTTP listener, installs no tunnel, and does not expose the database or an administrative API.

The server uses exact official SDK pins: `@modelcontextprotocol/server` 2.4.0 and Zod 4.6.7, with `@modelcontextprotocol/client` 2.4.0 for protocol tests. The [official stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) describes the transport, and the [official client guide](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-client) describes initialization, tool discovery, calls, and shutdown. Node 24.15.0 is the reference runtime for the durable local intent store.

## Configure and connect

Copy [the example](../examples/paperclip-mcp.json) to a private absolute path outside application repositories. Replace its company UUID, project UUID allowlist, agent UUID allowlist, executable path, and intent directory. All three scopes are mandatory. API access is restricted to an authenticated HTTP loopback origin; this server cannot forward a Board bearer to a remote host. Credentials remain in the Paperclip CLI's normal private store and are never placed in MCP configuration, command arguments, tool results, or protocol logs.

The MCP host launches this command; there is no separate server daemon to start:

```json
{
  "command": "/Users/your-user/.local/share/paperclip-runtime-next/node_modules/node/bin/node",
  "args": [
    "/absolute/path/to/paperclip-codex-factory/scripts/paperclip-mcp.mjs",
    "--config",
    "/absolute/private/path/paperclip-mcp.json"
  ]
}
```

Use the host's documented MCP registration format around this command. This repository does not modify an assistant's configuration automatically. The startup message goes to stderr; stdout contains only MCP protocol messages. Closing the host connection closes the transport. A trusted host and local OS account control access to this process: tool allowlists do not create a separate OS identity or turn the existing broad Board credential into a server-enforced narrow credential.

## Tools and boundaries

| Tool | Behavior |
| --- | --- |
| `list_tasks` | Requires one allowed project UUID. Returns bounded task summaries, excluding tasks assigned to agents outside the allowlist. It returns no descriptions or logs. |
| `view_runs` | Requires a scoped issue UUID. Returns bounded run IDs, agent IDs, status, and timestamps. Rejects foreign company/agent records and omits contexts, prompts, logs and environment variables. |
| `create_task_draft` | Creates a **new**, unassigned `backlog` task in an allowed project. Requires title, description, and a caller-generated UUID `idempotencyKey`. It never assigns an agent or edits an existing task. |
| `create_assignment` | Creates a **new** `todo` task with an explicitly allowed agent and project. Requires `allowAssignments: true` in private configuration and `confirmAssignment: true` in that call. A host must obtain explicit human confirmation before invoking it: native assignment can immediately wake a dispatcher and submit Cloud work. |
| `pause_agent` | Pauses an explicitly allowed agent after checking its company. Repeated pause returns the already-paused state. It does not cancel accepted Cloud work. Resume through normal Paperclip operator controls. |

Existing-task reassignment is deliberately absent. The pinned checkout operation guards status and agent assignment, but does not atomically guard project membership or a concurrent human user assignment. Creating a fresh, atomically assigned issue avoids stealing or reopening an existing human-owned task. No tool can write an existing task status, add comments, invoke an arbitrary command, dispatch Cloud directly, merge, deploy, delete, or broaden its configured allowlists.

Tool annotations describe reads and reversible operations; they do not replace a host's consent controls. `allowAssignments` defaults to false. Keep it disabled until a concrete repository/task has been approved for Cloud dispatch. This module's fixture tests do not authorize or perform a real assignment.

## Creation retries and recovery

Generate one UUID `idempotencyKey` for each intended creation and reuse it on retries. UUID key casing is normalized. The private `mcp-intents.sqlite` journal records a company-bound payload hash and Board creator identity before the CLI creation call. It does not retain task title or description plaintext. Files are private, with SQLite FULL synchronization and a durable directory entry before mutation.

A confirmed retry returns the original issue ID. It preserves subsequent human status and ownership. Reusing a key with different content or a different creation kind fails. A timed out command or malformed response leaves an uncertain intent; it never causes another automatic create. A later call can recover only one exact Board-authored request marker plus matching project, title, description and assignment by supported reads. The marker is the native issue `billingCode` value `factory-mcp:<key>`, not a comment or title guess.

Zero matches, multiple matches, changed content/ownership, or unavailable reads remain `MCP_CREATE_OUTCOME_UNKNOWN`. Inspect the original project and intent before deciding what happened. Do not choose a new key merely to bypass uncertainty. Permission, scope, subprocess, output-size and schema errors expose stable codes without raw command diagnostics. Normal list/run responses are capped; a bounded list does not prove no other records exist.

## Verification and remaining acceptance

```sh
node --test tests/paperclip-mcp.test.mjs
```

The tests use official SDK clients against an in-memory connection and an actual stdio child process with an inert Paperclip executable. They cover protocol discovery/calls/shutdown, scoped reads, draft creation, opt-in new assignment, key reuse across server restart, concurrent duplicate calls, ambiguous-create recovery, human terminal preservation, pausing, and sanitized results. They make no live Paperclip, authentication, or Codex Cloud calls.

This is local MCP acceptance only. Phone access, Tailscale installation/authentication, private remote browser access, unauthorized-client rejection over a network, and a real host connection remain separate [issue #14](https://github.com/bradywatkinson/paperclip-codex-factory/issues/14) checks. Stdio alone does not provide remote access while the Mac sleeps or is offline.
