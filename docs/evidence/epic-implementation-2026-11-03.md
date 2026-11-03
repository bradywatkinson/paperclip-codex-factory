# Epic implementation checkpoint — 2026-11-03

At commit `b2d93f2`, the full local Node 24.15.0 suite passed **314/314 tests** in 30.759 seconds, with zero failures, skips, or cancellations. `git diff --check` was clean. This checkpoint predates subsequent MCP dependency/code changes and later CI-name discovery changes.

At commit `1b08217`, the expanded core checkpoint passed **344/344 tests** in 32.608 seconds on Node 24.15.0, with zero failures or skips. This includes MCP protocol tests, PR-only CI discovery, native agent projections, atomic dispatch-fence publication, and recursive staging privacy checks. The controller login-service work was still under development and explicitly excluded. The full-run log was captured at `/private/tmp/factory-core-suite-epic-audit.log`.

Implemented and reviewed at this checkpoint:

- YAML repository configuration, central policy validation, secret references, two examples, and explicit unsupported-version rejection.
- Durable registration and CAS-fenced Paperclip provisioning with read recovery for ambiguous creates.
- Versioned roles, bounded handoffs and evidence schemas; registered implementation dispatch consumes commands, gates and an immutable task-base header.
- Cloud/PR patch correlation, immutable GitHub base/head/ancestry, SHA-scoped check/status observations, and crash-safe private artifact publication. Missing PRs remain unverified patch fallbacks.
- Account-wide dispatch admission, repository ceilings, persisted fair scheduling, sticky uncertain capacity, explicit controls, individual holds, and global journal cutover inventory.
- Multi-company recovery and bounded queue wakeup, with a separate durable wake-intent ledger because generic native wake keys do not provide durable deduplication.

Independent reviews found and verified fixes for missing dispatcher paths, divergent agent configuration, partial artifact publication, later-attempt guard inventory, retry-cap starvation, invalid queue-head starvation, private executable/config drift, and conflicting company runtimes.

The tests include real local child-process SIGKILL/SIGTERM/restart and competing-process SQLite claims against inert executables and fixture services. The controller CLI restart fixture issued exactly one fake wake and no Cloud submissions. These are process/durability tests, not live Cloud interruption or physical Mac power-loss evidence.

Read-only live Story Keeper validation passed versions, authenticated Paperclip company access, GitHub repository/branch, ChatGPT sign-in and filtered Cloud environment label. At observation, main was `637830478604ca8abeb75065d7940c2ffacdb4c9`. Its no-required-checks probe did not verify tests or CI.

The current Story Keeper policy deliberately disables application GitHub check jobs and runs its gate in session. Its active `Receipt Check` workflow checks that the PR description contains a passing marker for the head; by its own documented policy that is a presence/freshness check, not proof that tests actually executed. A skipped hosted job or receipt marker alone cannot substitute for independently attributable command evidence. See the immutable [PR checks policy](https://github.com/bradywatkinson/story-keeper/blob/637830478604ca8abeb75065d7940c2ffacdb4c9/.github/workflows/pr-checks.yml) and [receipt workflow](https://github.com/bradywatkinson/story-keeper/blob/637830478604ca8abeb75065d7940c2ffacdb4c9/.github/workflows/receipt-check.yml).

Remote-access/UI preflight found no Tailscale app or CLI at standard locations. A process probe was unavailable, so daemon absence was not established. Browser inventory returned no surfaces and `The browser access host is unavailable`; no rendered Paperclip or Cloud UI acceptance was performed.

Remaining proof is tracked without narrowing scope in [the epic audit](../epic-status.md): unattended coding progression, useful Cloud coding output and tests, actual interruption, GitHub delivery/review pipeline, second repository/environment, full backup/restore and login recovery, private remote access and phone acceptance. The new Cloud coding task remains awaiting the operator's explicit approval. No #7 job was submitted at this checkpoint.

## Real onboarding and controller pass

Story Keeper is now registered from the private configuration at `~/.paperclip/instances/factory/repository-configs/story-keeper/.factory.yaml`. Its effective configuration hash is `4bed9be7a3bac243af17479a1daf75e4104b36ac1b9eece52b97602ebfde3072`; the required hosted check is `receipt`, with test/lint/build commands retained separately.

The real native configuration endpoint intentionally omits agent metadata. The first provisioning pass retained its created resource IDs and stopped final verification; after correcting the reader to obtain ownership from `agent get`, repeating bootstrap reused those same resources and returned `configured` at operation revision 8:

| Resource | ID |
| --- | --- |
| Company | `dc9439c0-a0d6-4233-b81f-2cc3adc2ec0b` |
| Project | `1af13fa4-ab4f-4455-933e-76b35e99c2f7` |
| Workspace | `a90dd7a3-f367-4c07-be48-b8c488d32995` |
| Dispatcher | `fb4ab405-00d1-4d78-93e5-37af7f02b151` |

The dispatcher was idle with scheduled heartbeats disabled and no active runs. One real `factory controller --once --json` pass returned `idle`, inventoried the existing single terminal execution, reconciled without polling Cloud, and reported zero queued/active/held work and no wakes. Configured account limits are two active globally and one for Story Keeper. This establishes live setup/idle reconciliation, not live admission under contention or unattended coding progression.

## Real MCP protocol and creation probe

The private MCP config at `~/.paperclip/instances/factory/mcp/paperclip.json` allows only the new project and dispatcher. `allowAssignments` remains false.

An official SDK stdio client connected to the real server, listed its five tools, and successfully listed the project's tasks. A subsequent probe created one **unassigned backlog draft**, listed zero runs, closed the server/client, reopened them, and repeated the same request key. It returned `already_created` with the same issue ID:

- Issue: `PAP-4`, `bdb5b0b8-81be-43a9-9faa-8fa0b25f92c8`.
- Request key: `9ae592ab-362f-4c45-879a-cf7e8846c760`.
- Purpose: disposable MCP verification; the task text explicitly forbids assignment/execution.

The probe did not call the assignment tool or invoke Codex Cloud. The draft is left unassigned for inspection. A host plugin connection, private remote network, phone access and an approved real Cloud assignment remain separate acceptance checks.
