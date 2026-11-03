# Epic implementation checkpoint — 2026-11-03

## Current local verification

The final full source checkpoint for code commit `5b1d2cb` passed **453/453 tests** on **Node 24.15.0**, with zero failures, skips or cancellations, in **62.992 seconds**. `git diff --check` was clean. The local run log is `/private/tmp/factory-notification-details-final-suite.log`. This run includes both native notification-target and notification-details size corrections.

This suite includes the managed controller runner/service, official MCP stdio protocol, actual role-dispatch/temporary-SQLite integration, strict review artifact parsing, full published-repair provenance, parent acceptance-criteria/terminal guards and persisted bounded review round-robin progress. Test providers are inert; a complete fixture review→QA→confirmation path is not a live Cloud review batch.

## Published hosted CI checkpoint

[Factory checks run 41692000251](https://github.com/bradywatkinson/paperclip-codex-factory/actions/runs/41692000251) succeeded for commit **`d65872ba9023c025a5870444d72f0efcb57e5039`**. Its Node 24.15.0 job passed **362 tests**. The Go 1.27.3 job verified dependencies, passed fixture/race tests and cross-built the app-scoped tailnet proxy for **darwin/arm64** with CGO disabled. The artifact includes the exact source SHA, toolchain version, module files and SHA256 checksums. CI did not run the proxy, authenticate a tailnet node, publish a release, install a service or submit Cloud work. The published head predates the current review/repair implementation; hosted success for that head does not establish hosted success of the later local suite.

Local dependency/artifact download was blocked by this session's network allowlist. Foreground proxy login and phone acceptance remain pending; a successful hosted binary build does not establish either.

## Historical local checkpoints

At commit `b2d93f2`, the local Node 24.15.0 suite passed **314/314 tests** in 30.759 seconds. At `1b08217`, the expanded core passed **344/344 tests** in 32.608 seconds and explicitly excluded the then-unfinished controller login-service work. Those are historical scopes, superseded for local implementation coverage by the checkpoint above.

Implemented and reviewed in the current worktree:

- YAML repository configuration, central policy validation, secret references, two examples, and explicit unsupported-version rejection.
- Durable registration and CAS-fenced Paperclip provisioning with read recovery for ambiguous creates.
- Versioned roles, private reviewer/QA/repair configs and bounded evidence schemas. Registered implementation dispatch retains its original behavior; role dispatch authenticates actual agent/run/task scope, approved criteria and exact checkout, binds the real journal UUID before shared admission, and preserves original registration hashes.
- Cloud/PR patch correlation, immutable GitHub base/head/ancestry, SHA-scoped checks/statuses and crash-safe private artifact publication. Typed repair inspection proves the Cloud previous-head→new-head delta and retains the full original-base→new-head patch. Missing PRs remain unverified patch fallbacks.
- Account-wide dispatch admission, repository ceilings, persisted fair scheduling, sticky uncertain capacity, explicit controls, individual holds, and global journal cutover inventory.
- Multi-company recovery and bounded queue wakeup, with a separate durable wake-intent ledger because generic native wake keys do not provide durable deduplication. Trusted role profiles share this queue without substituting the original implementation agent.
- Durable independent-review orchestration: owned secondary workspaces, new assigned child tasks, exact-actor/parent read recovery, prequeue wake intents, strict known-Cloud diff evidence, bounded repairs and fresh external test/CI gates before human-only confirmation. Native JSON object order is handled semantically; parent edits/completion stop advancement.
- Bounded review collection with persisted account/repository round-robin cursors, explicit processed/deferred counts, cursor CAS and isolated stuck-pipeline failures.
- Owned controller LaunchAgent lifecycle, private cwd/environment and bounded rotating logs; app-scoped private HTTPS proxy implementation and narrow MCP tools.

Independent reviews found and verified fixes for missing dispatcher paths, divergent agent configuration, partial artifact publication, later-attempt guard inventory, retry-cap starvation, invalid queue-head starvation, private executable/config drift, conflicting company runtimes, loaded-service ownership, realpath cwd containment, native JSON payload ordering and the all-or-nothing review batch limit.

The tests include real local child-process SIGKILL/SIGTERM/restart and competing-process SQLite claims against inert executables and fixture services. The controller CLI restart fixture issued exactly one fake wake and no Cloud submissions. These are process/durability tests, not live Cloud interruption or physical Mac power-loss evidence.

Read-only live Story Keeper validation passed versions, authenticated Paperclip company access, GitHub repository/branch, ChatGPT sign-in and filtered Cloud environment label. At observation, main was `637830478604ca8abeb75065d7940c2ffacdb4c9`. Its no-required-checks probe did not verify tests or CI.

At the recorded Story Keeper base, its policy disables application GitHub check jobs and runs its gate in session. Its active `Receipt Check` workflow checks that the PR description contains a passing marker for the head; by its own documented policy that is a presence/freshness check, not proof that tests actually executed. A skipped hosted job or receipt marker alone cannot substitute for independently attributable command evidence. See the immutable [PR checks policy](https://github.com/bradywatkinson/story-keeper/blob/637830478604ca8abeb75065d7940c2ffacdb4c9/.github/workflows/pr-checks.yml) and [receipt workflow](https://github.com/bradywatkinson/story-keeper/blob/637830478604ca8abeb75065d7940c2ffacdb4c9/.github/workflows/receipt-check.yml).

The initial remote-access/UI preflight found no system Tailscale app or CLI at standard locations; a process probe was unavailable, so daemon absence was not established. The later rootless app-scoped tsnet design does not require that daemon; its implemented proxy and hosted build are separate from live node authentication. Browser inventory returned no surfaces and `The browser access host is unavailable`; no rendered Paperclip or Cloud UI acceptance was performed.

Remaining proof is tracked without narrowing scope in [the epic audit](../epic-status.md): unattended coding progression, useful Cloud coding output and tests, actual interruption, live GitHub delivery/review pipeline, second repository/environment, full backup/restore and login recovery, private remote access and phone acceptance. The new Cloud coding task remains awaiting the operator's explicit approval. No #7 job was submitted at this checkpoint.

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

## Controller service checkpoint

The separate owned LaunchAgent `ing.paperclip.codex-factory.controller` installed its plist and immutable private configuration successfully. Native start returned **`Bootstrap failed: 5: Input/output error`** in this execution environment. Installation or plist presence is not running-service proof; start/status from the normal macOS Terminal and actual logout/login recovery remain pending.

A temporary bounded foreground controller runner was observed live at this dated checkpoint, reporting idle with zero Cloud jobs. The separately inspected native controller service remained `not_loaded` with `active:false`. It preserves foreground operation while native registration is unresolved. The temporary foreground runner was subsequently stopped gracefully via SIGINT and restarted on committed code `5b1d2cb` with the same private configuration; running/idle was verified. No pending Cloud work was present. These observations do not prove managed login startup, operation during Mac sleep/reboot, recovery of active Cloud work, provider admission under load or unattended coding. The controller service's combined log retains at most five 5 MiB files; ownership checks bind complete loaded program/arguments to validated current or prior receipts. No secret values are in its plist.

## Review and remote acceptance still pending

A real private Story Keeper `factory review bootstrap --dry-run --json` returned `planned` for reviewer, QA and repair, preserving the existing company/project and `sourceAgentUnchanged:true`. This validated the concrete plan only; it created no agents, tasks or Cloud submissions.

Subsequent real provisioning on code commit `5b1d2cb` returned `configured` for all three separate process agents. A second bootstrap reused the exact same IDs, with `sourceAgentUnchanged:true`:

| Role | Agent ID |
| --- | --- |
| Reviewer | `e36ca665-0fb4-4e6f-b6db-12ff71f71a62` |
| QA | `8f8e87e3-872d-421e-a957-c819ddf2bb38` |
| Repair | `f76aeda3-f0fe-44aa-89ec-27119ab90e1c` |

A fresh account controller pass on that code returned `idle`: zero review pipelines, child tasks, collected artifacts, wakes or attention; `processedPipelines:0` and `deferredPipelines:0`. Its inventory retained one terminal execution and no active/queued/held work, with no Cloud polling or wakes. This records live role provisioning, exact-ID idempotency and idle reconciliation; it creates no review task or model execution.

The source now implements the complete bounded review/QA/repair route and includes local integration tests through actual dispatch wrappers and SQLite journals. No live reviewer, QA or repair Cloud task has been submitted, and no live #9 batch or automatic coding gate has been demonstrated. Starting a batch requires a separately approved actual delivery and `--approve-dispatch`; inspection alone does not start models. Story Keeper's configured `receipt` check is a marker/freshness check and cannot be relabeled as application-test execution.

The app-scoped proxy has no established live Tailscale session or accepted phone URL. Host allowlisting, actual Paperclip login through the proxy, negative raw-port/access tests, phone use and restart recovery remain pending. Only one real repository has been onboarded; no two-repository Cloud/PR/CI/review or interruption proof is claimed. The MCP `PAP-4` probe above remains unassigned, with assignment execution disabled.
