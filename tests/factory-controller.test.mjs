import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryRegistry, configurationHash } from '../lib/repository-registry.mjs';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { buildOnboardingPlan } from '../lib/repository-onboarding.mjs';
import { validateProjectConfig } from '../lib/cloud-dispatch.mjs';
import { runFactoryControllerOnce } from '../lib/factory-controller.mjs';

const uuid = n => { const h = n.toString(16).padStart(32, '0'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const NOW = '2030-01-02T00:00:00.000Z', BASE = 'a'.repeat(40);
const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
function setup(t, { maxGlobalActive = 2, maxRepositoryActive = 1, sameCompanyRuntimeConflict = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-account-controller-'));
  const privateDir = path.join(root, 'instance', 'onboarding'), registry = new RepositoryRegistry({ directory: path.join(root, 'registry') });
  const policy = { schemaVersion: 1, concurrency: { maxGlobalActive, maxRepositoryActive, maxAttempts: 3 } };
  const runtime = { nodeCommand: process.execPath, paperclipCommand: '/fixture/paperclip', codexCommand: '/fixture/codex', githubCommand: '/fixture/gh', factoryRoot: process.cwd(), privateDir, apiBase: 'http://127.0.0.1:8100' };
  const scheduler = new DispatchScheduler({ directory: path.join(privateDir, 'scheduler'), limits: policy.concurrency });
  const entries = [], calls = [], wakes = [], wakeRuns = new Map();
  const state = { quota: false, onWake: null, wakeFailure: false, ownerActive: false, live: [], status: 'in_progress', reassigned: false, now: NOW, description: `Factory base SHA: ${BASE}\nReject malformed limits and run focused tests.` };
  for (let n = 1; n <= 2; n++) {
    const companyId = uuid(sameCompanyRuntimeConflict ? 1 : n), projectId = uuid(10 + n), workspaceId = uuid(20 + n), agentId = uuid(30 + n), issueId = uuid(40 + n), ownerId = uuid(50 + n), operationId = uuid(60 + n);
    const { registration } = registry.register({ schemaVersion: 1, repository: `fixture/project-${n}`, cloud: { environmentId: n.toString(16).repeat(32) }, commands: { test: { argv: ['node', '--test'] } }, concurrency: { maxActive: maxRepositoryActive } }, { sourcePath: path.join(root, `repo-${n}.factory.yaml`), policy });
    const entryRuntime = sameCompanyRuntimeConflict && n === 2 ? { ...runtime, codexCommand: '/fixture/second-codex' } : runtime;
    const plan = buildOnboardingPlan({ registration, companyId, runtime: entryRuntime });
    registry.beginOperation(registration.repository, { expectedConfigHash: registration.configHash, state: 'configured', data: { companyId, operationId, planHash: configurationHash(plan), plan, projectId, workspaceId, agentId } });
    const config = validateProjectConfig({ schemaVersion: 1, companyId, projectId, workspaceId, repository: registration.repository, environmentId: registration.config.cloud.environmentId, branch: 'main', mode: 'code_change', codexCommand: entryRuntime.codexCommand, factoryConfig: registration.config, factoryPolicy: registration.policy, schedulerDirectory: plan.schedulerDirectory, stateDirectory: plan.journalDirectory, journalRootDirectory: plan.journalRootDirectory });
    fs.mkdirSync(path.dirname(plan.dispatchConfigPath), { recursive: true }); fs.writeFileSync(plan.dispatchConfigPath, JSON.stringify(config));
    const journal = new ExecutionJournal({ directory: plan.journalDirectory, companyId });
    const record = journal.queue({ companyId, paperclipIssueId: issueId, paperclipRunId: ownerId, projectId, workspaceId, repository: registration.repository, environmentId: config.environmentId, branch: 'main', mode: 'code_change' });
    entries.push({ registration, plan, config, journal, companyId, projectId, workspaceId, agentId, issueId, ownerId, operationId, record, overrides: {} });
  }
  const accepted = (entry, runId = entry.ownerId) => {
    entry.journal.claim(entry.issueId, runId);
    const cloudTaskId = 'task_e_' + entry.companyId.replaceAll('-', '');
    return entry.journal.accept(entry.issueId, runId, { cloudTaskId, emittedUrl: 'https://chatgpt.com/codex/tasks/' + cloudTaskId, taskUrl: 'https://chatgpt.com/remote/' + cloudTaskId });
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(args.includes('exec'), false, 'account controller must never directly submit Cloud work');
    assert.equal(options.env.PAPERCLIP_API_KEY, undefined);
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.166.0\n', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    if (args[0] === 'cloud') {
      const entry = entries.find(item => item.config.environmentId === args[args.indexOf('--env') + 1]);
      if (state.quota) return { code: 1, stdout: '', stderr: 'usage_limit_reached PRIVATE_DIAGNOSTIC' };
      return json({ tasks: entry.journal.list().filter(row => row.cloudTaskId).map(row => ({ id: row.cloudTaskId, url: row.emittedUrl, status: 'pending', updated_at: '2030-01-01T23:59:00Z', environment_id: null, summary: { files_changed: 0, lines_added: 0, lines_removed: 0 } })), cursor: null });
    }
    if (args[0] === 'whoami') return json({ userId: uuid(99), companyIds: entries.map(item => item.companyId) });
    const entry = entries.find(item => [item.issueId, item.ownerId, item.agentId, item.projectId].includes(args[2])) ?? entries.find(item => wakeRuns.get(args[2])?.companyId === item.companyId);
    assert.ok(entry, 'Expected scoped inert command');
    if (args[0] === 'run') return json(wakeRuns.get(args[2]) ?? { id: entry.ownerId, companyId: entry.companyId, agentId: entry.agentId, status: state.ownerActive ? 'running' : 'succeeded', contextSnapshot: { issueId: entry.issueId } });
    if (args[0] === 'issue' && args[1] === 'get') return json({ id: entry.issueId, companyId: entry.companyId, projectId: entry.projectId, projectWorkspaceId: entry.workspaceId, assigneeAgentId: (entry.overrides.reassigned ?? state.reassigned) ? uuid(999) : entry.agentId, assigneeUserId: null, status: entry.overrides.status ?? state.status, title: 'Fix a small parser defect', description: entry.overrides.description ?? state.description });
    if (args[0] === 'issue' && args[1] === 'live-runs') return json(state.live);
    if (args[0] === 'agent' && args[1] === 'get') return json({ id: entry.agentId, companyId: entry.companyId, status: 'idle', adapterType: 'process', metadata: { factory: { registrationId: entry.operationId, repository: entry.registration.repository } }, ...entry.overrides.agentGetPatch });
    if (args[0] === 'agent' && args[1] === 'configuration') return json({ id: entry.agentId, companyId: entry.companyId, status: 'idle', adapterType: 'process', adapterConfig: { command: runtime.nodeCommand, args: [path.join(runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'), '--config', entry.plan.dispatchConfigPath], cwd: runtime.factoryRoot, timeoutSec: 180, graceSec: 10 }, runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } }, ...entry.overrides.configurationPatch });
    if (args[0] === 'project') return json({ id: entry.projectId, companyId: entry.companyId, workspaces: [{ id: entry.workspaceId, companyId: entry.companyId, projectId: entry.projectId, repoUrl: 'https://github.com/' + entry.registration.repository, repoRef: 'main', defaultRef: 'main', isPrimary: true }] });
    if (args[0] === 'agent' && args[1] === 'wake') {
      const wake = { id: uuid(500 + wakes.length), companyId: entry.companyId, agentId: entry.agentId, status: 'succeeded', contextSnapshot: { issueId: entry.issueId } };
      wakes.push({ entry, key: args[args.indexOf('--idempotency-key') + 1], wake }); wakeRuns.set(wake.id, wake);
      if (state.onWake) await state.onWake(entry, wake);
      if (entry.overrides.wakeFailure ?? state.wakeFailure) return { code: 1, stdout: '', stderr: 'PRIVATE_DIAGNOSTIC' };
      return json(wake);
    }
    throw new Error('Unexpected fixture command');
  };
  const invoke = options => runFactoryControllerOnce({ registry, scheduler, run, env: { PAPERCLIP_API_KEY: 'do-not-forward' }, now: () => state.now, sleep: async ms => { state.now = new Date(Date.parse(state.now) + ms).toISOString(); }, ...options });
  t.after(() => { for (const entry of entries) entry.journal.close(); scheduler.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, registry, scheduler, entries, calls, wakes, state, accepted, invoke };
}

test('two company journals are inventoried before fair admission; terminal journal proof releases capacity and wakes once', async t => {
  const f = setup(t, { maxGlobalActive: 1 }), [active, queued] = f.entries;
  const original = f.accepted(active);
  const first = await f.invoke();
  assert.equal(first.woken.length, 0); assert.equal(f.wakes.length, 0);
  assert.equal(f.scheduler.get(original.executionId).state, 'submitted');
  active.journal.transition(active.issueId, { expectedState: 'running', expectedRevision: original.revision, toState: 'succeeded' });
  f.state.onWake = (entry, wake) => {
    const record = entry.journal.get(entry.issueId), claim = f.scheduler.claim(record.executionId, { ownerId: wake.id, now: f.state.now });
    assert.equal(claim.claimed, true);
    const accepted = f.accepted(entry, wake.id);
    f.scheduler.markSubmitted(record.executionId, { token: claim.record.token, expectedRevision: claim.record.revision, cloudTaskId: accepted.cloudTaskId, now: f.state.now });
  };
  const second = await f.invoke();
  assert.equal(second.woken.length, 1); assert.equal(f.wakes[0].entry.companyId, queued.companyId);
  const receipt = queued.journal.get(queued.issueId);
  await f.invoke();
  assert.equal(f.wakes.length, 1); assert.equal(queued.journal.get(queued.issueId).cloudTaskId, receipt.cloudTaskId);
  assert.equal(f.calls.some(call => call.args.includes('exec')), false);
});

test('account pause stops queued wakes while existing Cloud reconciliation continues', async t => {
  const f = setup(t); f.accepted(f.entries[0]); f.scheduler.setPaused(true, { now: NOW });
  const result = await f.invoke();
  assert.equal(result.status, 'paused'); assert.equal(f.wakes.length, 0);
  assert.equal(f.calls.filter(call => call.args[0] === 'cloud').length, 1);
});

test('recognized provider cooldown crosses company boundaries and survives controller restart', async t => {
  const f = setup(t); f.entries.forEach(entry => f.accepted(entry)); f.state.quota = true;
  const first = await f.invoke();
  assert.equal(f.calls.filter(call => call.args[0] === 'cloud').length, 1);
  const deadline = f.scheduler.settings().cooldownUntil;
  assert.ok(Date.parse(deadline) > Date.parse(f.state.now));
  for (const entry of f.entries) assert.ok(entry.journal.providerRequestLimit().retryAt >= deadline);
  await f.invoke();
  assert.equal(f.calls.filter(call => call.args[0] === 'cloud').length, 1);
  assert.equal(JSON.stringify(first).includes('PRIVATE_DIAGNOSTIC'), false);
});

for (const status of ['done', 'cancelled', 'blocked']) test('human ' + status + ' task is never reopened or woken', async t => {
  const f = setup(t); f.state.status = status;
  const result = await f.invoke();
  assert.equal(f.wakes.length, 0); assert.ok(result.needsAttention.some(item => ['FACTORY_QUEUED_TASK_TERMINAL', 'FACTORY_QUEUED_TASK_BLOCKED'].includes(item.code)));
  assert.equal(f.scheduler.get(f.entries[0].record.executionId).state, 'held');
  assert.equal(f.entries[0].journal.get(f.entries[0].issueId).state, 'queued');
  assert.equal(f.calls.some(call => call.args.includes('update')), false);
});

test('reassigned tasks, active original owner and another live run cannot be woken', async t => {
  for (const change of [{ reassigned: true }, { ownerActive: true }, { live: [{ id: uuid(888), status: 'running' }] }]) {
    const f = setup(t); Object.assign(f.state, change);
    await f.invoke(); assert.equal(f.wakes.length, 0);
  }
});

test('ambiguous wake intent remains sticky across new controller calls and control revisions', async t => {
  const f = setup(t); f.state.wakeFailure = true; f.entries[1].overrides.status = 'blocked';
  const first = await f.invoke();
  assert.equal(f.wakes.length, 1); assert.equal(first.status, 'needs_attention');
  await f.invoke(); assert.equal(f.wakes.length, 1);
  f.scheduler.setPaused(false, { now: NOW });
  const held = f.scheduler.get(f.entries[0].record.executionId);
  f.scheduler.resumeHeld(held.executionId, { expectedRevision: held.revision, now: NOW });
  const again = await f.invoke();
  assert.equal(f.wakes.length, 1); assert.ok(again.needsAttention.some(item => item.code === 'FACTORY_WAKE_OUTCOME_UNKNOWN'));
});

test('a delivered pre-admission wake is held without repeats and explicit execution resume creates a new opportunity', async t => {
  const f = setup(t); f.entries[1].overrides.status = 'blocked'; await f.invoke();
  assert.equal(f.wakes.length, 1);
  const firstKey = f.wakes[0].key;
  await f.invoke(); assert.equal(f.wakes.length, 1);
  const held = f.scheduler.get(f.entries[0].record.executionId);
  assert.equal(held.state, 'held');
  const settings = f.scheduler.settings(), repo = f.scheduler.repositories().find(row => row.repository === held.repository);
  f.scheduler.resumeHeld(held.executionId, { expectedRevision: held.revision, now: NOW });
  await f.invoke();
  assert.equal(f.wakes.length, 2); assert.notEqual(f.wakes[1].key, firstKey);
  assert.equal(f.scheduler.settings().revision, settings.revision);
  assert.equal(f.scheduler.repositories().find(row => row.repository === held.repository).revision, repo.revision);
});

test('queued work must retain exact registered role configuration and approved immutable base header', async t => {
  const f = setup(t), entry = f.entries[0];
  fs.writeFileSync(entry.plan.dispatchConfigPath, JSON.stringify({ ...entry.config, factoryConfig: undefined }));
  const result = await f.invoke();
  assert.equal(f.wakes.length, 0); assert.ok(result.needsAttention.some(item => ['FACTORY_DISPATCH_BINDING_CHANGED', 'INVALID_SCHEDULER_CONFIG'].includes(item.code)));
  const missingBase = setup(t); missingBase.state.description = 'Implement the task without an approved base.';
  const rejected = await missingBase.invoke();
  assert.equal(missingBase.wakes.length, 0); assert.ok(rejected.needsAttention.some(item => item.code === 'FACTORY_TASK_BASE_REQUIRED'));
});

test('unregistered old company work occupies the account before new registered work can wake', async t => {
  const f = setup(t, { maxGlobalActive: 1 });
  const companyId = uuid(999), directory = path.join(f.entries[0].plan.journalRootDirectory, companyId), legacy = new ExecutionJournal({ directory, companyId });
  const record = legacy.queue({ companyId, paperclipIssueId: uuid(1000), paperclipRunId: uuid(1001), projectId: uuid(1002), repository: 'legacy/project', environmentId: 'f'.repeat(32), branch: 'main', mode: 'code_change' });
  legacy.claim(record.paperclipIssueId, record.paperclipRunId); legacy.markUnknown(record.paperclipIssueId, record.paperclipRunId, 'DISPATCH_OUTCOME_UNKNOWN'); legacy.close();
  await f.invoke();
  assert.equal(f.scheduler.get(record.executionId).state, 'unknown'); assert.equal(f.wakes.length, 0);
});

test('shutdown and bounded company inventory never begin a wake', async t => {
  const f = setup(t);
  assert.equal((await f.invoke({ shouldStop: () => true })).status, 'stopped');
  const bounded = await f.invoke({ maxCompanies: 1 });
  assert.equal(bounded.status, 'needs_attention'); assert.equal(f.wakes.length, 0);
});

for (const change of [{ codexCommand: '/fixture/unregistered-codex' }, { attempt: 2 }, { dispatchTimeoutMs: 2000 }]) test('private dispatch configuration drift is held: ' + Object.keys(change)[0], async t => {
  const f = setup(t), entry = f.entries[0];
  fs.writeFileSync(entry.plan.dispatchConfigPath, JSON.stringify({ ...entry.config, ...change }));
  const result = await f.invoke();
  assert.equal(f.wakes.length, 0); assert.ok(result.needsAttention.some(item => item.code === 'FACTORY_DISPATCH_BINDING_CHANGED'));
  assert.equal(f.scheduler.get(entry.record.executionId).state, 'held');
  await f.invoke(); assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].entry.companyId, f.entries[1].companyId);
});

for (const change of [{ status: 'done' }, { status: 'blocked' }, { reassigned: true }, { wakeFailure: true }]) test('an ineligible first repository is held so another repository can progress: ' + Object.keys(change).join(','), async t => {
  const f = setup(t), [first, second] = f.entries; Object.assign(first.overrides, change);
  await f.invoke();
  assert.equal(f.scheduler.get(first.record.executionId).state, 'held');
  await f.invoke();
  assert.equal(f.wakes.filter(row => row.entry.companyId === second.companyId).length, 1);
  const originalWakeCount = f.wakes.filter(row => row.entry.companyId === first.companyId).length;
  if (change.wakeFailure) {
    const held = f.scheduler.get(first.record.executionId);
    f.scheduler.resumeHeld(held.executionId, { expectedRevision: held.revision, now: NOW });
    await f.invoke();
    assert.equal(f.wakes.filter(row => row.entry.companyId === first.companyId).length, originalWakeCount);
    assert.equal(f.scheduler.get(first.record.executionId).state, 'held');
  }
});

test('conflicting runtime plans for one company exclude every affected registration from wakes', async t => {
  const f = setup(t, { sameCompanyRuntimeConflict: true });
  const first = await f.invoke();
  assert.ok(first.needsAttention.some(row => row.code === 'FACTORY_COMPANY_RUNTIME_CONFLICT'));
  assert.equal(f.wakes.length, 0); assert.equal(f.calls.length, 0);
  await f.invoke();
  assert.equal(f.wakes.length, 0); assert.equal(f.calls.length, 0);
  for (const entry of f.entries) assert.equal(f.scheduler.get(entry.record.executionId).state, 'held');
});

test('operator tightened account/repository ceilings remain authoritative without breaking recovery and wake', async t => {
  const f = setup(t, { maxRepositoryActive: 2 }), active = f.entries[0];
  const accepted = f.accepted(active);
  f.scheduler.setPaused(true, { now: NOW }); await f.invoke();
  for (const row of f.scheduler.repositories()) f.scheduler.configureRepository({ repository: row.repository, expectedRevision: row.revision, maxActive: 1, maxAttempts: 1, now: NOW });
  const settings = f.scheduler.settings();
  f.scheduler.configureLimits({ expectedRevision: settings.revision, limits: { ...settings.limits, maxGlobalActive: 1, maxRepositoryActive: 1, maxAttempts: 1 }, now: NOW });
  f.scheduler.setPaused(false, { now: NOW });
  f.state.now = '2030-01-02T00:01:00.000Z';
  const recovering = await f.invoke();
  assert.equal(f.wakes.length, 0); assert.ok(!recovering.needsAttention.some(row => row.code.includes('POLICY') || row.code.includes('LIMITS_CHANGED')));
  assert.equal(f.calls.filter(call => call.args[0] === 'cloud').length, 2);
  active.journal.transition(active.issueId, { expectedState: 'running', expectedRevision: accepted.revision, toState: 'succeeded' });
  await f.invoke();
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].entry.companyId, f.entries[1].companyId);
  assert.equal(f.scheduler.settings().limits.maxGlobalActive, 1);
  assert.ok(f.scheduler.repositories().every(row => row.maxActive === 1 && row.maxAttempts === 1));
});

test('fresh ownership row is required while native configuration intentionally omits metadata', async t => {
  for (const patch of [{ metadata: {} }, { metadata: { factory: { registrationId: 'wrong', repository: 'fixture/project-1' } } }, { id: uuid(999) }, { status: 'terminated' }, { adapterType: 'codex_local' }]) {
    const f = setup(t); f.entries[0].overrides.agentGetPatch = patch;
    const result = await f.invoke();
    assert.equal(f.wakes.length, 0); assert.ok(result.needsAttention.some(row => row.code === 'FACTORY_AGENT_CONFIGURATION_CHANGED'));
  }
  const native = setup(t); await native.invoke();
  assert.equal(native.wakes.length, 1);
  assert.ok(native.calls.some(row => row.args[0] === 'agent' && row.args[1] === 'get'));
});

test('configuration projection still must identify the expected usable process agent', async t => {
  for (const patch of [{ id: uuid(999) }, { companyId: uuid(999) }, { status: 'terminated' }, { status: 'error' }, { adapterType: 'codex_local' }, { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } } }]) {
    const f = setup(t); f.entries[0].overrides.configurationPatch = patch;
    const result = await f.invoke();
    assert.equal(f.wakes.length, 0); assert.ok(result.needsAttention.some(row => row.code === 'FACTORY_AGENT_CONFIGURATION_CHANGED'));
  }
});
