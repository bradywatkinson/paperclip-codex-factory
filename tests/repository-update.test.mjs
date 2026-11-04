import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { configurationHash } from '../lib/repository-registry.mjs';
import { buildRegisteredDispatchConfig, bootstrapRepository } from '../lib/repository-onboarding.mjs';
import { ReviewRoleBindings, roleSpec, verifyReviewRole, reviewCommands, bootstrapReviewRoles } from '../lib/review-onboarding.mjs';
import { dispatchFromPaperclip } from '../lib/cloud-dispatch.mjs';
import { runFactoryCli } from '../scripts/factory.mjs';
import { configurationUpdateFixture } from './fixtures/configuration-update-runtime.mjs';

function snapshot(f) {
  return { registration: f.registry.get(f.repository), operation: f.registry.getOperation(f.repository), files: f.contractFiles(), roles: f.roleRecords(),
    executions: f.journal.list(), events: f.journal.events(f.sourceIssueId), scheduler: f.scheduler.list(), settings: f.scheduler.settings(), repositories: f.scheduler.repositories() };
}
function assertNoIntent(f) {
  assert.equal(f.registry.getConfigurationUpdate(f.repository), null);
  assert.equal(f.scheduler.configurationFence(f.repository), null);
}
function assertReadOnlyCalls(f) {
  for (const { command, args } of f.updateCalls) {
    if (command === f.runtime.paperclipCommand) assert.ok(args[0] === '--version' || ['get', 'configuration', 'list'].includes(args[1]), 'Unexpected Paperclip write: ' + args.join(' '));
    if (command === f.runtime.codexCommand && args[0] === 'cloud') assert.ok(['list', 'diff'].includes(args[1]), 'Unexpected Cloud mutation');
    if (command === f.runtime.githubCommand) assert.equal(args[args.indexOf('--method') + 1], 'GET');
  }
}

test('dry-run validates a concrete stronger contract without intents, registration or file changes', async t => {
  const f = await configurationUpdateFixture(t), before = snapshot(f);
  const result = await f.update();
  assert.equal(result.status, 'dry_run');
  assert.equal(result.accountPaused, true);
  assert.equal(result.cloudSubmissions, false); assert.equal(result.externalWrites, false);
  assert.deepEqual(result.addedRequiredChecks, ['application-tests']);
  assert.equal(result.files.length, 5);
  assert.deepEqual(snapshot(f), before); assertNoIntent(f); assertReadOnlyCalls(f);
  const availability = f.updateCalls.filter(call => call.command === f.runtime.githubCommand && call.args.at(-1).includes('/check-runs?'));
  assert.ok(availability.length > 0);
});

test('apply updates all canonical contracts while preserving native IDs, policy, limits and receipts', async t => {
  const f = await configurationUpdateFixture(t), before = snapshot(f), result = await f.update({ dryRun: false });
  assert.equal(result.status, 'updated');
  assert.equal(result.configHash, configurationHash(f.config));
  assert.deepEqual(result.preservedIds, { companyId: f.companyId, projectId: f.projectId, workspaceId: f.workspaceId, agentId: f.implementationAgentId, reviewAgentIds: before.roles.map(row => row.data.agentId) });
  const { registration, operation, reviewPlan } = f.assertCanonical();
  assert.deepEqual(registration.config, f.config); assert.equal(registration.sourcePath, f.sourcePath);
  assert.equal(registration.createdAt, before.registration.createdAt);
  assert.deepEqual(registration.policy, before.registration.policy); assert.equal(registration.policyHash, before.registration.policyHash);
  assert.equal(operation.state, 'configured');
  for (const key of ['companyId', 'projectId', 'workspaceId', 'agentId', 'operationId']) assert.equal(operation.data[key], before.operation.data[key]);
  const expected = buildRegisteredDispatchConfig({ registration, companyId: f.companyId, projectId: f.projectId, workspaceId: f.workspaceId, plan: operation.data.plan });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.main.dispatchConfigPath)), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.main.taskContractPath)), operation.data.plan.taskContract);
  const store = new ReviewRoleBindings({ directory: reviewPlan.directory });
  try {
    const { pc } = reviewCommands(reviewPlan, f.run);
    for (const old of before.roles) {
      const actual = store.get(old.key), role = old.key.slice(5), spec = roleSpec(reviewPlan, role, old.data.bindingId);
      assert.equal(actual.data.agentId, old.data.agentId); assert.equal(actual.data.bindingId, old.data.bindingId); assert.equal(actual.data.sourceOperationId, old.data.sourceOperationId);
      assert.equal(actual.data.configHash, configurationHash(spec.config)); assert.equal(actual.revision, old.revision + 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(spec.configPath)), spec.config);
      assert.equal((await verifyReviewRole({ plan: reviewPlan, store, role, pc })).agentId, old.data.agentId);
    }
  } finally { store.close(); }
  assert.deepEqual(f.journal.list(), before.executions); assert.deepEqual(f.journal.events(f.sourceIssueId), before.events);
  assert.deepEqual(f.scheduler.list(), before.scheduler); assert.deepEqual(f.scheduler.settings(), before.settings); assert.deepEqual(f.scheduler.repositories(), before.repositories);
  assert.equal(f.registry.getConfigurationUpdate(f.repository).state, 'completed');
  assert.equal(f.scheduler.configurationFence(f.repository).state, 'ready');
  assertReadOnlyCalls(f);
  const after = snapshot(f), repeated = await f.update({ dryRun: false });
  assert.equal(repeated.status, 'already_updated'); assert.equal(repeated.updateId, result.updateId); assert.deepEqual(snapshot(f), after);
});

test('a repository without review roles updates without creating role bindings or agents', async t => {
  const f = await configurationUpdateFixture(t, { roles: false }), agents = [...f.agents.keys()];
  assert.equal((await f.update({ dryRun: false })).status, 'updated');
  assert.deepEqual(f.roleRecords(), []); assert.deepEqual([...f.agents.keys()], agents);
  assertReadOnlyCalls(f);
});

test('main and role bootstrap accept the updated plan and reuse all existing native resources', async t => {
  const f = await configurationUpdateFixture(t); await f.update({ dryRun: false });
  const before = snapshot(f), agents = [...f.agents.keys()];
  const main = await bootstrapRepository({ registry: f.registry, repository: f.repository, companyId: f.companyId, runtime: f.runtime, run: f.run });
  assert.equal(main.status, 'configured', JSON.stringify(main));
  const roles = await bootstrapReviewRoles({ registry: f.registry, repository: f.repository, run: f.run });
  assert.equal(roles.status, 'configured', JSON.stringify(roles));
  assert.deepEqual([...f.agents.keys()], agents); assert.deepEqual(f.contractFiles(), before.files); assert.deepEqual(f.roleRecords(), before.roles);
  for (const key of ['companyId', 'projectId', 'workspaceId', 'agentId', 'operationId']) assert.equal(main.operation.data[key], before.operation.data[key]);
  assert.equal(main.plan.configHash, configurationHash(f.config)); assertReadOnlyCalls(f);
});

test('old in-memory dispatcher contract is fenced before journal mutation or Cloud preflight', async t => {
  const f = await configurationUpdateFixture(t), before = f.journal.list();
  await f.update({ dryRun: false });
  const runId = randomUUID(), requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    const endpoint = new URL(url).pathname;
    assert.equal(options.method, 'GET');
    const value = endpoint === '/api/agents/me' ? f.agents.get(f.implementationAgentId)
      : endpoint === '/api/heartbeat-runs/' + runId ? { id: runId, companyId: f.companyId, agentId: f.implementationAgentId, status: 'running', contextSnapshot: { issueId: f.sourceIssueId } }
        : endpoint === '/api/issues/' + f.sourceIssueId ? f.issues.get(f.sourceIssueId)
          : endpoint === '/api/projects/' + f.projectId ? { ...f.project, workspaces: [...f.workspaces.values()] } : null;
    assert.ok(value, endpoint); return new Response(JSON.stringify(value));
  };
  const calls = f.updateCalls.length;
  await assert.rejects(dispatchFromPaperclip({ config: f.oldDispatchConfig, context: { companyId: f.companyId, agentId: f.implementationAgentId, runId, apiUrl: f.runtime.apiBase, apiKey: 'FIXTURE_ONLY_BEARER' }, request, run: f.run }), { code: 'SCHEDULER_CONFIGURATION_CHANGED' });
  assert.equal(f.updateCalls.length, calls); assert.equal(requests.length, 4); assert.deepEqual(f.journal.list(), before);
});

test('removing checks or changing identity, runtime policy or commands fails without writes', async t => {
  const f = await configurationUpdateFixture(t), before = snapshot(f);
  for (const config of [
    { ...f.config, delivery: { ...f.config.delivery, requiredChecks: ['application-tests'] } },
    { ...f.config, repository: 'fixture/another' },
    { ...f.config, defaultBranch: 'other' },
    { ...f.config, cloud: { environmentId: 'f'.repeat(32) } },
    { ...f.config, concurrency: { ...f.config.concurrency, maxAttempts: 2 } },
    { ...f.config, commands: { ...f.config.commands, test: { argv: ['different-test'] } } },
  ]) await assert.rejects(f.update({ config, dryRun: false }), { code: 'CONFIGURATION_UPDATE_SCOPE_UNSUPPORTED' });
  await assert.rejects(f.update({ expectedConfigHash: 'f'.repeat(64), dryRun: false }), { code: 'REGISTRY_CONFIG_CHANGED' });
  await assert.rejects(f.update({ config: { ...f.config, policy: {} }, dryRun: false }));
  assert.deepEqual(snapshot(f), before); assertNoIntent(f); assert.equal(f.updateCalls.length, 0);
});

test('account pause is required without automatically changing existing controls', async t => {
  const f = await configurationUpdateFixture(t); f.scheduler.setPaused(false); const before = snapshot(f);
  await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_REQUIRES_PAUSE' });
  assert.deepEqual(snapshot(f), before); assertNoIntent(f);
});

test('queued, unknown, and journal-only active work blocks updates without adopting or erasing work', async t => {
  for (const kind of ['scheduler-queued', 'scheduler-unknown', 'journal-queued', 'journal-unknown']) await t.test(kind, async t => {
    const f = await configurationUpdateFixture(t);
    if (kind.startsWith('journal')) f.queueJournal(kind.endsWith('unknown') ? 'unknown' : 'queued');
    else {
      const row = f.scheduler.enqueue({ executionId: randomUUID(), companyId: f.companyId, paperclipIssueId: randomUUID(), attempt: 1, repository: f.repository });
      if (kind.endsWith('unknown')) f.scheduler.adoptJournalExecution({ ...row, paperclipRunId: randomUUID(), state: 'unknown' });
    }
    const before = snapshot(f);
    await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_EXECUTIONS_NOT_IDLE' });
    assert.deepEqual(snapshot(f), before); assertNoIntent(f);
  });
});

test('unfinished review pipeline and ambiguous role creation prohibit configuration reinterpretation', async t => {
  await t.test('unfinished pipeline', async t => {
    const f = await configurationUpdateFixture(t); await f.makeObservation();
    const source = JSON.parse(fs.readFileSync(f.observationPath)), patch = fs.readFileSync(f.patchPath, 'utf8'), pipeline = f.pipeline();
    try { pipeline.seed({ observation: source, patch, registration: f.registration, implementationAgentId: f.implementationAgentId, testCheckNames: ['unit'], maxRepairs: 1, maxHandoffs: 5 }); } finally { pipeline.close(); }
    const before = snapshot(f);
    await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_REVIEW_NOT_IDLE' });
    assert.deepEqual(snapshot(f), before); assertNoIntent(f);
  });
  await t.test('ambiguous role', async t => {
    const f = await configurationUpdateFixture(t), directory = path.join(path.dirname(f.main.dispatchConfigPath), 'review'), store = new ReviewRoleBindings({ directory });
    try { const row = store.get('role:qa'); store.update(row, 'sending', row.data); } finally { store.close(); }
    const before = snapshot(f);
    await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_REVIEW_NOT_IDLE' });
    assert.deepEqual(snapshot(f), before); assertNoIntent(f);
  });
});

test('fresh agent ownership, configuration projection and run history must independently prove idle', async t => {
  for (const kind of ['wrong-get-id', 'wrong-marker', 'running-get', 'wrong-projection-id', 'wrong-projection-adapter', 'running-projection', 'active-run', 'incomplete-run-page']) await t.test(kind, async t => {
    const f = await configurationUpdateFixture(t);
    if (kind === 'wrong-get-id') f.agentGetPatch = { id: randomUUID() };
    if (kind === 'wrong-marker') f.agentGetPatch = { metadata: {} };
    if (kind === 'running-get') f.agentGetPatch = { status: 'running' };
    if (kind === 'wrong-projection-id') f.projectionPatch = { id: randomUUID() };
    if (kind === 'wrong-projection-adapter') f.projectionPatch = { adapterConfig: { command: '/unregistered-command' } };
    if (kind === 'running-projection') f.projectionPatch = { status: 'running' };
    if (kind === 'active-run') f.nativeRuns = [{ id: randomUUID(), companyId: f.companyId, agentId: f.implementationAgentId, status: 'queued' }];
    if (kind === 'incomplete-run-page') f.nativeRuns = Array.from({ length: 100 }, () => ({ id: randomUUID(), companyId: f.companyId, agentId: f.implementationAgentId, status: 'succeeded' }));
    const before = snapshot(f);
    await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_NATIVE_NOT_IDLE' });
    assert.deepEqual(snapshot(f), before); assertNoIntent(f); assertReadOnlyCalls(f);
  });
});

test('missing configured check discovery is attention, never a committed update or passing-test claim', async t => {
  const f = await configurationUpdateFixture(t), before = snapshot(f); f.availableChecks = ['unit'];
  const result = await f.update({ dryRun: false });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.code, 'CONFIGURATION_UPDATE_VALIDATION_FAILED');
  assert.equal(result.validation.checks.find(check => check.name === 'github_required_checks').code, 'GITHUB_REQUIRED_CHECK_MISSING');
  assert.deepEqual(snapshot(f), before); assertNoIntent(f); assertReadOnlyCalls(f);
});

test('empty known role or pipeline databases are corrupt storage, never proof of idle', async t => {
  for (const kind of ['roles', 'pipeline']) await t.test(kind, async t => {
    const f = await configurationUpdateFixture(t, { roles: kind === 'roles' });
    const directory = path.join(path.dirname(f.main.dispatchConfigPath), 'review');
    const filename = kind === 'roles' ? path.join(directory, 'role-bindings.sqlite') : path.join(directory, 'pipeline', 'review-pipeline.sqlite');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, Buffer.alloc(0));
    const registration = f.registry.get(f.repository), operation = f.registry.getOperation(f.repository), calls = f.updateCalls.length;
    await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_STORAGE_INVALID' });
    assert.equal(fs.statSync(filename).size, 0);
    assert.deepEqual(f.registry.get(f.repository), registration); assert.deepEqual(f.registry.getOperation(f.repository), operation);
    assertNoIntent(f); assert.equal(f.updateCalls.length, calls);
  });
});

test('every persisted update checkpoint resumes the exact intent without duplicate resources or weakened hashes', async t => {
  for (const stage of ['fenced', 'prepared', 'file:0', 'role:qa', 'committed']) await t.test(stage, async t => {
    const f = await configurationUpdateFixture(t), before = snapshot(f), agents = [...f.agents.keys()]; let stopped = false;
    await assert.rejects(f.update({ dryRun: false, checkpoint: current => { if (current === stage) { stopped = true; throw new Error('Injected fixture stop: ' + stage); } } }), new RegExp('Injected fixture stop'));
    assert.equal(stopped, true); const fence = f.scheduler.configurationFence(f.repository);
    assert.equal(fence.state, 'updating'); assert.equal(f.scheduler.settings().paused, true);
    assert.throws(() => f.scheduler.assertConfiguration(f.repository, f.registration.configHash), { code: 'SCHEDULER_CONFIGURATION_UPDATING' });
    const intent = f.registry.getConfigurationUpdate(f.repository);
    if (stage === 'fenced') assert.equal(intent, null); else assert.equal(intent.updateId, fence.updateId);
    const result = await f.update({ dryRun: false });
    assert.equal(result.status, 'updated'); assert.equal(result.updateId, fence.updateId);
    assert.equal(f.scheduler.configurationFence(f.repository).state, 'ready');
    assert.equal(f.registry.getConfigurationUpdate(f.repository).state, 'completed');
    assert.equal(f.registry.get(f.repository).configHash, configurationHash(f.config)); f.assertCanonical();
    assert.deepEqual([...f.agents.keys()], agents); assert.deepEqual(f.journal.list(), before.executions); assert.deepEqual(f.scheduler.list(), before.scheduler);
    assert.equal(f.scheduler.settings().paused, true); assertReadOnlyCalls(f);
    assert.equal((await f.update({ dryRun: false })).status, 'already_updated');
  });
});

test('tampered partial-update bytes block recovery while preserving a sticky admission fence', async t => {
  const f = await configurationUpdateFixture(t);
  await assert.rejects(f.update({ dryRun: false, checkpoint: stage => { if (stage === 'file:0') throw new Error('Injected stop'); } }), /Injected stop/);
  fs.writeFileSync(f.main.dispatchConfigPath, '{"unapproved":true}\n');
  const before = snapshot(f), fence = f.scheduler.configurationFence(f.repository);
  await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_FILE_CHANGED' });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(f.scheduler.configurationFence(f.repository), fence);
  assert.equal(f.registry.getConfigurationUpdate(f.repository).state, 'prepared'); assert.equal(f.scheduler.settings().paused, true);
  assert.throws(() => f.scheduler.assertConfiguration(f.repository, configurationHash(f.config)), { code: 'SCHEDULER_CONFIGURATION_UPDATING' });
});

test('completed update cannot report success after an old projection is restored', async t => {
  const f = await configurationUpdateFixture(t), before = f.contractFiles();
  await f.update({ dryRun: false });
  fs.writeFileSync(f.main.taskContractPath, before[f.main.taskContractPath]);
  const snapshotBefore = snapshot(f);
  await assert.rejects(f.update({ dryRun: false }), { code: 'CONFIGURATION_UPDATE_FILE_CHANGED' });
  assert.deepEqual(snapshot(f), snapshotBefore);
  assert.equal(f.scheduler.configurationFence(f.repository).state, 'ready');
});

test('CLI defaults to dry-run, applies only explicitly and reads back the exact candidate contract', async t => {
  const f = await configurationUpdateFixture(t), before = snapshot(f);
  fs.writeFileSync(f.sourcePath, JSON.stringify(f.config, null, 2) + '\n');
  const args = ['repo', 'update', f.repository, '--config', f.sourcePath, '--expected-config-hash', f.registration.configHash, '--registry', f.registry.directory, '--json'];
  const invoke = async flags => {
    let stdout = '', stderr = '';
    const code = await runFactoryCli([...args, ...flags], { run: f.run, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr, result: stdout.trim() ? JSON.parse(stdout) : null };
  };
  const dryRun = await invoke([]);
  assert.equal(dryRun.code, 0, dryRun.stderr); assert.equal(dryRun.result.status, 'dry_run');
  assert.deepEqual(snapshot(f), before); assertNoIntent(f);
  const reads = f.updateCalls.length;
  for (const flags of [['--policy', '/unread-policy.yaml'], ['--apply', '--dry-run']]) {
    const rejected = await invoke(flags); assert.notEqual(rejected.code, 0);
    assert.deepEqual(snapshot(f), before); assertNoIntent(f); assert.equal(f.updateCalls.length, reads);
  }
  const applied = await invoke(['--apply']);
  assert.equal(applied.code, 0, applied.stderr); assert.equal(applied.result.status, 'updated');
  assert.deepEqual(f.registry.get(f.repository).config, JSON.parse(fs.readFileSync(f.sourcePath)));
  assert.equal(applied.result.configHash, configurationHash(f.config));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.main.dispatchConfigPath)).factoryConfig, f.config);
  const repeated = await invoke(['--apply']); assert.equal(repeated.code, 0, repeated.stderr); assert.equal(repeated.result.status, 'already_updated');
  assertReadOnlyCalls(f);
});
