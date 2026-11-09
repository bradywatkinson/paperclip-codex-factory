# Repository configuration and onboarding

`.factory.yaml` is **this factory's convention**, not a native Paperclip feature. The #10/#11 schema, registry and onboarding CLI are implemented and locally fixture-tested. Live config-driven provisioning and integrated delivery remain unverified. Configuration validation and provisioned board objects do not mean the epic is operational.

## Runtime and prerequisites

Use Node **24.15.0** for the pinned live onboarding checks and built-in SQLite. Install the pinned YAML dependency from the lockfile with the normal package manager:

```sh
npm ci --ignore-scripts
FACTORY_NODE="$HOME/.local/share/paperclip-runtime-next/node_modules/node/bin/node"
"$FACTORY_NODE" scripts/factory.mjs --help
```

Live checks require managed Paperclip `2026.1023.0`, Codex CLI `0.167.0` signed in through ChatGPT, GitHub CLI access through its normal saved sign-in, and an active Paperclip company accessible through its normal Board CLI sign-in. Keep credentials in those private stores. Do not copy bearer tokens, auth files or login approval URLs into repository configuration or evidence.

The 0.167.0 adapter baseline is an explicit source update. Historical fixtures capture 0.166.0, and a new authorized 0.167.0 Cloud lifecycle remains unverified; see the [compatibility evidence and upgrade policy](codex-cloud/README.md). Updating this source does not restart a running controller or approve Cloud submission.

Keep the central policy and onboarding registry outside application checkouts, under private factory storage. Use an absolute, stable Node path and factory checkout path for process agents; moving either after provisioning changes the recorded bootstrap binding. Read [operations](operations.md) and [dispatch setup](cloud-dispatch.md) before live provisioning.

## Schema version 1

See two illustrative examples: [Node service](../examples/repositories/node-service.factory.yaml) and [TypeScript site](../examples/repositories/typescript-site.factory.yaml). Their repository names and environment IDs are examples, not configured live targets.

```yaml
schemaVersion: 1
repository: owner/repository
defaultBranch: main
cloud:
  environmentId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
commands:
  test:
    argv: [node, --test]
    timeoutMs: 120000
delivery:
  requiredChecks: [unit-tests]
concurrency:
  maxActive: 1
  maxAttempts: 2
secretRefs:
  GITHUB_TOKEN:
    env: FACTORY_GITHUB_TOKEN
```

| Field | Accepted value and default |
| --- | --- |
| `schemaVersion` | Required integer `1`. Other versions fail with `CONFIG_MIGRATION_REQUIRED`; there is no implicit v0 translation or downgrade. |
| `repository` | Required GitHub `owner/name`, without a URL or `.git` suffix. Registry lookup is case-insensitive. |
| `defaultBranch` | Branch name; defaults to `main`. Unsafe ref syntax is rejected. This is a published branch, **not** an immutable commit pin. |
| `cloud.environmentId` | Required 32-character lowercase hexadecimal environment ID. |
| `commands.test` | Required mapping with a nonempty string `argv` array and optional `timeoutMs`. |
| `commands.lint`, `commands.build` | Optional mappings with the same shape. No shell-string or `shell` field. |
| `delivery.requiredChecks` | Unique hosted check names, at most 50 after combining central and repository requirements; central requirements are retained. |
| `delivery.requireIndependentReview`, `requireHumanApproval` | Always `true`; explicit `false` is a policy violation. |
| `delivery.autoMerge`, `deploy` | Always `false`; explicit `true` is a policy violation. |
| `concurrency.maxActive` | Positive integer, defaults to 1; may not exceed either central active ceiling. |
| `concurrency.maxAttempts` | Positive integer; defaults to the smaller of 3 and the central attempt ceiling. |
| `secretRefs` | At most 32 uppercase environment-name keys, each containing only `{ env: UPPERCASE_NAME }`. No credential-value fields. |

Command timeouts default to the smaller of 600,000 ms and the central command timeout cap. Values must be at least 1,000 ms and within that cap; argv arrays have at most 128 nonempty entries. Validation stores command data and never runs it. Do not put credential values in argv, free text or tracked files. Secret references are retained for a future execution boundary; onboarding does not resolve or forward them.

The parser accepts a single UTF-8 YAML 1.2 document of at most 65,536 bytes. Unknown fields, duplicate keys, aliases, merge keys, unsupported tags, nulls, excessive nesting and unsupported schema versions fail closed. Parse/validation errors identify the field or category without copying the YAML source into the diagnostic.

## Central policy

Copy [the policy example](../examples/repositories/factory-policy.yaml) into owner-controlled private factory storage. Pass it explicitly with `--policy` when validating and registering a repository.

The default policy requires independent review and human approval, disables automatic merge and deployment, allows at most 2 global active executions, 1 active execution per repository, 3 attempts, and a command timeout of at most 3,600,000 ms. Repository overrides may lower ceilings or add check names. They cannot remove central checks, raise ceilings, disable review/approval, or enable merge/deployment. Even central policy cannot turn on those unsafe gates in schema v1.

The resolved policy is normalized into the registered configuration and also retained as a separate policy snapshot. Registration uses canonical content hashes: identical effective configuration and policy are idempotent; a changed repository/environment/branch/policy binding is rejected rather than silently replaced. Changing the policy file later does not retroactively rewrite an existing registration. The [scoped update procedure](#add-required-ci-checks-to-a-configured-repository) can strengthen the registered required-check list while retaining every other normalized field and the existing policy snapshot. Runtime account-wide scheduling and delivery-gate enforcement are separate responsibilities, not established by this configuration layer.

## Operator commands

Run these from the factory repository, replacing placeholders with reviewed paths and IDs:

```sh
FACTORY_CONFIG='/absolute/path/to/application/.factory.yaml'
FACTORY_POLICY='/absolute/private/path/factory-policy.yaml'
FACTORY_COMPANY='<active Paperclip company UUID>'
FACTORY_REPOSITORY='owner/repository'

"$FACTORY_NODE" scripts/factory.mjs repo validate \
  --config "$FACTORY_CONFIG" --policy "$FACTORY_POLICY" --json

"$FACTORY_NODE" scripts/factory.mjs repo add \
  --config "$FACTORY_CONFIG" --policy "$FACTORY_POLICY" --json

"$FACTORY_NODE" scripts/factory.mjs repo list --json
"$FACTORY_NODE" scripts/factory.mjs repo status "$FACTORY_REPOSITORY" --json

"$FACTORY_NODE" scripts/factory.mjs repo bootstrap \
  --config "$FACTORY_CONFIG" --policy "$FACTORY_POLICY" \
  --company "$FACTORY_COMPANY" --dry-run --json

"$FACTORY_NODE" scripts/factory.mjs repo validate \
  --config "$FACTORY_CONFIG" --policy "$FACTORY_POLICY" \
  --online --company "$FACTORY_COMPANY" --json

"$FACTORY_NODE" scripts/factory.mjs repo bootstrap "$FACTORY_REPOSITORY" \
  --company "$FACTORY_COMPANY" --json
```

Local validation returns `configuration_valid` with `accessChecked: false`; it makes no service calls and executes no repository commands. `repo add` writes the normalized config to the local registry only. The dry run prints the provisioning plan without external writes or Cloud submissions; it is not an online-access check. Real bootstrap uses the **registered snapshot**, not a subsequently edited source file, and accepts no replacement `--config`/`--policy`.

By default the registry lives at `~/.paperclip/instances/factory/repositories/registry.sqlite` and private generated files under `~/.paperclip/instances/factory/onboarding/`. `--registry`, `--private-dir` and `--factory-root` select explicit storage/root locations. Online commands accept `--node`, `--paperclip`, `--codex`, `--github` and `--api-base`; use `--help` for the current complete flag list. Keep executable paths absolute and use only a loopback HTTP API origin. JSON result/error output is suitable for scripts; failures exit 1. `approval_required` also exits 1 because hiring remains incomplete.

### What online inspection proves

`inspectRepository` checks exact pinned executable versions, active company access, GitHub repository identity/default branch/archive status, the published branch SHA, configured hosted check-name availability, ChatGPT sign-in, and a filtered Cloud list observation with a matching repository environment label. Check names are discovered from check runs and legacy status contexts on the base, then at most five recent same-repository PR heads targeting that base branch. This supports PR-only checks without claiming their execution passed. It does not create an environment or submit a task. An empty list or unverifiable label produces an attention state rather than guessing a mapping.

Configured check-name **presence** does not prove success, branch protection, or CI for future work. An empty required-check list does not verify tests. A Cloud label is the available CLI mapping evidence; the current contract permits a null `environment_id` and exposes no structured repository binding. Do not turn list visibility into proof of a successful coding task.

Record the full base SHA from the GitHub branch observation when approving each task. Newly registered code-change dispatchers require exactly one standalone task-description header:

```text
Factory base SHA: <approved full 40-character lowercase hexadecimal commit>
```

Replace the placeholder before assignment. A missing or duplicated header is rejected before Cloud work. The dispatcher checks it again against the task returned by checkout, injects the immutable base and configured commands/gates into the versioned implementer role, and asks the remote task to verify its initial HEAD. It still submits a published branch name; a changed branch tip must cause the remote task to stop rather than silently choose another base. A checkout named `work` proves no base identity or ancestry. Legacy dispatch configurations keep their earlier generic/read-only prompt path. See the [Cloud contract](codex-cloud/README.md), [roles](../roles/README.md) and [demo procedure](single-repository-demo.md).

### Provisioning and ambiguous outcomes

Bootstrap creates a marked Paperclip project, a primary Git workspace bound to the registered repository/ref, private immutable `dispatch.json` and `task-contract.json`, and one process dispatcher agent. Its scheduled heartbeats are disabled and maximum concurrent local runs is 1. It does not create/assign a task, wake an agent or submit Cloud work. If hiring needs Board approval, it reports `approval_required`; it does not approve its own agent.

A SQLite operation record commits creation intent before each external write. Project/workspace/agent ownership markers and stored IDs are checked on later invocations. Compare-and-swap revisions prevent two owners from both sending the same create stage. When a create response is lost, a retry first reads for the exact owned marker; it may recover an observed object but never treats absence as permission to resend an uncertain creation. `BOOTSTRAP_OUTCOME_UNKNOWN`, duplicate markers or changed bindings require investigation. Do not delete the registry, manually recreate objects or reset operation state to force a retry.

Ownership is read through `agent get`. The pinned release deliberately omits metadata from `agent configuration`; that response independently verifies the same agent identity, status, adapter and heartbeat fields.

`configured` means these bindings/configuration were provisioned and inspected. `repo status` explicitly reports `operationalVerified: false`. The outstanding gates remain remote execution, configured command outcomes, CI, independent review, human approval, and global concurrency. The generated dispatcher validates the registered repository/environment/branch/policy and consumes commands/gates through the implementer role; injecting instructions does not machine-verify that remote checks ran or passed. Role reports remain agent claims until separately verified. No complete automatic review/repair pipeline or recovery-controller service is installed by bootstrap.

### Add required CI checks to a configured repository

`factory repo update` is a scoped, local configuration update for an already configured repository. Its first version permits **additions to `delivery.requiredChecks` only**: the candidate must retain every current effective required check, and every other normalized field and the registered central policy must remain unchanged. Removing checks, changing commands or budgets, or replacing repository/environment/branch bindings is unsupported. There is no force flag. Editing the source YAML alone does not update a registered dispatcher, and deleting/re-registering private state is not an update procedure.

Choose checks that actually run the intended application tests at the PR head. A marker such as Story Keeper's `receipt` is evidence of workflow presence/freshness, not application-test success. Retain it when adding real test checks. Enabling or changing an application's CI still requires that repository's maintainer decision; this command neither enables CI nor runs tests. Its read-only online preflight discovers the proposed hosted check names, which does not prove that they passed or will run at a future head. The review pipeline's `--test-check` names must identify actual test checks among the resulting required checks.

Before applying, coordinate the account-wide pause with the operator and other repositories. Record the current registered configuration hash, actual scheduler directory, and prior pause state. Pause admission durably and inspect all account work. For the repository being updated, the command requires no queued, held, admitted, submitted, active or unknown executions; no unfinished review pipeline or ambiguous intent; and idle/live-run verification for every owned implementation/reviewer/QA/repair agent. Resolve unfinished work through its existing identity rather than deleting journals, fences or intents. Completed history is retained.

Quiesce custom factory processes before opening existing stores with this release: stop the owned controller service and any foreground controller runners, and confirm all owned dispatcher/review agent runs have ended. The update release uses registry and scheduler schema **2**. Compatible older stores can be upgraded when opened, including during a dry run; older factory code then refuses the newer schema. A schema-version change does not revoke database handles already open in an older process. Restart every custom factory controller/dispatcher/review process from the updated factory commit before permitting work again. Keep this process change separate from restarting the Paperclip server or PostgreSQL.

Run from the factory checkout, substituting the actual registered values:

```sh
FACTORY_REPOSITORY='owner/repository'
FACTORY_CANDIDATE='/absolute/private/path/candidate.factory.yaml'
FACTORY_OLD_CONFIG_HASH='<current registered 64-character configuration hash>'
FACTORY_SCHEDULER='/absolute/private/path/to/the/registered/scheduler'

"$FACTORY_NODE" scripts/factory.mjs scheduler pause \
  --directory "$FACTORY_SCHEDULER" --json
"$FACTORY_NODE" scripts/factory.mjs scheduler status \
  --directory "$FACTORY_SCHEDULER" --json

# Dry run is the default; --dry-run makes that choice explicit.
"$FACTORY_NODE" scripts/factory.mjs repo update "$FACTORY_REPOSITORY" \
  --config "$FACTORY_CANDIDATE" --expected-config-hash "$FACTORY_OLD_CONFIG_HASH" \
  --dry-run --json

# Apply only the reviewed candidate against that exact old registration.
"$FACTORY_NODE" scripts/factory.mjs repo update "$FACTORY_REPOSITORY" \
  --config "$FACTORY_CANDIDATE" --expected-config-hash "$FACTORY_OLD_CONFIG_HASH" \
  --apply --json
```

Use `--registry /absolute/registry/directory` on both update invocations when the registration is outside the default registry. The command uses the existing registered policy; it accepts no replacement `--policy`. A dry run plans and checks prerequisites without creating an update intent or publishing configuration. Opening compatible local stores can upgrade SQLite metadata, tighten permissions or create bookkeeping sidecars; dry run is not a promise of zero local filesystem writes. Applying changes only private local configuration, registry and scheduler state. It preserves native company/project/workspace/agent IDs and adapters; it does not hire agents, create native tasks, send Paperclip writes, wake an agent or submit Cloud work.

Applying records a durable update intent before replacing generated main and review configuration files. Each replacement is atomic and fsynced; recovery accepts only the recorded exact old or new bytes. An admission fence rejects old or missing generated configuration, including after an account resume, until the update is complete. This is a recoverable multi-file update, not a claim that all files change in one filesystem operation.

If interrupted, rerun the **same** `repo update ... --apply` command with the same candidate and original `--expected-config-hash`; it recovers that recorded intent. Unknown file bytes or changed bindings require investigation. Do not edit generated files manually, delete the update record, clear the fence, or invent a new old hash to force progress. The account remains paused after completion. Inspect the resulting registration, generated configuration and scheduler state, restart the intended custom controller using the updated commit, then coordinate any separate `scheduler resume --directory "$FACTORY_SCHEDULER" --json` with the operator and the recorded prior pause state. Updating check requirements is not approval to dispatch work.

This procedure does not claim a live Story Keeper configuration update. Its actual registered checks remain unchanged until an operator completes and verifies that separate update.

## Module boundaries and verification

`lib/repository-config.mjs` exports `parseRepositoryConfig`, `loadRepositoryConfig`, `validateRepositoryConfig`, `parseFactoryPolicy`, `loadFactoryPolicy`, and `validateFactoryPolicy`. These functions parse/validate/normalize data; they do not execute commands or contact services.

`RepositoryRegistry` in `lib/repository-registry.mjs` persists normalized registrations and bootstrap state, with `register`, `get`, `list`, `getOperation`, `beginOperation`, `updateOperation`, and `close`. `configurationHash` canonically hashes configuration data. `buildOnboardingPlan`, `inspectRepository`, and `bootstrapRepository` in `lib/repository-onboarding.mjs` separate planning, read-only prerequisites, and external provisioning. The CLI exposes those boundaries through `runFactoryCli`.

Run the configuration, registry, CLI/provisioning and role-dispatch tests with the supported Node runtime:

```sh
"$FACTORY_NODE" --test tests/repository-config.test.mjs tests/repository-registry.test.mjs tests/repository-onboarding.test.mjs tests/factory-cli.test.mjs tests/factory-dispatch-contract.test.mjs tests/agent-roles.test.mjs
"$FACTORY_NODE" --test tests/*.test.mjs
git diff --check
```

On 2026-11-03, the expanded core Node 24.15.0 suite passed **344/344 tests**, including scheduler, controller and MCP; whitespace checks were clean. The login-service work was explicitly excluded. [Live evidence](evidence/epic-implementation-2026-11-03.md) records real Story Keeper provisioning, idle reconciliation and MCP draft creation. Cloud code/test results, unattended coding progression, physical Mac recovery and the two-repository proof remain unverified. Track those requirements in the [epic acceptance audit](epic-status.md).
