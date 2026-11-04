#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepositoryConfig, loadFactoryPolicy, validateFactoryPolicy, RepositoryConfigError } from '../lib/repository-config.mjs';
import { RepositoryRegistry, RegistryError, configurationHash } from '../lib/repository-registry.mjs';
import { buildOnboardingPlan, bootstrapRepository, inspectRepository } from '../lib/repository-onboarding.mjs';
import { updateRepositoryConfiguration } from '../lib/repository-update.mjs';

const HELP = `Usage:
  factory scheduler --help
  factory controller --help
  factory controller service --help
  factory delivery inspect --help
  factory review --help
  factory repo validate [--config .factory.yaml] [--policy POLICY] [--online --company UUID] [--json]
  factory repo add [--config .factory.yaml] [--policy POLICY] [--registry DIRECTORY] [--json]
  factory repo list [--registry DIRECTORY] [--json]
  factory repo status OWNER/REPO [--registry DIRECTORY] [--json]
  factory repo update OWNER/REPO --config FILE --expected-config-hash SHA [--dry-run|--apply] [--registry DIRECTORY] [--json]
  factory repo bootstrap --config FILE --company UUID --dry-run [--json]
  factory repo bootstrap OWNER/REPO --company UUID [--registry DIRECTORY] [--json]

Online checks/bootstrap accept --node, --paperclip, --codex, --github, --api-base,
--private-dir, and --factory-root with absolute paths where applicable.
Validation never executes repository commands. Bootstrap never submits Cloud work.
Update defaults to dry-run and only adds required CI checks. Account admission
must stay paused and the repository must be idle; no Cloud/native writes occur.
`;
const VALUE_FLAGS = new Set(['--config', '--policy', '--registry', '--company', '--node', '--paperclip', '--codex', '--github', '--api-base', '--private-dir', '--factory-root', '--expected-config-hash']);
const BOOL_FLAGS = new Set(['--json', '--online', '--dry-run', '--apply']);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function commandOnPath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* Try next PATH entry. */ }
  }
  return path.join('/usr/local/bin', name);
}
const advice = {
  REPOSITORY_NOT_REGISTERED: 'Run factory repo add --config PATH first.',
  REPOSITORY_ALREADY_REGISTERED_WITH_DIFFERENT_CONFIG: 'Use factory repo update for an explicit additive required-check change. Preserve existing registration and history.',
  CONFIGURATION_UPDATE_SCOPE_UNSUPPORTED: 'Only adding delivery.requiredChecks is supported. Keep all existing checks, policy, identity and other fields unchanged.',
  CONFIGURATION_UPDATE_REQUIRES_PAUSE: 'Pause account admission in the registered scheduler before updating; the command never resumes it.',
  SCHEDULER_CONFIGURATION_UPDATE_REQUIRES_PAUSE: 'Pause account admission in the registered scheduler before updating; the command never resumes it.',
  CONFIGURATION_UPDATE_EXECUTIONS_NOT_IDLE: 'Reconcile existing queued, held, active or unknown executions before updating. Do not reset their receipts.',
  CONFIGURATION_UPDATE_REVIEW_NOT_IDLE: 'Resolve unfinished review pipelines or ambiguous role/task/workspace writes before updating.',
  CONFIGURATION_UPDATE_FILE_CHANGED: 'The update remains fenced. Inspect unexpected private file bytes; do not force, delete history or re-register.',
  CONFIGURATION_UPDATE_CONFLICT: 'Inspect factory repo status and retry the exact interrupted command with its original expected hash.',
  REGISTRY_CONFIG_CHANGED: 'Read factory repo status and compare its config hash with the expected hash; do not overwrite another update.',
  BOOTSTRAP_OPERATION_CONFLICT: 'Another bootstrap updated this operation. Re-run to inspect its durable state; do not recreate objects manually.',
  BOOTSTRAP_OPERATION_EXISTS: 'Inspect factory repo status before retrying.',
  USAGE_FACTORY: 'Use factory --help for supported commands.',
};
const usageError = () => Object.assign(new Error('USAGE_FACTORY'), { code: 'USAGE_FACTORY' });
function parse(args) {
  if (args.length === 0 || args.includes('--help')) return { help: true };
  if (args[0] !== 'repo' || !['validate', 'add', 'list', 'status', 'bootstrap', 'update'].includes(args[1])) throw usageError();
  const values = new Map(), positionals = [];
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (values.has(flag)) throw usageError();
    if (BOOL_FLAGS.has(flag)) values.set(flag, true);
    else if (VALUE_FLAGS.has(flag)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw usageError();
      values.set(flag, value);
    } else if (flag.startsWith('--')) throw usageError();
    else positionals.push(flag);
  }
  const command = args[1];
  if (positionals.length > 1 || (['status', 'update'].includes(command) && positionals.length !== 1) || (['validate', 'add', 'list'].includes(command) && positionals.length)) throw usageError();
  if (values.has('--dry-run') && !['bootstrap', 'update'].includes(command)) throw usageError();
  if (values.has('--apply') && command !== 'update' || values.has('--expected-config-hash') && command !== 'update') throw usageError();
  if (command === 'update' && (!values.has('--config') || !values.has('--expected-config-hash') || values.has('--apply') && values.has('--dry-run') || [...values.keys()].some(flag => !['--config', '--expected-config-hash', '--registry', '--json', '--dry-run', '--apply'].includes(flag)))) throw usageError();
  if (values.has('--online') && command !== 'validate') throw usageError();
  if (command === 'bootstrap' && (values.has('--dry-run') ? positionals.length || !values.has('--config') : positionals.length !== 1 || values.has('--config') || values.has('--policy'))) throw usageError();
  return { command, values, repository: positionals[0] };
}
const summary = config => ({ repository: config.repository, defaultBranch: config.defaultBranch, environmentId: config.cloud.environmentId, commands: Object.keys(config.commands), delivery: config.delivery, concurrency: config.concurrency });

export async function runFactoryCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), home = os.homedir(), run } = {}) {
  let registry;
  const json = args.includes('--json');
  try {
    if (args[0] === 'review') {
      const { runFactoryReviewCli } = await import('./factory-review.mjs');
      return await runFactoryReviewCli(args.slice(1), { stdout, stderr, home, ...(run ? { run } : {}) });
    }
    if (args[0] === 'scheduler') {
      const { runSchedulerCli } = await import('./factory-scheduler.mjs');
      return await runSchedulerCli(args.slice(1), { stdout, stderr, home });
    }
    if (args[0] === 'controller' && args[1] === 'service') {
      const { runControllerServiceCli } = await import('./controller-service.mjs');
      return await runControllerServiceCli(args.slice(2), { stdout, stderr, home, ...(run ? { run } : {}) });
    }
    if (args[0] === 'controller') {
      const { runFactoryControllerCli } = await import('./factory-controller.mjs');
      return await runFactoryControllerCli(args.slice(1), { stdout, stderr, home, ...(run ? { run } : {}) });
    }
    if (args[0] === 'delivery' && args[1] === 'inspect') {
      const { runDeliveryCli } = await import('./github-delivery.mjs');
      return await runDeliveryCli(args.slice(2), { stdout, stderr, home, ...(run ? { run } : {}) });
    }
    const parsed = parse(args);
    if (parsed.help) { stdout(HELP); return 0; }
    const { command, values, repository } = parsed;
    const instance = path.join(home, '.paperclip/instances/factory');
    const runtime = {
      nodeCommand: values.get('--node') ?? process.execPath,
      paperclipCommand: values.get('--paperclip') ?? path.join(home, '.local/share/paperclip-factory/bin/paperclipai'),
      codexCommand: values.get('--codex') ?? path.join(home, '.local/bin/codex'),
      githubCommand: values.get('--github') ?? commandOnPath('gh'),
      apiBase: values.get('--api-base') ?? 'http://127.0.0.1:8100',
      privateDir: path.resolve(values.get('--private-dir') ?? path.join(instance, 'onboarding')),
      factoryRoot: path.resolve(values.get('--factory-root') ?? ROOT),
    };
    const emit = result => {
      if (json) stdout(JSON.stringify(result) + '\n');
      else {
        stdout(`${result.status}\n`);
        if (result.repositories) for (const item of result.repositories) stdout(`  ${item.repository}  ${item.bootstrapState}\n`);
        if (result.repository) stdout(`  ${result.repository}\n`);
        if (result.code) stdout(`  ${result.code}${advice[result.code] ? ': ' + advice[result.code] : ''}\n`);
        const checks = result.checks ?? result.validation?.checks;
        if (checks) for (const check of checks) stdout(`  ${check.name}: ${check.status}${check.code ? ' (' + check.code + ')' : ''}\n`);
        if (result.plan) {
          stdout(`  Project: ${result.plan.project.name}\n  Workspace: ${result.plan.workspace.repoUrl} @ ${result.plan.workspace.repoRef}\n`);
          stdout(`  Private dispatcher: ${result.plan.dispatchConfigPath}\n  Private task contract: ${result.plan.taskContractPath}\n`);
          stdout('  No Cloud submission. Use --json to inspect the full plan.\n');
        }
        if (result.bootstrap?.pendingWrite) stdout(`  Unresolved external write: ${result.bootstrap.pendingWrite}; inspect ownership before retrying.\n`);
        if (result.outstandingGates?.length) stdout(`  Pending verification: ${result.outstandingGates.join(', ')}\n`);
        if (result.addedRequiredChecks?.length) stdout(`  Added required checks: ${result.addedRequiredChecks.join(', ')}\n`);
        if (result.accountPaused) stdout('  Account admission stays paused. Resume separately after inspecting the updated bindings.\n');
      }
    };
    if (command === 'validate' || command === 'add' || (command === 'bootstrap' && values.has('--dry-run'))) {
      const policy = values.has('--policy') ? await loadFactoryPolicy(path.resolve(values.get('--policy'))) : undefined;
      const sourcePath = path.resolve(values.get('--config') ?? '.factory.yaml');
      const config = await loadRepositoryConfig(sourcePath, { policy });
      const registration = { repository: config.repository.toLowerCase(), configHash: configurationHash(config), sourcePath, config, policy: validateFactoryPolicy(policy) };
      if (command === 'validate') {
        if (values.has('--online')) {
          if (!values.has('--company')) throw usageError();
          const result = await inspectRepository({ registration, companyId: values.get('--company'), runtime, ...(run ? { run } : {}) });
          emit(result); return result.status === 'validated' ? 0 : 1;
        }
        emit({ status: 'configuration_valid', ...summary(config), configHash: registration.configHash, accessChecked: false }); return 0;
      }
      if (command === 'bootstrap') {
        if (!values.has('--company')) throw usageError();
        const plan = buildOnboardingPlan({ registration, companyId: values.get('--company'), runtime });
        emit({ status: 'dry_run', repository: registration.repository, plan, externalWrites: false, cloudSubmissions: false }); return 0;
      }
      registry = new RepositoryRegistry({ directory: path.resolve(values.get('--registry') ?? path.join(instance, 'repositories')) });
      const result = registry.register(config, { sourcePath, policy });
      emit({ status: result.created ? 'registered' : 'already_registered', ...summary(result.registration.config), configHash: result.registration.configHash }); return 0;
    }
    if (command === 'bootstrap' && !values.has('--company')) throw usageError();
    registry = new RepositoryRegistry({ directory: path.resolve(values.get('--registry') ?? path.join(instance, 'repositories')) });
    if (command === 'list') {
      emit({ status: 'registered_repositories', repositories: registry.list().map(entry => ({ ...summary(entry.config), configHash: entry.configHash, bootstrapState: registry.getOperation(entry.repository)?.state ?? 'not_bootstrapped' })) }); return 0;
    }
    const registration = registry.get(repository);
    if (!registration) throw Object.assign(new Error(), { code: 'REPOSITORY_NOT_REGISTERED' });
    if (command === 'status') {
      const operation = registry.getOperation(repository);
      const update = registry.getConfigurationUpdate(repository);
      emit({ status: operation?.state ?? 'registered', ...summary(registration.config), configHash: registration.configHash,
        bootstrap: operation ? { revision: operation.revision, updatedAt: operation.updatedAt, projectId: operation.data.projectId, workspaceId: operation.data.workspaceId, agentId: operation.data.agentId, pendingWrite: operation.data.pending?.kind } : null,
        ...(update ? { configurationUpdate: { updateId: update.updateId, state: update.state, previousConfigHash: update.previousHash, configHash: update.nextHash } } : {}),
        operationalVerified: false }); return 0;
    }
    if (command === 'update') {
      const sourcePath = path.resolve(values.get('--config'));
      const config = await loadRepositoryConfig(sourcePath, { policy: registration.policy });
      const result = await updateRepositoryConfiguration({ registry, repository, config, sourcePath, expectedConfigHash: values.get('--expected-config-hash'), dryRun: !values.has('--apply'), ...(run ? { run } : {}) });
      emit(result); return result.status === 'needs_attention' ? 1 : 0;
    }
    const result = await bootstrapRepository({ registry, repository, companyId: values.get('--company'), runtime, ...(run ? { run } : {}) });
    emit(result); return result.status === 'configured' ? 0 : 1;
  } catch (error) {
    const code = error instanceof RepositoryConfigError || error instanceof RegistryError || typeof error.code === 'string' ? error.code : 'FACTORY_FAILED';
    const result = { status: 'needs_attention', code, ...(error instanceof RepositoryConfigError ? { field: error.field, message: error.message } : {}), ...(advice[code] ? { correction: advice[code] } : {}) };
    stderr(json ? JSON.stringify(result) + '\n' : `${code}${result.field ? ' at ' + result.field : ''}: ${result.message ?? result.correction ?? 'Inspect configuration and prerequisites; no automatic retry was made.'}\n`);
    return 1;
  } finally { registry?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runFactoryCli(process.argv.slice(2));
