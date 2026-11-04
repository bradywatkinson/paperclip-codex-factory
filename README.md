# Paperclip Codex Factory

A reusable, local Paperclip coordination service for an Apple Silicon Mac. The control plane lives outside application repositories; this repository holds its version pins, setup scripts, and operating procedures.

The factory includes repository onboarding, durable Cloud dispatch/recovery, shared admission, GitHub delivery inspection, bounded independent review/QA/repair, narrow MCP tools and a private HTTPS proxy. Live end-to-end acceptance remains incomplete. Production deployment and automatic merge are not provided.

The bootstrap, CLI contract spike, and dispatch bridge were merged through [PR #17](https://github.com/bradywatkinson/paperclip-codex-factory/pull/17). See [the publication record](docs/publication.md) for the initial review history.

## Versions and prerequisites

- Paperclip: `2026.1023.0`, installed through the supported managed installer or an optional global npm installation.
- Node.js: `24.15.0` reference runtime; bootstrap accepts Node 24.x at `24.15.0` or newer, or Node 26 and newer, for current transitive dependencies. Node 25 is excluded.
- Apple Silicon macOS, Git, npm/npx, and a signed-in desktop user for the LaunchAgent.
- Bootstrap requires 10 GiB free disk for install/build/cache headroom; this is a conservative budget, not a measured upstream minimum.

Keep the Node executable at a stable path: the managed shim and this repository's global launcher record its absolute path, and launchd does not load shell version managers. Put the chosen Node `bin` directory first on `PATH`; `PAPERCLIP_NODE` may select its absolute executable for repository scripts.

## Start here

```sh
git clone https://github.com/bradywatkinson/paperclip-codex-factory.git
cd paperclip-codex-factory
node --version
export PAPERCLIP_TELEMETRY_DISABLED=1
./scripts/bootstrap
./scripts/paperclip onboard --no-install-service
# Choose Quickstart; decline “Start Paperclip now”.
"${PAPERCLIP_NODE:-node}" scripts/configure-local.mjs "$HOME/.paperclip/instances/factory/config.json"
./scripts/paperclip doctor
./scripts/paperclip run
# After claiming the board and completing the initial UI checks, stop with Control-C:
./scripts/paperclip service install --instance factory
./scripts/paperclip service status --instance factory --json
```

Open `http://127.0.0.1:8100`, select **Sign in / Create account**, then select **Claim this instance** after signing in to become the first administrator. This private-instance flow does not require copying a claim link from logs. Any startup claim links contain credentials; keep them out of commits and issue evidence. Install the login service after that first UI check. See [operations](docs/operations.md) for installation details and [the fresh-Mac smoke test](docs/smoke-test.md) for acceptance checks.

Bootstrap only installs the CLI. For a single-payload alternative to managed installation, run `PAPERCLIP_INSTALL_METHOD=global ./scripts/bootstrap`; see [installation methods](docs/operations.md#global-npm-alternative). Do not start Paperclip until onboarding has finished and `configure-local.mjs` has applied authentication. In this release, `onboard --yes` starts the foreground server and offers no `--no-run` switch, so use the interactive choices above.

The wrapper defaults to `PORT=8100`, `PAPERCLIP_HOME=$HOME/.paperclip` and `PAPERCLIP_INSTANCE_ID=factory`; existing environment overrides select a different scope only when intentional. Managed code lives in `~/.paperclip/cli`, the stable CLI entrypoint is `~/.local/bin/paperclipai`, and instance state lives in `~/.paperclip/instances/factory`. With global installation, code lives in `~/.local/share/paperclip-global` and its launcher in `~/.local/share/paperclip-factory/bin/paperclipai`. The wrapper prefers that launcher when present and supplies its path to the native service. No application checkout is the service's working storage.

## Verification status

Paperclip `2026.1023.0` is installed and running as the enabled macOS LaunchAgent at `http://127.0.0.1:8100`. Health and loopback binding pass; `doctor` passed 12 checks, and the initial logical database backup passed integrity verification. Saved Board authentication works in the [2026-11-03 preflight](docs/evidence/issue-7-cloud-execution-demo.md). Visual coordination workflows, full restore, and logout/login recovery remain pending. See [dated bootstrap evidence](docs/evidence/2026-10-31-bootstrap.md) and [the smoke-test checklist](docs/smoke-test.md#evidence).

Issue: [#1 — Bootstrap Paperclip local control plane](https://github.com/bradywatkinson/paperclip-codex-factory/issues/1).

## Local checks

```sh
bash -n scripts/bootstrap scripts/paperclip
node --check scripts/configure-local.mjs
node --test tests/*.test.mjs
```

The tests use isolated ephemeral TCP fixtures, disposable configuration files, and inert CLI executables; they can run alongside the live service on port `8100`.

## Codex Cloud contract spike

Issue [#2](https://github.com/bradywatkinson/paperclip-codex-factory/issues/2) records the installed experimental CLI contract, sanitized fixtures, unsupported operations, and upgrade policy. See [the compatibility matrix and verification procedure](docs/codex-cloud/README.md). The authorized read-only probe reached READY with zero reported file changes, and the user supplied its final response from the [Cloud UI](https://chatgpt.com/remote/task_e_6ae76e6a06948325b7310562482caa13). See [the live evidence](docs/codex-cloud/evidence/2026-11-01.md) for the user-reported result, exit-code traps, requested-versus-reported branch difference, and remaining unverified behavior.

## Paperclip Cloud dispatch bridge

Issue [#3](https://github.com/bradywatkinson/paperclip-codex-factory/issues/3) adds an external one-shot bridge using Paperclip's `process` adapter. It validates the assigned task and project, dispatches through the pinned ChatGPT-authenticated Cloud CLI, and leaves an explicit blocked reconciliation handoff. See [configuration, lifecycle and verification](docs/cloud-dispatch.md). The bridge's receipt is dispatch evidence; Cloud task completion is reconciled separately.

The live read-only smoke test dispatched Paperclip task PAP-2 in an 18.688-second local run; the Cloud task later reached READY with one attempt and zero reported changes. A second explicit local wake returned `already_dispatched` in 2.669 seconds with the same Cloud ID, unchanged guard, and no new receipt comment or submission. The user supplied the Cloud result screenshot, after which a Board operator manually marked PAP-2 done.

The original smoke verification passed 28 local tests. See [the live evidence](docs/evidence/issue-3-cloud-dispatch/README.md). The notification-only reconciler below adds periodic Cloud observation; the original smoke record remains a historical dispatch/manual-closeout observation.

## Durable execution journal

Issue [#4](https://github.com/bradywatkinson/paperclip-codex-factory/issues/4) adds a SQLite journal for execution identity, attempts, state, receipts, transition history, and Paperclip run associations. The bridge uses a transactional claim before submission and retains unknown outcomes without automatic retries. Existing JSON guards import without changing their bytes, and compatibility fences prevent an older writer from bypassing the journal claim.

See [the state model, schema migrations, inspection and cutover guide](docs/execution-journal.md). Historical schema-3 validation passed **63/63 tests** on Node 24.15.0. The schema-4 journal adds polling leases, sanitized observations, a durable notification outbox, and shared provider rate reservations; its journal tests passed **38/38**. The historical schema-2 [additive PAP-2 guard migration](docs/evidence/issue-4-execution-journal/live-migration.json) preserved the original file hash, Cloud ID, and original run; repeated import was stable, with no Cloud submission or Paperclip task change. The [live schema-3 upgrade](docs/evidence/issue-4-execution-journal/schema-upgrade.json) also preserved execution identity and receipt data while correcting import-audit timestamps to the original import observation. These historical records do not establish live schema-4 migration. `running` means an accepted receipt, not confirmed Cloud completion. Full reboot/power-loss recovery remains untested; the startup recovery controller below implements #6 with separate verification limits.

## Cloud polling and review notifications

Issue [#5](https://github.com/bradywatkinson/paperclip-codex-factory/issues/5) adds a foreground reconciler for known accepted Cloud executions. It polls the pinned CLI with bounded work and shared rate limits, records durable observations, and creates a human-only review-notification card when Cloud reports READY. It **preserves every Paperclip task status**: a blocked task stays blocked until an operator decides the next step. Accepting the card acknowledges the handoff without completing the task or continuing an agent run. Remote completion does not verify acceptance criteria, and unavailable final assistant output or PR metadata is stated explicitly.

Copy [the example configuration](examples/cloud-reconcile.json) into private controller storage, replace its company and absolute paths, and use the existing Codex ChatGPT sign-in and Paperclip Board CLI sign-in. Run a bounded pass with a supported Node runtime:

```sh
node scripts/cloud-reconcile.mjs --config /absolute/path/to/cloud-reconcile.json --once
```

Use `--loop` for periodic foreground polling; no service is installed automatically. Durable notification state survives local interruptions. The card has a stable interaction idempotency key. An ambiguous write is checked for an existing exact card body/key created by the signed-in Board user and is never automatically resent. Cards have no continuation or addressee and do not wake a dispatcher. Board comments are deliberately avoided because the pinned release can implicitly reopen blocked/done tasks. See [configuration, operation, inspection, and delivery limits](docs/cloud-reconcile.md).

## Controller restart recovery

Issue [#6](https://github.com/bradywatkinson/paperclip-codex-factory/issues/6) adds a foreground recovery controller that inventories unfinished journal work and resumes polling the same known Cloud IDs. It preserves active claims, leases, retry schedules, receipts, and duplicate-submission fences. Interrupted dispatch claims become unknown only after the original Paperclip run is confirmed terminal; missing identities remain an investigation task.

```sh
node scripts/controller-recovery.mjs --config /absolute/path/to/cloud-reconcile.json --loop
```

The same private configuration supports a consecutive polling-error limit (default 8), durable company-wide usage cooldown, and explicit resumption of read-only polling. Startup never submits Cloud work or resets ambiguous notification writes. No background service is installed automatically. See [startup behavior, operator recovery, and verification limits](docs/controller-recovery.md); process-restart fixture tests do not establish Mac reboot or physical power-loss recovery.

## Single-repository demo

Issue [#7](https://github.com/bradywatkinson/paperclip-codex-factory/issues/7) proposes a useful coding change with focused tests in Story Keeper. See [the reproducible procedure](docs/single-repository-demo.md), [coding task prompt](examples/single-repository-coding-task.md), and [preflight evidence](docs/evidence/issue-7-cloud-execution-demo.md). Live submission requires explicit approval; patch delivery and live controller interruption remain unverified.

## Implementation and live acceptance

Code commit `5b1d2cb` passed **453/453 Node 24.15.0 tests**, including the native notification-target and notification-details size corrections. The [published d65872b CI run](https://github.com/bradywatkinson/paperclip-codex-factory/actions/runs/41692000251) separately passed **362 Node tests**, Go fixture/race tests and a macOS Apple Silicon proxy cross-build. That hosted head predates the current review/repair work.

Real Story Keeper onboarding, separate reviewer/QA/repair agent provisioning with repeat-ID reuse, and an idle current-code account-controller pass are recorded. No review tasks or model executions were started by provisioning. The MCP stdio probe created/reused unassigned draft `PAP-4` without invoking Cloud. The separate controller plist installed, but native start returned bootstrap error 5; a temporary bounded runner was observed idle while normal-Terminal service verification remains pending. No live #7 coding proof, #9 review batch, phone access or two-repository execution proof is claimed. See [dated evidence](docs/evidence/epic-implementation-2026-11-03.md) and the [full acceptance audit](docs/epic-status.md).

## Factory operator CLI

The [epic acceptance audit](docs/epic-status.md) tracks remaining live and operational checks. The factory CLI requires the repository dependencies and supported Node runtime:

```sh
npm ci --ignore-scripts
FACTORY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
"$FACTORY_NODE" scripts/factory.mjs repo validate --config examples/repositories/node-service.factory.yaml --json
"$FACTORY_NODE" scripts/factory.mjs repo --help
"$FACTORY_NODE" scripts/factory.mjs scheduler --help
"$FACTORY_NODE" scripts/factory.mjs controller service --help
"$FACTORY_NODE" scripts/factory.mjs review --help
"$FACTORY_NODE" scripts/factory.mjs delivery inspect --help
```

See [repository configuration and onboarding](docs/repository-onboarding.md), [review/repair orchestration](docs/review-controller.md), [controller service operations](docs/controller-service.md), [private remote access](docs/remote-access.md) and [narrow MCP tools](docs/paperclip-mcp.md). Validation is separate from successful execution; bootstrapping never submits a Cloud job. Review batches require an explicit approved delivery and `--approve-dispatch`.

An existing configured repository can strengthen its CI gate through `factory repo update OWNER/REPO --config ABS_YAML --expected-config-hash OLD_SHA`. The default is a dry run; `--apply` requires a paused account, no unfinished execution/review or ambiguous intent for that repository, and verified idle owned agents. Only additions to `delivery.requiredChecks` are supported; the existing policy and every other normalized binding stay fixed. The durable update retains native IDs and execution history, fences stale configuration, and leaves admission paused for a separate operator resume. Stop custom factory runners before opening stores with this release, and restart them from the updated commit: registry/scheduler schema 2 rejects older code but cannot revoke its already-open handles. Follow the [update and interruption-recovery procedure](docs/repository-onboarding.md#add-required-ci-checks-to-a-configured-repository), including dry-run metadata effects. A `receipt` marker does not substitute for actual application-test checks, and no Story Keeper update or Cloud submission is implied.

## Upstream references

- [Managed installation](https://docs.paperclip.ing/reference/cli/installation/)
- [Service lifecycle](https://docs.paperclip.ing/reference/cli/service/)
- [Enable multi-user login](https://docs.paperclip.ing/how-to/enable-multi-user-login/)
- [Database](https://docs.paperclip.ing/deploy/database/)
- [Backup and restore](https://docs.paperclip.ing/how-to/back-up-and-restore-a-company/)

Upstream documentation may describe newer versions. This repository's scripts and recorded evidence apply to the pinned release.
