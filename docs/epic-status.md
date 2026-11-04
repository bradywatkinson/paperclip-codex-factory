# Factory epic acceptance audit

Audited **2026-11-03**, from the current worktree and live GitHub issue descriptions. The objective is the entire operational factory, including delivery, review, multiple repositories, recovery, and private remote access. A passing fixture suite or a configuration file does not establish live operation.

The audit covers [#1](https://github.com/bradywatkinson/paperclip-codex-factory/issues/1), [#2](https://github.com/bradywatkinson/paperclip-codex-factory/issues/2), and [#7–#16](https://github.com/bradywatkinson/paperclip-codex-factory/issues?q=is%3Aissue). The dispatch/journal/reconciliation/recovery work from #3–#6 is the foundation. Repository configuration, onboarding, shared scheduling, GitHub delivery, role dispatch, independent review/repair orchestration, a managed controller service, narrow MCP tools and an app-scoped tailnet proxy are implemented. Their live acceptance and the integrated epic remain incomplete.

**Local checkpoint:** code commit `5b1d2cb` passed **453/453 Node 24.15.0 tests**, including service, MCP, actual dispatcher/SQLite review integration, typed repair provenance, parent-scope guards and persisted review round-robin progress. `git diff --check` was clean. The final run includes both native notification-target and notification-details size corrections. **Hosted checkpoint:** [Factory checks run 41692000251](https://github.com/bradywatkinson/paperclip-codex-factory/actions/runs/41692000251) succeeded for `d65872ba9023c025a5870444d72f0efcb57e5039`: **362 Node tests**, Go fixture/race tests and a macOS Apple Silicon proxy cross-build. That published head predates the current review/repair changes; it does not establish hosted acceptance of all 453 local tests.

**Live scope:** Story Keeper onboarding returned `configured`; an account controller pass and a temporary bounded runner were idle with no new Cloud submissions. The separate controller plist installed, but native start returned bootstrap error 5; login recovery is pending. Real MCP stdio reads and unassigned draft `PAP-4` creation/restart idempotency are recorded. The reviewer/QA/repair agents now provisioned as `configured`, retained the same three IDs on repeat and left the original dispatcher unchanged; a fresh controller pass remained idle with zero review tasks or model executions. No new #7 coding task, live #9 review/repair batch, phone access or two-repository execution proof is established. [Dated evidence](evidence/epic-implementation-2026-11-03.md) separates these observations from fixture results.

Evidence terms below: **recorded** means an identified dated artifact supports the stated scope; **implemented/tested** describes code and local or hosted checks; **missing** identifies required implementation or live evidence still absent.

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
| Retrieve checks/CI; show links and actionable failures in Paperclip | Inspector reads SHA-scoped check runs and commit statuses with bounded pagination and sanitized links. The review controller consumes these observations and can project gated findings/approval requests through native child tasks and interactions. This path is fixture-tested; live Paperclip delivery projection remains unverified. Onboarding check-name presence is a weaker, separate observation. |
| Verify PR provenance against expected repo and task | Locally tested: exact complete Cloud/GitHub patch match, requested repo/branch/base/head, ancestry, metadata completeness and final PR re-read. Changed head, mismatched patches, forks and incomplete observations fail closed. No live PR proof yet. |
| Support Cloud-created PRs and safe unsupported-CLI fallback | Inspector accepts an explicit same-repo PR and provides a patch fallback when none is supplied; fallback expressly leaves base/head/CI unverified. It does not create PRs or infer them by title. Live delivery missing. |
| No auto-merge; explicit human approval | Inspector uses read-only commands and never sets human approval eligibility. Dispatcher/roles forbid merge/deploy; the review controller requests a human-only confirmation and performs no merge/deploy operation. Live acceptance remains pending. |
| Success/failure/missing-PR integration tests | Included in the local checkpoint, with CI pending/failure/missing/unknown, initial full-patch and repair-delta provenance, pagination, crash-safe artifact publication and actual CLI/registry/journal fixtures. Live cases and Paperclip projection remain unverified. |

## #9 — independent review and bounded repair (implemented/tested; live batch pending)

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Independent Cloud review with criteria, diff and CI context | Private role configs select reviewer/QA/repair agents. The wrapper verifies the actual task/run, approved activation, original criteria and immutable checkout, then binds the real journal execution before admission. Reviewer receives the complete stored patch on its verified base; QA requires the published exact head. Local integration passes. Real provisioning/repeat verification returned `configured` for three separate agents, with the source agent unchanged; no live role Cloud task is claimed. |
| Structured findings linked to PR and follow-up task | Strict known-task Cloud diff parsing accepts only the exact execution evidence file and full source bindings. SQLite persists reports, native child-task IDs, workspaces, execution/Cloud IDs and handoffs. New assigned child creation is fenced before the write and recovers by exact payload/parent/actor reads. Live routing remains pending. |
| Distinguish blocking, nonblocking and infrastructure outcomes | Tested classifications reject clean reports containing blocking/infrastructure findings. Missing or malformed evidence becomes attention, never a passing gate. |
| Maximum attempts; prevent duplicate feedback loops | Durable repair/handoff ceilings, create/wake intents, sticky unknown outcomes and persisted bounded round-robin collection are implemented. Stuck, paused and historical rows do not freeze later approved work. No ambiguous native write is blindly repeated. |
| Passing CI and independent review before human approval queue | Actual journal-backed delivery is freshly reinspected. The pipeline requires clean review, QA, configured application-test CI names and required checks for the same immutable head before a native human-only confirmation with no continuation. Parent edits or human completion stop advancement. Agent reports remain unverified; live gate proof is pending. Story Keeper's receipt-marker check alone is not application-test evidence. |
| Clean-review, required-fix and exhausted-retry tests | Local tests cover clean review→QA→fresh CI→confirmation, blocking review→published verified repair delta→fresh full-patch review, exhaustion, native JSON object ordering, parent drift, unknown writes and bounded fair batches. Real repair publication and live #9 acceptance remain pending. See [operator workflow](review-controller.md). |

## #10 — per-repository configuration (implemented and locally tested)

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Versioned `.factory.yaml`: repo/environment/branch, test/lint/build, gates, limits | Implemented in `repository-config.mjs` and [schema/onboarding guide](repository-onboarding.md); validated through local parser/CLI/dispatcher tests. |
| Useful errors and safe no-merge/no-deploy defaults | Tested field-specific errors, bounded YAML input and fixed safe delivery gates. |
| Secret references only | Tested `secretRefs` accepts environment-name references and rejects value fields. Do not place values in tracked command arguments. References are retained, not resolved/forwarded to execution. |
| Repo overrides cannot weaken central policy | Tested required-check union and concurrency/retry/timeout ceilings; registry persists central policy and rejects silent replacement. The dispatcher enforces shared account/repository admission in addition to these configuration ceilings. |
| Two examples and invalid/migration tests | Two distinct illustrative examples load; malformed YAML/unknown fields/unsafe refs/unsupported versions and migrations are tested. Unknown versions require explicit migration. |
| Explicit factory convention, not native Paperclip | Stated in examples, module and guide. |

## #11 — onboarding CLI (live setup recorded; coding proof pending)

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Add/validate/bootstrap commands or equivalent | Implemented/tested plus list/status. Real Story Keeper registration and bootstrap returned `configured`, followed by a successful idle controller pass. Coding execution remains unverified. |
| Validate GitHub access, Cloud mapping, config and required CI | Tested checks inspect dispatcher availability, versions, repo/branch, check-name presence, ChatGPT auth, filtered Cloud task label and active company. Empty/unconfirmed mapping fails closed. Live Story Keeper validation and configured bootstrap are recorded, including PR-head discovery of the `receipt` name. This proves mapping/check-name presence, not actual application-test execution or future CI acceptance. |
| Idempotent projects and agents | Tested SQLite intent/CAS and exact ownership markers. Live provisioning retained original IDs after a verification stop; repeating bootstrap reused the same project/workspace/agent and returned `configured`. |
| Readable status/corrections and JSON | Local CLI tests cover normalized status and actionable JSON; `operationalVerified` remains false. |
| Dry-run and permission/missing-environment integration tests | Included in the local checkpoint: no-write dry-run, permission failures, missing/unrelated environment, missing CI and unchanged private configuration. Real bootstrap and same-ID repeat are recorded separately; no new Cloud coding job was exercised. |

## #12 — reusable roles and workflow

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Versioned lead, implementer, independent reviewer and QA templates | Implemented in [roles/v1](../roles/README.md), with the implementer consumed by newly registered code-change dispatchers. Legacy generic/read-only behavior is preserved. Private reviewer/QA/repair dispatch is integrated with the account queue. Three real role agents are configured and repeat-bootstrap IDs are stable; live role Cloud dispatch remains pending. |
| Decomposition, handoff, PR-output and acceptance-evidence contracts | Tested ordered lead plan, changed paths, structured findings and QA criterion/evidence references. The durable review controller consumes these contracts, creates bounded new child tasks and collects exact execution artifacts; local integration passes, live team acceptance is pending. |
| Separate roles from repo context and secrets | Bounded renderer injects repo/task/base/head/receipt/PR/CI/argv as JSON under fixed policy; injection and provenance mismatches are tested. No secret values are resolved. |
| Explicit approvals, retry budgets and escalation | Tested pure helper requires terminal confirmation for bounded repairs, escalates unknown/infrastructure/exhaustion, and leaves human status unchanged. The review pipeline persists counters, enforces shared dispatch admission and freshly checks delivery gates before requesting a human decision. |
| Prevent endless agent chatter; two sample-task tests | Role and integrated controller tests cover both sample tasks, bounded handoffs, strict artifact authority and external-evidence requirements. The durable feedback loop is implemented and fixture-tested; no live team is claimed. |
| Propagate updates without overwriting customizations | [Version-pinned additive overlay procedure](../roles/README.md); tests reject wrong role/version and verify shipped templates remain unchanged. |

## #13 — unattended reliability

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Global/per-repo concurrency and fair scheduling | Implemented and tested in actual dispatcher integration across two fixture companies. Persisted admission, fair eligible FIFO, held invalid rows and all-company journal cutover inventory precede submission. Live unattended progression still needs proof. |
| Usage/auth/version/timeout/transient handling with backoff | Reconciler bounds commands, backoff and polling errors; controller shares provider cooldown across companies. Usage-text recognition remains a heuristic without a live quota fixture. |
| Queue depth, active IDs, duration/rates and PR outcomes; no unsupported token accounting | Scheduler snapshots provide counts, held attention, bounded IDs/durations and rates without token claims. GitHub observations persist separately; combined PR-outcome metrics remain incomplete. |
| Operator status, pause/resume and alerts | [Controller/operator CLI](factory-controller.md) implements account/repo pause/resume, explicit CAS limit changes, cooldown and individual held-entry resume. The separate controller service installed its owned plist/config, but native start is blocked by bootstrap error 5. A temporary bounded runner was observed idle. Actual login startup and alert acceptance remain unverified; see [service evidence](evidence/epic-implementation-2026-11-03.md#controller-service-checkpoint). |
| Rate-limit/restart tests and secret-free logs | Included in the local checkpoint: competing-process claims, SIGKILL admission persistence, real loop SIGTERM/restart with one fake wake, cross-company capacity and privacy cases. These do not prove live Mac interruption. |
| Unknown remote state never causes duplicate dispatch | Journal fences, sticky admitted/unknown slots, terminal-proof release and a durable wake-intent ledger are tested. The implemented review/repair path also fences native task/wake intents, binds actual execution IDs before admission and retains unknown outcomes. |

## #14 — private remote access and MCP

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Private remote browser access with Paperclip auth | The app-scoped [tsnet HTTPS proxy](remote-access.md) is implemented, fixture/race-tested and cross-built in hosted CI. Tailscale login, node approval, Paperclip hostname allowance and private remote acceptance remain pending; Paperclip remains loopback-only. |
| Narrow MCP tools: list tasks, create assignments, pause workers, view runs | Implemented with company/project/agent allowlists and guarded new-task assignment. Official SDK protocol/negative tests pass; real task reads, unassigned draft creation, run listing and same-request reuse after server restart pass. Live assignments/pause and host/network acceptance remain unverified; assignments currently disabled. |
| Authenticated outbound tunnel only if needed/supported | The implemented proxy exposes only its registered private HTTPS listener and retains Paperclip authentication. It is not authenticated or running remotely; no public tunnel/Funnel or MCP HTTP listener is configured. |
| Phone access and unauthorized denial | Missing real phone and negative-access tests. |
| Sleep/offline, token and recovery documentation | [Remote operating guide](remote-access.md) covers foreground SSO, private state, HTTPS prerequisites, phone/negative tests and shutdown. Actual sleep/offline/login recovery and phone observations are pending. |
| No public database/raw administrative API | Current loopback/private deployment supports the boundary; remote implementation must retain it. |

## #15 — multi-repository proof

| Acceptance requirement | Evidence and remaining work |
| --- | --- |
| Two distinct repos onboarded solely by config and CLI | One real Story Keeper configuration/registration/bootstrap is recorded. A second repository/environment and completed two-repo execution proof remain missing. |
| Separate Cloud jobs with PR/CI/review evidence and project isolation | Missing integrated two-repo proof. |
| Controller restart during both active jobs; no duplicate submissions | Missing live two-job restart evidence and provider submission counts. |
| Enforced global/per-repo limits; history/operator decisions | Global/per-repo scheduling, multi-company isolation, sticky capacity and fair role collection are implemented and fixture-tested. Live two-repo enforcement/history remains missing. |
| Fresh-install demo, limitations and next backlog | Foundation smoke and single-repo procedure exist; integrated reproducible multi-repo demo missing. |
| No automatic merge or deployment | Controller/delivery/MCP paths provide no merge/deploy operation and role templates forbid them. Live two-repo acceptance must confirm the same boundary. |

## #16 — inspect the existing probe

The [verification issue](https://github.com/bradywatkinson/paperclip-codex-factory/issues/16) records user verification of the existing task identity/completed state, final response, checkout commit/context, sanitized excerpt/provenance, and linkage to #2. Two observations remain: inspect changed-files/activity/PR indicators, and record visible follow-up/PR controls **without activating them**. Use only the existing [Cloud task](https://chatgpt.com/remote/task_e_6ae76e6a06948325b7310562482caa13); no resubmission, patch application, follow-up, PR, merge or deployment is authorized by that inspection procedure.

## Completion boundary

Keep the implemented configuration/onboarding, scheduling, delivery, role and review/repair paths under verification while live approvals are pending. Then execute a useful single-repo coding proof and a two-repo proof against the integrated system. Foundation restore/UI/login and private phone access require their own observations. Keep this epic incomplete until every required behavior has evidence at its actual scope; do not substitute fixture success, docs-only patches, config validation or a READY label for end-to-end acceptance.
