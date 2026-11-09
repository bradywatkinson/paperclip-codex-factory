import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cloudEnvironment, runCommand, validateProjectConfig } from './cloud-dispatch.mjs';
import { configurationHash } from './repository-registry.mjs';
import { validateFactoryPolicy } from './repository-config.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PINNED = { node: 'v24.15.0', codex: 'codex-cli 0.167.0', paperclip: '2026.1023.0' };
export class OnboardingError extends Error {
  constructor(code) { super(code); this.name = 'OnboardingError'; this.code = code; }
}
const fail = code => { throw new OnboardingError(code); };
function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') fail('INVALID_ONBOARDING_RUNTIME');
  const result = { ...runtime };
  for (const key of ['nodeCommand', 'paperclipCommand', 'codexCommand', 'githubCommand', 'factoryRoot', 'privateDir']) {
    if (typeof result[key] !== 'string' || !path.isAbsolute(result[key]) || /[\0\r\n]/.test(result[key])) fail('INVALID_ONBOARDING_PATH');
  }
  let api;
  try { api = new URL(result.apiBase ?? 'http://127.0.0.1:8100'); } catch { fail('INVALID_API_ORIGIN'); }
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) || api.username || api.password || api.pathname !== '/' || api.search || api.hash) fail('INVALID_API_ORIGIN');
  result.apiBase = api.origin;
  return result;
}
function registrationConfig(registration) {
  if (!registration?.config || registration.configHash !== configurationHash(registration.config)) fail('REGISTRY_CONFIG_CHANGED');
  if (registration.repository !== registration.config.repository.toLowerCase()) fail('REGISTRY_CONFIG_CHANGED');
  return registration.config;
}
export function buildOnboardingPlan({ registration, companyId, runtime }) {
  const config = registrationConfig(registration), r = validateRuntime(runtime);
  if (!UUID.test(companyId ?? '')) fail('INVALID_COMPANY_ID');
  const directory = path.join(r.privateDir, 'repositories', configurationHash(registration.repository).slice(0, 24));
  return {
    schemaVersion: 1, repository: registration.repository, configHash: registration.configHash,
    companyId, runtime: r,
    project: { name: 'Factory: ' + config.repository, status: 'backlog' },
    workspace: { name: config.repository, sourceType: 'git_repo', repoUrl: 'https://github.com/' + config.repository, repoRef: config.defaultBranch, defaultRef: config.defaultBranch, isPrimary: true },
    dispatchConfigPath: path.join(directory, 'dispatch.json'),
    taskContractPath: path.join(directory, 'task-contract.json'),
    schedulerDirectory: path.join(r.privateDir, 'scheduler'),
    journalRootDirectory: path.join(path.dirname(r.privateDir), 'data/cloud-dispatch'),
    journalDirectory: path.join(path.dirname(r.privateDir), 'data/cloud-dispatch', companyId),
    taskContract: { schemaVersion: 1, repository: config.repository, configHash: registration.configHash, policy: validateFactoryPolicy(registration.policy), commands: config.commands, delivery: config.delivery, concurrency: config.concurrency, secretRefs: config.secretRefs },
    // These gates are retained as configuration, not claimed as verified by setup.
    outstandingGates: ['remote_execution', 'configured_commands', 'ci', 'independent_review', 'human_approval', 'global_concurrency'],
  };
}
export function buildRegisteredDispatchConfig({ registration, companyId, projectId, workspaceId, plan }) {
  return validateProjectConfig({
    schemaVersion: 1, companyId, projectId, workspaceId,
    repository: registration.config.repository, environmentId: registration.config.cloud.environmentId,
    branch: registration.config.defaultBranch, mode: 'code_change', codexCommand: plan.runtime.codexCommand,
    attempt: 1, dispatchTimeoutMs: 60000,
    factoryConfig: registration.config, factoryPolicy: validateFactoryPolicy(registration.policy),
    schedulerDirectory: plan.schedulerDirectory, stateDirectory: plan.journalDirectory, journalRootDirectory: plan.journalRootDirectory,
  });
}
function runner(runtime, run, env) {
  const childEnv = cloudEnvironment(env), pcEnv = { ...childEnv, PAPERCLIP_TELEMETRY_DISABLED: '1' };
  for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') pcEnv[key] = env[key];
  // gh uses its own normal credential store; it receives no Paperclip/run bearer.
  const ghEnv = { ...childEnv };
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (typeof env[key] === 'string') ghEnv[key] = env[key];
  const execute = async (kind, args, json = false) => {
    let response;
    try { response = await run(runtime[kind + 'Command'], args, { env: kind === 'paperclip' ? pcEnv : kind === 'github' ? ghEnv : childEnv, timeoutMs: 15000, maxOutputBytes: 1_000_000 }); }
    catch { fail(kind.toUpperCase() + '_COMMAND_FAILED'); }
    if (response?.code !== 0 || response?.timedOut || response?.failedToStart || response?.outputExceeded || response?.signal) fail(kind.toUpperCase() + '_COMMAND_FAILED');
    const output = response.stdout ?? '';
    if (typeof output !== 'string' || Buffer.byteLength(output) > 1_000_000) fail(kind.toUpperCase() + '_OUTPUT_LIMIT');
    if (!json) return { stdout: output, stderr: response.stderr ?? '' };
    try { return JSON.parse(output); } catch { fail('INVALID_' + kind.toUpperCase() + '_RESPONSE'); }
  };
  return {
    execute,
    pc: args => execute('paperclip', [...args, '--api-base', runtime.apiBase, '--json'], true),
    gh: resource => execute('github', ['api', '--method', 'GET', resource], true),
  };
}
async function inspectRequiredCheckNames({ gh, config, baseSha }) {
  const required = config.delivery.requiredChecks;
  if (!required.length) return { configured: [], scope: 'No hosted CI checks configured; this does not verify tests.', ciOutcomeVerified: false };
  if (!/^[a-f0-9]{40}$/.test(baseSha ?? '')) fail('GITHUB_BRANCH_UNVERIFIED');
  const repository = config.repository.toLowerCase(), observations = [], scannedCommits = new Set();
  const validName = value => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  const observeCommit = async (commitSha, pullRequestNumber) => {
    if (scannedCommits.has(commitSha)) return;
    scannedCommits.add(commitSha);
    for (const source of ['check_run', 'commit_status']) {
      const rows = [], seen = new Set(); let total;
      for (let page = 1; page <= 3; page++) {
        const resource = 'repos/' + config.repository + '/commits/' + commitSha + (source === 'check_run' ? '/check-runs?filter=latest&per_page=100&page=' : '/status?per_page=100&page=') + page;
        const response = await gh(resource), values = source === 'check_run' ? response?.check_runs : response?.statuses;
        if (!Array.isArray(values) || values.length > 100 || !Number.isSafeInteger(response.total_count) || response.total_count < 0 || (total !== undefined && total !== response.total_count)) fail('GITHUB_CHECKS_INCOMPLETE');
        if (source === 'commit_status' && (response.sha !== commitSha || response.repository?.full_name?.toLowerCase() !== repository)) fail('GITHUB_CHECKS_INCOMPLETE');
        total = response.total_count;
        for (const row of values) {
          const name = source === 'check_run' ? row?.name : row?.context;
          if (!Number.isSafeInteger(row?.id) || row.id < 1 || seen.has(row.id) || !validName(name) || (source === 'check_run' && row.head_sha !== commitSha)) fail('GITHUB_CHECKS_INCOMPLETE');
          seen.add(row.id); rows.push(name);
        }
        if (rows.length === total) break;
        if (rows.length > total || values.length < 100 || page === 3) fail('GITHUB_CHECKS_INCOMPLETE');
      }
      for (const name of new Set(rows)) if (required.includes(name)) observations.push({ name, source, commitSha, ...(pullRequestNumber ? { pullRequestNumber } : {}) });
    }
  };
  const missing = () => required.some(name => !observations.some(row => row.name === name));
  await observeCommit(baseSha);
  let recentPullRequestsInspected = 0;
  if (missing()) {
    const recent = await gh('repos/' + config.repository + '/pulls?state=all&base=' + encodeURIComponent(config.defaultBranch) + '&sort=updated&direction=desc&per_page=5&page=1');
    if (!Array.isArray(recent) || recent.length > 5) fail('GITHUB_PR_DISCOVERY_INCOMPLETE');
    const numbers = new Set();
    // Validate the bounded returned inventory before accepting any evidence.
    for (const pr of recent) {
      if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || numbers.has(pr.number) || pr.base?.repo?.full_name?.toLowerCase() !== repository || pr.base.ref !== config.defaultBranch || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '') || typeof pr.head?.repo?.full_name !== 'string') fail('GITHUB_PR_DISCOVERY_INCOMPLETE');
      numbers.add(pr.number);
    }
    for (const pr of recent) {
      if (pr.head.repo.full_name.toLowerCase() !== repository) continue;
      recentPullRequestsInspected++;
      await observeCommit(pr.head.sha, pr.number);
      if (!missing()) break;
    }
  }
  if (missing()) fail('GITHUB_REQUIRED_CHECK_MISSING');
  return { configured: required, observations, scannedCommits: [...scannedCommits], recentPullRequestsInspected, ciOutcomeVerified: false,
    scope: 'Observed check name availability on inspected immutable commits; not CI/test success, branch protection, or acceptance for future work.' };
}
export async function inspectRepository({ registration, companyId, runtime, run = runCommand, env = process.env }) {
  const plan = buildOnboardingPlan({ registration, companyId, runtime }), config = registration.config;
  const { execute, pc, gh } = runner(plan.runtime, run, env), checks = [];
  let baseSha;
  const check = async (name, action) => {
    try { const details = await action(); checks.push({ name, status: 'passed', ...(details ?? {}) }); }
    catch (error) { checks.push({ name, status: 'failed', code: error instanceof OnboardingError ? error.code : 'ONBOARDING_CHECK_FAILED' }); }
  };
  await check('factory_runtime', async () => {
    const entrypoint = path.join(plan.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs');
    try {
      if (!fs.statSync(entrypoint).isFile()) fail('FACTORY_DISPATCHER_UNAVAILABLE');
      fs.accessSync(entrypoint, fs.constants.R_OK);
    } catch { fail('FACTORY_DISPATCHER_UNAVAILABLE'); }
    return { entrypoint };
  });
  await check('versions', async () => {
    for (const kind of ['node', 'paperclip', 'codex']) {
      const result = await execute(kind, ['--version']);
      if (result.stdout.trim() !== PINNED[kind]) fail('UNSUPPORTED_' + kind.toUpperCase() + '_VERSION');
    }
    return { versions: { ...PINNED } };
  });
  await check('paperclip_company', async () => {
    const company = await pc(['company', 'get', companyId]);
    if (company?.id !== companyId || company.status !== 'active') fail('COMPANY_SCOPE_MISMATCH');
    return { hireApprovalRequired: company.requireBoardApprovalForNewAgents === true };
  });
  await check('github_repository', async () => {
    const repository = await gh('repos/' + config.repository);
    if (repository?.full_name?.toLowerCase() !== config.repository.toLowerCase() || repository.default_branch !== config.defaultBranch || repository.archived === true || repository.disabled === true) fail('GITHUB_REPOSITORY_MISMATCH');
    const branch = await gh('repos/' + config.repository + '/branches/' + encodeURIComponent(config.defaultBranch));
    if (branch?.name !== config.defaultBranch || !/^[a-f0-9]{40}$/.test(branch.commit?.sha ?? '')) fail('GITHUB_BRANCH_UNVERIFIED');
    baseSha = branch.commit.sha;
    return { baseSha };
  });
  await check('github_required_checks', () => inspectRequiredCheckNames({ gh, config, baseSha }));
  await check('codex_authentication', async () => {
    const auth = await execute('codex', ['login', 'status']);
    if (!/Logged in using ChatGPT/.test(auth.stdout + '\n' + auth.stderr)) fail('CODEX_CHATGPT_LOGIN_REQUIRED');
  });
  await check('cloud_environment', async () => {
    const result = await execute('codex', ['cloud', 'list', '--env', config.cloud.environmentId, '--limit', '1', '--json'], true);
    if (!Array.isArray(result?.tasks) || result.tasks.length > 1 || !(result.cursor === null || typeof result.cursor === 'string')) fail('INVALID_CODEX_RESPONSE');
    if (!result.tasks.length) fail('CLOUD_MAPPING_UNVERIFIED');
    const task = result.tasks[0];
    if (!/^task_e_[a-f0-9]{32}$/.test(task?.id ?? '')) fail('INVALID_CODEX_RESPONSE');
    if (task.environment_id !== null && task.environment_id !== config.cloud.environmentId) fail('CLOUD_ENVIRONMENT_MISMATCH');
    if (typeof task.environment_label !== 'string' || task.environment_label.toLowerCase() !== config.repository.toLowerCase()) fail('CLOUD_MAPPING_UNVERIFIED');
    return { environmentId: config.cloud.environmentId, mappingEvidence: 'matching_environment_label_in_filtered_list' };
  });
  return { status: checks.every(item => item.status === 'passed') ? 'validated' : 'needs_attention', repository: registration.repository, configHash: registration.configHash, checks };
}
function same(value, expected) { return isDeepStrictEqual(value, expected); }
function checkRecord(record, companyId) { if (!UUID.test(record?.id ?? '') || record.companyId !== companyId) fail('PAPERCLIP_SCOPE_MISMATCH'); }
function immutableJson(filename, value) {
  const directory = path.dirname(filename), content = JSON.stringify(value, null, 2) + '\n';
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) fail('BOOTSTRAP_UNSAFE_DIRECTORY');
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(filename, 'utf8') !== content) fail('BOOTSTRAP_CONFIGURATION_CONFLICT');
    return;
  }
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export async function bootstrapRepository({ registry, repository, companyId, runtime, run = runCommand, dryRun = false, env = process.env }) {
  const registration = registry.get(repository);
  if (!registration) fail('REPOSITORY_NOT_REGISTERED');
  const plan = buildOnboardingPlan({ registration, companyId, runtime }), planHash = configurationHash(plan);
  let operation = registry.getOperation(repository);
  if (operation && (operation.data.companyId !== companyId || operation.data.planHash !== planHash || !UUID.test(operation.data.operationId ?? ''))) fail('BOOTSTRAP_BINDING_CHANGED');
  if (dryRun) return { status: 'planned', dryRun: true, plan, operation };
  const validation = await inspectRepository({ registration, companyId, runtime, run, env });
  if (validation.status !== 'validated') return { status: 'needs_attention', validation, plan };
  const { pc } = runner(plan.runtime, run, env);
  if (!operation) {
    operation = registry.beginOperation(repository, { expectedConfigHash: registration.configHash, state: 'planned', data: { companyId, planHash, plan, operationId: randomUUID() } });
  }
  const marker = { registrationId: operation.data.operationId, repository: registration.repository };
  const projectMarker = 'factory-onboarding-v1:' + marker.registrationId + ':' + marker.repository;
  const checkpoint = (state, data) => { operation = registry.updateOperation(repository, { expectedRevision: operation.revision, state, data }); };
  const owned = value => same(value?.metadata?.factory, marker);
  const requireArray = value => { if (!Array.isArray(value)) fail('INVALID_PAPERCLIP_RESPONSE'); return value; };
  const recoverOrCreate = async ({ kind, idKey, list, matches, verify, create }) => {
    const rows = requireArray(await list());
    const candidates = rows.filter(matches);
    if (candidates.length > 1) fail('BOOTSTRAP_DUPLICATE_MARKERS');
    const knownId = operation.data[idKey];
    if (knownId) {
      const record = rows.find(row => row.id === knownId);
      if (!record || !matches(record)) fail('BOOTSTRAP_RESOURCE_CHANGED');
      verify(record); return record;
    }
    if (candidates.length === 1) {
      const record = candidates[0]; verify(record);
      const data = { ...operation.data, [idKey]: record.id }; delete data.pending;
      checkpoint('configuring', data); return record;
    }
    if (operation.data.pending) {
      if (operation.data.pending.kind !== kind) fail('BOOTSTRAP_PENDING_STAGE_MISMATCH');
      fail('BOOTSTRAP_OUTCOME_UNKNOWN');
    }
    // Only the caller winning this CAS may send this creation request. A later
    // invocation recovers by reads; absence is never permission to resend it.
    checkpoint('sending', { ...operation.data, pending: { kind, marker: kind === 'project' ? projectMarker : marker } });
    let record;
    try { record = await create(); verify(record); if (!matches(record)) fail('BOOTSTRAP_RESOURCE_CHANGED'); }
    catch { return fail('BOOTSTRAP_OUTCOME_UNKNOWN'); }
    const data = { ...operation.data, [idKey]: record.id }; delete data.pending;
    checkpoint('configuring', data); return record;
  };
  try {
    const project = await recoverOrCreate({
      kind: 'project', idKey: 'projectId', list: () => pc(['project', 'list', '--company-id', companyId]),
      matches: row => row.description === projectMarker,
      verify: row => { checkRecord(row, companyId); if (row.archivedAt || row.name !== plan.project.name) fail('BOOTSTRAP_RESOURCE_CHANGED'); },
      create: () => pc(['project', 'create', '--company-id', companyId, '--name', plan.project.name, '--description', projectMarker, '--status', plan.project.status]),
    });
    const workspace = await recoverOrCreate({
      kind: 'workspace', idKey: 'workspaceId', list: () => pc(['project-workspace', 'list', project.id]), matches: owned,
      verify: row => { checkRecord(row, companyId); if (row.projectId !== project.id || row.sourceType !== 'git_repo' || row.repoUrl !== plan.workspace.repoUrl || row.repoRef !== plan.workspace.repoRef || row.defaultRef !== plan.workspace.defaultRef || row.isPrimary !== true || row.setupCommand || row.cleanupCommand) fail('BOOTSTRAP_RESOURCE_CHANGED'); },
      create: () => pc(['project-workspace', 'create', project.id, '--payload-json', JSON.stringify({ ...plan.workspace, metadata: { factory: marker } })]),
    });
    const dispatchConfig = buildRegisteredDispatchConfig({ registration, companyId, projectId: project.id, workspaceId: workspace.id, plan });
    immutableJson(plan.dispatchConfigPath, dispatchConfig);
    immutableJson(plan.taskContractPath, plan.taskContract);
    if (!operation.data.configurationWritten) checkpoint('configuring', { ...operation.data, configurationWritten: true });
    const adapterConfig = { command: plan.runtime.nodeCommand, args: [path.join(plan.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'), '--config', plan.dispatchConfigPath], cwd: plan.runtime.factoryRoot, timeoutSec: 180, graceSec: 10 };
    const runtimeConfig = { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } };
    const agent = await recoverOrCreate({
      kind: 'agent', idKey: 'agentId', list: () => pc(['agent', 'list', '--company-id', companyId]), matches: owned,
      verify: row => { checkRecord(row, companyId); if (row.adapterType !== 'process' || ['terminated', 'error'].includes(row.status)) fail('BOOTSTRAP_RESOURCE_CHANGED'); },
      create: () => pc(['agent', 'create', '--company-id', companyId, '--payload-json', JSON.stringify({ name: 'Factory Dispatcher: ' + registration.config.repository, role: 'engineer', adapterType: 'process', adapterConfig, runtimeConfig, permissions: { canCreateAgents: false, canCreateSkills: false }, metadata: { factory: marker } })]),
    });
    // Native configuration is a projection with no metadata. Verify ownership
    // through a fresh supported agent read, then verify the configuration by ID.
    const currentAgent = await pc(['agent', 'get', agent.id]);
    checkRecord(currentAgent, companyId);
    if (currentAgent.id !== agent.id || !owned(currentAgent) || currentAgent.adapterType !== 'process' || ['terminated', 'error'].includes(currentAgent.status)) fail('BOOTSTRAP_RESOURCE_CHANGED');
    const agentConfiguration = await pc(['agent', 'configuration', agent.id]);
    checkRecord(agentConfiguration, companyId);
    if (agentConfiguration.id !== agent.id || agentConfiguration.adapterType !== 'process' || ['terminated', 'error'].includes(agentConfiguration.status) || !same(agentConfiguration.adapterConfig, adapterConfig) || !same(agentConfiguration.runtimeConfig?.heartbeat, runtimeConfig.heartbeat)) fail('BOOTSTRAP_RESOURCE_CHANGED');
    const status = agentConfiguration.status === 'pending_approval' ? 'approval_required' : 'configured';
    checkpoint(status, { ...operation.data, validation });
    return { status, operation, plan, validation, outstandingGates: plan.outstandingGates };
  } catch (error) {
    if (!(error instanceof OnboardingError)) throw error;
    return { status: 'needs_attention', code: error.code, operation, plan, validation };
  }
}
