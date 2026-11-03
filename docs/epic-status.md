# Factory epic acceptance audit

Audited **2026-11-03**, from the current worktree and live GitHub issue descriptions. The objective is the entire operational factory, including delivery, review, multiple repositories, recovery, and private remote access. A passing fixture suite or a configuration file does not establish live operation.

The current open issues are [#1](https://github.com/bradywatkinson/paperclip-codex-factory/issues/1), [#2](https://github.com/bradywatkinson/paperclip-codex-factory/issues/2), and [#7–#16](https://github.com/bradywatkinson/paperclip-codex-factory/issues?q=is%3Aissue+is%3Aopen). The dispatch/journal/reconciliation/recovery work from #3–#6 is the foundation for the remaining work. Configuration, onboarding, role templates and the read-only GitHub delivery inspector now have local test evidence; their live acceptance and the integrated epic remain incomplete.

Evidence terms below: **recorded** means an identified dated artifact supports the stated scope; **in progress** means code or documentation exists without complete acceptance evidence; **missing** means no implementation or required observation was found. At commit `1b08217`, the full core Node **24.15.0** suite passed **344/344 tests**, including scheduler, inventory, controller, delivery artifacts/CLI, MCP protocol, CI-name discovery and fixture child-process restart. `git diff --check` was clean. The login-service work was explicitly excluded. [Dated evidence](evidence/epic-implementation-2026-11-03.md) also records real onboarding, idle controller reconciliation, and MCP draft creation/restart idempotency. No new Cloud coding submission is established.

## #1 — local foundation

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Pin a tested release; document install/start/stop/upgrade | Recorded: Paperclip `2026.1023.0`, reference Node `24.15.0`, [operations](operations.md), bootstrap scripts and [setup evidence](evidence/2026-10-31-bootstrap.md). |
| Persistent storage, authentication, backups, restart on login | Partial: healthy authenticated loopback service and working Board sign-in in [latest preflight](evidence/issue-7-cloud-execution-demo.md). Logical backup is recorded; stopped full backup, isolated restore, and actual logout/login startup remain unverified. |
| Verify goals, tasks, assignments and approvals in the UI | Missing rendered goal→project→task/assignee persistence and approve/reject hiring evidence. CLI task/card tests do not establish UI acceptance. |
| Document environment and secret handling without credentials | Recorded in [operations](operations.md#persistent-files-and-environment); preserve authentication material privately. |
| Repeatable fresh-Mac smoke test | Procedure and reconciled dated evidence table exist in [smoke-test](smoke-test.md); full execution on a fresh Mac remains unverified. |

## #2 — experimental Cloud contract

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Record version and relevant help | Recorded CLI `0.166.0` in [installed fixtures](codex-cloud/fixtures/installed/manifest.json). |
| Submit harmless task through ChatGPT login | Recorded authorized read-only dispatch and [user-reported final response](codex-cloud/fixtures/live/user-reported-result/manifest.json). This authorization was for that probe. |
| Verify identity/list/status/result/failure/timeout; note unsupported operations | Partial [compatibility matrix](codex-cloud/README.md): URL identity, pending→ready list/status and empty diff observed; final result requires UI. Parser/lookup errors and a local caller deadline are recorded. Actual remote execution failure and Cloud timeout remain unmeasured. |
| Determine remote PR and follow-up/resume capabilities | CLI exposes neither interface. UI control visibility and actual remote PR/follow-up success remain separate unverified claims. See #16. |
| Sanitized fixtures, compatibility matrix and upgrade policy | Recorded in [Cloud contract](codex-cloud/README.md); missing live failure/timeout cases remain explicit. |
| No tokens or credentials in fixtures/logs | Sanitized recorded artifacts; continue inspecting each newly published artifact. Do not infer future outputs are safe. |

## #7 — one real coding task

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Register a test repo and Cloud environment | Existing Story Keeper Paperclip project/workspace and environment access recorded in [preflight](evidence/issue-7-cloud-execution-demo.md). Environment label is mapping evidence, not a structured repository binding from the CLI. |
| Paperclip task → Cloud → complete observed lifecycle | Existing bridge and controller support the path; a new #7 coding task has not been submitted or observed. |
| Code change + test evidence + PR or documented fallback | Missing real coding output. The [demo procedure](single-repository-demo.md) now proposes the useful Story Keeper reserved-slug fix and [coding prompt](../examples/single-repository-coding-task.md), pending explicit submission approval. The earlier docs-only tracer cannot satisfy this criterion. CLI patch retrieval with a verified base and captured test evidence is the documented PR fallback. |
| Mac interruption does not terminate Cloud work; reconciliation resumes | Missing live interrupted execution. [#6 tests](evidence/issue-6-controller-recovery.md) kill/restart a real local process against fake services. A future controller stop/restart proves only that interruption scope; physical sleep/reboot needs its own observation. |
| Limitations and reproducible demo script/procedure | [Demo procedure](single-repository-demo.md) includes the coding proposal, immutable-base check and scoped interruption procedure; execution and actual evidence remain pending. |

## #8 — GitHub delivery

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Associate task with repo, branch, PR and commits | `github-delivery.mjs` produces an execution/Cloud/repo/branch/base/head/PR association. Tested CLI loads actual registry/journal records and persists private immutable observations and patches. No live coding association demonstrated. |
| Retrieve checks/CI; show links and actionable failures in Paperclip | Inspector reads SHA-scoped check runs and commit statuses with bounded pagination and sanitized links. Paperclip delivery projection is still being integrated. Onboarding check-name presence remains a weaker, separate observation. |
| Verify PR provenance against expected repo and task | Locally tested: exact complete Cloud/GitHub patch match, requested repo/branch/base/head, ancestry, metadata completeness and final PR re-read. Changed head, mismatched patches, forks and incomplete observations fail closed. No live PR proof yet. |
| Support Cloud-created PRs and safe unsupported-CLI fallback | Inspector accepts an explicit same-repo PR and provides a patch fallback when none is supplied; fallback expressly leaves base/head/CI unverified. It does not create PRs or infer them by title. Live delivery missing. |
| No auto-merge; explicit human approval | Inspector uses read-only commands and never sets human approval eligibility. Dispatcher/roles forbid merge/deploy. Full pipeline must retain these invariants. |
| Success/failure/missing-PR integration tests | Included in the 314-test checkpoint, with CI pending/failure/missing/unknown, provenance, pagination, crash-safe artifact publication and actual CLI/registry/journal fixtures. Live cases and Paperclip projection remain unverified. |

## #9 — independent review and bounded repair

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Independent Cloud review with criteria, diff and CI context | Role renderer supports immutable PR/CI/task context. Actual independent reviewer dispatch and immutable diff attachment remain missing. |
| Structured findings linked to PR and follow-up task | Tested role result schema carries task/repo/base/head and findings. Durable finding persistence and real follow-up task routing remain missing. |
| Distinguish blocking, nonblocking and infrastructure outcomes | Implemented/tested role classifications reject a clean result containing blocking/infrastructure findings. Actual reviewer observations still missing. |
| Maximum attempts; prevent duplicate feedback loops | Pure routing helper has tested attempt/handoff ceilings and terminal confirmation before repair. Durable review/repair counters, deduplication and dispatch enforcement remain missing. |
| Passing CI and independent review before human approval queue | Helper requires separate exact-head tests/CI/independent-review observations before recommending human approval; agent reports are always unverified. Trusted adapter integration and live gate proof missing. Existing READY card remains informational. |
| Clean-review, required-fix and exhausted-retry tests | Local role-result/routing cases are included in the 314-test checkpoint. Full review/repair-controller integration tests remain missing. |

## #10 — per-repository configuration (implemented and locally tested)

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Versioned `.factory.yaml`: repo/environment/branch, test/lint/build, gates, limits | Implemented in `repository-config.mjs` and [schema/onboarding guide](repository-onboarding.md); validated through local parser/CLI/dispatcher tests. |
| Useful errors and safe no-merge/no-deploy defaults | Tested field-specific errors, bounded YAML input and fixed safe delivery gates. |
| Secret references only | Tested `secretRefs` accepts environment-name references and rejects value fields. Do not place values in tracked command arguments. References are retained, not resolved/forwarded to execution. |
| Repo overrides cannot weaken central policy | Tested required-check union and concurrency/retry/timeout ceilings; registry persists central policy and rejects silent replacement. Runtime global scheduling remains a separate gate. |
| Two examples and invalid/migration tests | Two distinct illustrative examples load; malformed YAML/unknown fields/unsafe refs/unsupported versions and migrations are tested. Unknown versions require explicit migration. |
| Explicit factory convention, not native Paperclip | Stated in examples, module and guide. |

## #11 — onboarding CLI (implemented and fixture-tested; live proof pending)

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Add/validate/bootstrap commands or equivalent | Implemented/tested plus list/status. Real Story Keeper registration and bootstrap returned `configured`, followed by a successful idle controller pass. Coding execution remains unverified. |
| Validate GitHub access, Cloud mapping, config and required CI | Tested checks inspect dispatcher availability, versions, repo/branch, check-name presence, ChatGPT auth, filtered Cloud task label and active company. Empty/unconfirmed mapping fails closed. Live verification pending; future CI acceptance is separate. |
| Idempotent projects and agents | Tested SQLite intent/CAS and exact ownership markers. Live provisioning retained original IDs after a verification stop; repeating bootstrap reused the same project/workspace/agent and returned `configured`. |
| Readable status/corrections and JSON | Local CLI tests cover normalized status and actionable JSON; `operationalVerified` remains false. |
| Dry-run and permission/missing-environment integration tests | Included in the 314-test checkpoint: no-write dry-run, permission failures, missing/unrelated environment, missing CI and unchanged private configuration. No new real Cloud job or bootstrap was exercised. |

## #12 — reusable roles and workflow

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Versioned lead, implementer, independent reviewer and QA templates | Implemented in [roles/v1](../roles/README.md), with the implementer consumed by newly registered code-change dispatchers. Legacy generic/read-only behavior is preserved. Other live role dispatch remains future work. |
| Decomposition, handoff, PR-output and acceptance-evidence contracts | Tested ordered lead plan, changed paths, structured findings and QA criterion/evidence references. Runtime pipeline integration remains incomplete. |
| Separate roles from repo context and secrets | Bounded renderer injects repo/task/base/head/receipt/PR/CI/argv as JSON under fixed policy; injection and provenance mismatches are tested. No secret values are resolved. |
| Explicit approvals, retry budgets and escalation | Tested pure helper requires terminal confirmation for bounded repairs, escalates unknown/infrastructure/exhaustion, and leaves human status unchanged. Caller must persist counters and independently enforce dispatch/gates. |
| Prevent endless agent chatter; two sample-task tests | 16 focused role tests passed, including both different sample tasks through all four roles, bounded handoffs and external-evidence requirements. No live team or durable feedback loop demonstrated. |
| Propagate updates without overwriting customizations | [Version-pinned additive overlay procedure](../roles/README.md); tests reject wrong role/version and verify shipped templates remain unchanged. |

## #13 — unattended reliability

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Global/per-repo concurrency and fair scheduling | Implemented and tested in actual dispatcher integration across two fixture companies. Persisted admission, fair eligible FIFO, held invalid rows and all-company journal cutover inventory precede submission. Live unattended progression still needs proof. |
| Usage/auth/version/timeout/transient handling with backoff | Reconciler bounds commands, backoff and polling errors; controller shares provider cooldown across companies. Usage-text recognition remains a heuristic without a live quota fixture. |
| Queue depth, active IDs, duration/rates and PR outcomes; no unsupported token accounting | Scheduler snapshots provide counts, held attention, bounded IDs/durations and rates without token claims. GitHub observations persist separately; combined PR-outcome metrics remain incomplete. |
| Operator status, pause/resume and alerts | [Controller/operator CLI](factory-controller.md) implements account/repo pause/resume, explicit CAS limit changes, cooldown and individual held-entry resume. Live service installation and alert delivery remain unverified. |
| Rate-limit/restart tests and secret-free logs | Included in the 314-test checkpoint: competing-process claims, SIGKILL admission persistence, real loop SIGTERM/restart with one fake wake, cross-company capacity and privacy cases. These do not prove live Mac interruption. |
| Unknown remote state never causes duplicate dispatch | Journal fences, sticky admitted/unknown slots, terminal-proof release and a durable wake-intent ledger are tested. The future review/repair pipeline must retain the invariant. |

## #14 — private remote access and MCP

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Private remote browser access with Paperclip auth | Missing Tailscale/equivalent configuration and acceptance evidence; current service is loopback-only. No app/CLI found at standard locations; daemon-state probe unavailable. |
| Narrow MCP tools: list tasks, create assignments, pause workers, view runs | Implemented with company/project/agent allowlists and guarded new-task assignment. Official SDK protocol/negative tests pass; real task reads, unassigned draft creation, run listing and same-request reuse after server restart pass. Live assignments/pause and host/network acceptance remain unverified; assignments currently disabled. |
| Authenticated outbound tunnel only if needed/supported | Need a concrete connectivity design; no tunnel configured or claimed. |
| Phone access and unauthorized denial | Missing real phone and negative-access tests. |
| Sleep/offline, token and recovery documentation | Foundation loopback/service limits documented; remote-specific operating guide missing. |
| No public database/raw administrative API | Current loopback/private deployment supports the boundary; remote implementation must retain it. |

## #15 — multi-repository proof

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Two distinct repos onboarded solely by config and CLI | Missing live registrations/bootstrap through completed CLI. Only one Cloud environment is evidenced. |
| Separate Cloud jobs with PR/CI/review evidence and project isolation | Missing integrated two-repo proof. |
| Controller restart during both active jobs; no duplicate submissions | Missing live two-job restart evidence and provider submission counts. |
| Enforced global/per-repo limits; history/operator decisions | Missing scheduling implementation and live enforcement evidence. |
| Fresh-install demo, limitations and next backlog | Foundation smoke and single-repo procedure exist; integrated reproducible multi-repo demo missing. |
| No automatic merge or deployment | Must hold across all new paths; existing dispatcher instruction alone cannot establish future behavior. |

## #16 — inspect the existing probe

The [verification issue](https://github.com/bradywatkinson/paperclip-codex-factory/issues/16) records user verification of the existing task identity/completed state, final response, checkout commit/context, sanitized excerpt/provenance, and linkage to #2. Two observations remain: inspect changed-files/activity/PR indicators, and record visible follow-up/PR controls **without activating them**. Use only the existing [Cloud task](https://chatgpt.com/remote/task_e_6ae76e6a06948325b7310562482caa13); no resubmission, patch application, follow-up, PR, merge or deployment is authorized by that inspection procedure.

## Completion boundary

Advance configuration/onboarding, durable scheduling, GitHub delivery, roles and independent review while live approvals are pending. Then execute a useful single-repo coding proof and a two-repo proof against the integrated system. Foundation restore/UI/login and private phone access require their own observations. Keep this epic incomplete until every required behavior has evidence at its actual scope; do not substitute fixture success, docs-only patches, config validation or a READY label for end-to-end acceptance.
