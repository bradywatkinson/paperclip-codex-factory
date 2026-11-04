import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cloudEnvironment, runCommand, validateProjectConfig } from './cloud-dispatch.mjs';
import { configurationHash } from './repository-registry.mjs';
import { DispatchScheduler, SCHEDULER_FILENAME } from './dispatch-scheduler.mjs';
import { buildRegisteredDispatchConfig } from './repository-onboarding.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const APP = 0x46524231;
export class ReviewControllerError extends Error { constructor(code) { super(code); this.name = 'ReviewControllerError'; this.code = code; } }
export const reviewFail = code => { throw new ReviewControllerError(code); };
export const reviewSafeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'REVIEW_CONTROLLER_FAILED';
const syncDirectory = directory => { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
export function reviewImmutableJson(filename, input) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const content = JSON.stringify(input, null, 2) + '\n', temp = filename + '.' + randomUUID() + '.tmp'; let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temp, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(content) || fs.readFileSync(filename, 'utf8') !== content) reviewFail('REVIEW_CONFIG_CONFLICT'); }
    fs.chmodSync(filename, 0o600); syncDirectory(path.dirname(filename));
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); syncDirectory(path.dirname(filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
/** Separate local intents; no source registration or main dispatcher is rewritten. */
export class ReviewRoleBindings {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) reviewFail('REVIEW_STORAGE_UNSAFE');
    const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) reviewFail('REVIEW_STORAGE_UNSAFE');
    fs.chmodSync(directory, 0o700);
    if (firstCreated) for (let cursor = directory;; cursor = path.dirname(cursor)) { syncDirectory(cursor); syncDirectory(path.dirname(cursor)); if (cursor === firstCreated) break; }
    this.directory = directory; const filename = path.join(directory, 'role-bindings.sqlite');
    try { const fd = fs.openSync(filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); syncDirectory(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) reviewFail('REVIEW_STORAGE_UNSAFE'); fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename); this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
    try {
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version, app = this.db.prepare('PRAGMA application_id').get().application_id;
        if (version > 1 || app && app !== APP || version && app !== APP || !version && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) reviewFail('REVIEW_STORAGE_UNSUPPORTED');
        this.db.exec(`CREATE TABLE IF NOT EXISTS intents(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL); PRAGMA user_version=1; PRAGMA application_id=${APP};`);
      }); this.db.exec('PRAGMA journal_mode=WAL'); syncDirectory(directory);
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const value = action(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
  get(key) { const row = this.db.prepare('SELECT * FROM intents WHERE key=?').get(key); return row ? { key: row.key, revision: row.revision, state: row.state, data: JSON.parse(row.data) } : null; }
  list() { return this.db.prepare('SELECT key FROM intents ORDER BY key').all().map(row => this.get(row.key)); }
  begin(key, data, state = 'planned') { return this.transaction(() => { const old = this.get(key); if (old) return { created: false, record: old }; const text = JSON.stringify(data); if (!text || Buffer.byteLength(text) > 128000 || typeof key !== 'string' || key.length > 200) reviewFail('REVIEW_INTENT_INVALID'); this.db.prepare('INSERT INTO intents VALUES(?,0,?,?)').run(key, state, text); return { created: true, record: this.get(key) }; }); }
  update(record, state, data) { return this.transaction(() => { const text = JSON.stringify(data); if (!text || Buffer.byteLength(text) > 128000) reviewFail('REVIEW_INTENT_INVALID'); if (this.db.prepare('UPDATE intents SET revision=revision+1,state=?,data=? WHERE key=? AND revision=?').run(state, text, record.key, record.revision).changes !== 1) reviewFail('REVIEW_INTENT_STALE'); return this.get(record.key); }); }
}
export function buildReviewPlan({ registry, repository }) {
  const registration = registry.get(repository);
  if (!registration) reviewFail('REVIEW_REGISTRATION_NOT_CONFIGURED');
  return registry.withConfigurationGuard(repository, registration.configHash, () => {
    const operation = registry.getOperation(repository), main = operation?.data?.plan;
    if (!registration || operation?.state !== 'configured' || !main || main.repository !== registration.repository || main.configHash !== registration.configHash || operation.data.planHash !== configurationHash(main) || !UUID.test(operation.data.operationId ?? '') || !['companyId'].every(key => UUID.test(main[key] ?? '')) || !['projectId', 'workspaceId', 'agentId'].every(key => UUID.test(operation.data[key] ?? ''))) reviewFail('REVIEW_REGISTRATION_NOT_CONFIGURED');
    for (const key of ['dispatchConfigPath', 'journalDirectory', 'schedulerDirectory']) if (typeof main[key] !== 'string' || !path.isAbsolute(main[key])) reviewFail('REVIEW_PLAN_INVALID');
    const directory = path.join(path.dirname(main.dispatchConfigPath), 'review');
    const plan = { directory, pipelineDirectory: path.join(directory, 'pipeline'), main, registration, operation, companyId: main.companyId, projectId: operation.data.projectId, implementationAgentId: operation.data.agentId };
    plan.baseConfig = buildRegisteredDispatchConfig({ registration, companyId: plan.companyId, projectId: plan.projectId, workspaceId: operation.data.workspaceId, plan: main });
    Object.defineProperty(plan, 'registry', { value: registry });
    return withSchedulerConfiguration(plan, () => plan);
  });
}
function withSchedulerConfiguration(plan, action, provided) {
  let scheduler = provided, owned = false;
  try {
    if (!scheduler && fs.existsSync(path.join(plan.main.schedulerDirectory, SCHEDULER_FILENAME))) { scheduler = new DispatchScheduler({ directory: plan.main.schedulerDirectory }); owned = true; }
    scheduler?.assertConfiguration(plan.registration.repository, plan.registration.configHash);
    return action();
  } finally { if (owned) scheduler.close(); }
}
/** Guard synchronous new intent against registry cutover and scheduler fencing. */
export function withReviewConfiguration(plan, action = () => undefined, { scheduler: provided } = {}) {
  if (!plan.registry?.withConfigurationGuard) reviewFail('REVIEW_CONFIGURATION_GUARD_REQUIRED');
  return plan.registry.withConfigurationGuard(plan.registration.repository, plan.registration.configHash, () => withSchedulerConfiguration(plan, action, provided));
}
export function roleSpec(plan, role, bindingId) {
  if (!['reviewer', 'qa', 'repair'].includes(role) || !UUID.test(bindingId ?? '')) reviewFail('REVIEW_ROLE_INVALID');
  const configPath = path.join(plan.directory, role + '.json'), config = validateProjectConfig({ ...plan.baseConfig, factoryRole: role === 'repair' ? 'implementer' : role, reviewPipelineDirectory: plan.pipelineDirectory });
  return { role, configPath, config, marker: { registrationId: plan.operation.data.operationId, reviewBindingId: bindingId, repository: plan.registration.repository, role }, adapterConfig: { command: plan.main.runtime.nodeCommand, args: [path.join(plan.main.runtime.factoryRoot, 'scripts/review-dispatch.mjs'), '--config', configPath], cwd: plan.directory, timeoutSec: 180, graceSec: 10 }, runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } } };
}
export function reviewCommands(plan, run = runCommand, env = process.env, shouldStop = () => false) {
  const clean = cloudEnvironment(env), pcEnv = { ...clean, PAPERCLIP_TELEMETRY_DISABLED: '1' }, ghEnv = { ...clean };
  for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') pcEnv[key] = env[key];
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (typeof env[key] === 'string') ghEnv[key] = env[key];
  const command = async (kind, args, json = true, maxOutputBytes = 1_000_000) => {
    if (shouldStop()) reviewFail('REVIEW_CONTROLLER_STOPPED');
    if (kind === 'paperclip' && !['whoami', '--version', '--help'].includes(args[0]) && !['get', 'list', 'configuration', 'live-runs', 'interactions'].includes(args[1])) withReviewConfiguration(plan);
    let value; try { value = await run(plan.main.runtime[kind + 'Command'], args, { env: kind === 'paperclip' ? pcEnv : kind === 'github' ? ghEnv : clean, timeoutMs: 15000, maxOutputBytes }); } catch { reviewFail('REVIEW_' + kind.toUpperCase() + '_UNAVAILABLE'); }
    if (value?.code !== 0 || value.timedOut || value.signal || value.outputExceeded || value.failedToStart || typeof value.stdout !== 'string' || Buffer.byteLength(value.stdout) > maxOutputBytes) reviewFail('REVIEW_' + kind.toUpperCase() + '_UNAVAILABLE');
    if (!json) return value.stdout; try { return JSON.parse(value.stdout); } catch { reviewFail('REVIEW_INVALID_RESPONSE'); }
  };
  return { pc: args => command('paperclip', [...args, '--api-base', plan.main.runtime.apiBase, '--json']), gh: resource => command('github', ['api', '--hostname', 'github.com', '--method', 'GET', '--header', 'Accept: application/vnd.github+json', resource]), codex: args => command('codex', args, false), command };
}
export async function verifyReviewRole({ plan, store, role, pc }) {
  const record = store.get('role:' + role); if (!record?.data.agentId || !['configured', 'approval_required'].includes(record.state)) reviewFail('REVIEW_ROLE_NOT_CONFIGURED');
  const spec = roleSpec(plan, role, record.data.bindingId);
  if (record.data.configHash !== configurationHash(spec.config) || record.data.sourceOperationId !== plan.operation.data.operationId) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
  const stat = fs.lstatSync(spec.configPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000 || !isDeepStrictEqual(validateProjectConfig(JSON.parse(fs.readFileSync(spec.configPath, 'utf8'))), spec.config)) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
  const agent = await pc(['agent', 'get', record.data.agentId]), projection = await pc(['agent', 'configuration', record.data.agentId]);
  if (agent?.id !== record.data.agentId || agent.companyId !== plan.companyId || agent.adapterType !== 'process' || !isDeepStrictEqual(agent.metadata?.factoryReview, spec.marker) || projection?.id !== agent.id || projection.companyId !== plan.companyId || projection.adapterType !== 'process' || !isDeepStrictEqual(projection.adapterConfig, spec.adapterConfig) || !isDeepStrictEqual(projection.runtimeConfig?.heartbeat, spec.runtimeConfig.heartbeat)) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
  if (agent.status === 'pending_approval' || projection.status === 'pending_approval') reviewFail('REVIEW_HIRE_APPROVAL_REQUIRED');
  if (![agent.status, projection.status].every(status => ['idle', 'running'].includes(status))) reviewFail('REVIEW_ROLE_UNAVAILABLE');
  return { agentId: agent.id, spec, record };
}
export async function bootstrapReviewRoles({ registry, repository, run = runCommand, env = process.env, dryRun = false } = {}) {
  const plan = buildReviewPlan({ registry, repository });
  if (dryRun) return { status: 'planned', companyId: plan.companyId, projectId: plan.projectId, directory: plan.directory, pipelineDirectory: plan.pipelineDirectory, roles: ['reviewer', 'qa', 'repair'], rolePlans: ['reviewer', 'qa', 'repair'].map(role => roleSpec(plan, role, '00000000-0000-4000-8000-000000000000')), sourceAgentUnchanged: true };
  for (const filename of [plan.main.runtime.nodeCommand, path.join(plan.main.runtime.factoryRoot, 'scripts/review-dispatch.mjs')]) if (!fs.lstatSync(filename).isFile()) reviewFail('REVIEW_RUNTIME_UNAVAILABLE');
  const commands = reviewCommands(plan, run, env);
  if ((await commands.command('node', ['--version'], false, 4096)).trim() !== 'v24.15.0') reviewFail('REVIEW_NODE_VERSION_CHANGED');
  const store = new ReviewRoleBindings({ directory: plan.directory }), { pc } = commands, results = [];
  try {
    for (const role of ['reviewer', 'qa', 'repair']) {
      let record = store.get('role:' + role);
      if (!record) { const bindingId = randomUUID(), spec = roleSpec(plan, role, bindingId); record = withReviewConfiguration(plan, () => store.begin('role:' + role, { bindingId, sourceOperationId: plan.operation.data.operationId, configHash: configurationHash(spec.config) }).record); }
      const spec = roleSpec(plan, role, record.data.bindingId);
      if (record.data.configHash !== configurationHash(spec.config) || record.data.sourceOperationId !== plan.operation.data.operationId) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
      reviewImmutableJson(spec.configPath, spec.config);
      const rows = await pc(['agent', 'list', '--company-id', plan.companyId]); if (!Array.isArray(rows)) reviewFail('REVIEW_INVALID_RESPONSE');
      const candidates = rows.filter(row => isDeepStrictEqual(row.metadata?.factoryReview, spec.marker));
      if (candidates.length > 1) reviewFail('REVIEW_DUPLICATE_ROLE_MARKERS');
      let agent = record.data.agentId ? rows.find(row => row.id === record.data.agentId) : candidates[0];
      if (record.data.agentId && (!agent || !isDeepStrictEqual(agent.metadata?.factoryReview, spec.marker))) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
      if (!agent) {
        if (record.state !== 'planned') reviewFail('REVIEW_ROLE_CREATION_UNKNOWN');
        record = withReviewConfiguration(plan, () => store.update(record, 'sending', record.data));
        try { agent = await pc(['agent', 'create', '--company-id', plan.companyId, '--payload-json', JSON.stringify({ name: 'Factory ' + role + ': ' + plan.registration.repository, role: 'engineer', adapterType: 'process', adapterConfig: spec.adapterConfig, runtimeConfig: spec.runtimeConfig, permissions: { canCreateAgents: false, canCreateSkills: false }, metadata: { factoryReview: spec.marker } })]); }
        catch { reviewFail('REVIEW_ROLE_CREATION_UNKNOWN'); }
      }
      if (!UUID.test(agent?.id ?? '') || agent.companyId !== plan.companyId || !isDeepStrictEqual(agent.metadata?.factoryReview, spec.marker)) reviewFail('REVIEW_ROLE_CREATION_UNKNOWN');
      if (!record.data.agentId) record = store.update(record, 'configuring', { ...record.data, agentId: agent.id });
      const fresh = await pc(['agent', 'get', agent.id]), projection = await pc(['agent', 'configuration', agent.id]);
      if (fresh?.id !== agent.id || fresh.companyId !== plan.companyId || !isDeepStrictEqual(fresh.metadata?.factoryReview, spec.marker) || fresh.adapterType !== 'process' || projection?.id !== agent.id || projection.companyId !== plan.companyId || projection.adapterType !== 'process' || !isDeepStrictEqual(projection.adapterConfig, spec.adapterConfig) || !isDeepStrictEqual(projection.runtimeConfig?.heartbeat, spec.runtimeConfig.heartbeat) || [fresh.status, projection.status].some(status => !['idle', 'running', 'pending_approval'].includes(status))) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
      const state = [fresh.status, projection.status].includes('pending_approval') ? 'approval_required' : 'configured';
      if (record.state !== state) record = store.update(record, state, record.data);
      results.push({ role, agentId: agent.id, status: state });
    }
    return { status: results.some(row => row.status === 'approval_required') ? 'approval_required' : 'configured', roles: results, directory: plan.directory, pipelineDirectory: plan.pipelineDirectory, sourceAgentUnchanged: true };
  } finally { store.close(); }
}
