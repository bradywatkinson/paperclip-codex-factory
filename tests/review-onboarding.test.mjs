import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { bootstrapReviewRoles, buildReviewPlan, ReviewRoleBindings, verifyReviewRole, reviewCommands, withReviewConfiguration } from '../lib/review-onboarding.mjs';
import { reviewFixture } from './fixtures/review-runtime.mjs';

test('role provisioning dry-run creates no files, agents or main registration changes', async t => {
  const f = reviewFixture(t), before = f.registry.getOperation(f.repository), plan = buildReviewPlan({ registry: f.registry, repository: f.repository });
  const result = await bootstrapReviewRoles({ registry: f.registry, repository: f.repository, dryRun: true, run: f.run });
  assert.equal(result.status, 'planned'); assert.equal(fs.existsSync(plan.directory), false); assert.equal(f.calls.length, 0); assert.deepEqual(f.registry.getOperation(f.repository), before);
});
test('three separate owned process agents use immutable private role configs and no scheduled heartbeat', async t => {
  const f = reviewFixture(t), before = f.registry.getOperation(f.repository), result = await f.bootstrap();
  assert.equal(result.status, 'configured'); assert.equal(new Set(result.roles.map(row => row.agentId)).size, 3);
  for (const row of result.roles) { const agent = f.agents.get(row.agentId); assert.equal(agent.adapterType, 'process'); assert.equal(agent.runtimeConfig.heartbeat.enabled, false); assert.equal(agent.runtimeConfig.heartbeat.intervalSec, 0); assert.equal(agent.runtimeConfig.heartbeat.maxConcurrentRuns, 1); assert.ok(agent.adapterConfig.args[0].endsWith('/scripts/review-dispatch.mjs')); assert.equal(fs.statSync(agent.adapterConfig.args.at(-1)).mode & 0o777, 0o600); assert.notEqual(agent.id, f.implementationAgentId); }
  await f.bootstrap(); assert.equal(f.calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'create').length, 3); assert.deepEqual(f.registry.getOperation(f.repository), before);
});
test('ambiguous accepted role creation recovers exact marker by reads without a duplicate agent', async t => {
  const f = reviewFixture(t); f.createAgentUnknown = true;
  await assert.rejects(f.bootstrap(), { code: 'REVIEW_ROLE_CREATION_UNKNOWN' }); assert.equal(f.agents.size, 1);
  f.createAgentUnknown = false; const result = await f.bootstrap(); assert.equal(result.status, 'configured'); assert.equal(f.agents.size, 3);
  assert.equal(f.calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'create').length, 3);
});
test('absent unknown create receipt never authorizes another role create', async t => {
  const f = reviewFixture(t); f.createAgentUnknown = true; await assert.rejects(f.bootstrap()); f.agents.clear(); f.createAgentUnknown = false;
  await assert.rejects(f.bootstrap(), { code: 'REVIEW_ROLE_CREATION_UNKNOWN' }); assert.equal(f.calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'create').length, 1);
});
test('hire approval remains outstanding and exact runtime or ownership drift is rejected', async t => {
  const f = reviewFixture(t); f.agentApproval = true; assert.equal((await f.bootstrap()).status, 'approval_required');
  const plan = buildReviewPlan({ registry: f.registry, repository: f.repository }), store = new ReviewRoleBindings({ directory: plan.directory }), { pc } = reviewCommands(plan, f.run);
  try { await assert.rejects(verifyReviewRole({ plan, store, role: 'reviewer', pc }), { code: 'REVIEW_HIRE_APPROVAL_REQUIRED' }); }
  finally { store.close(); }
  for (const agent of f.agents.values()) agent.status = 'idle'; f.agentApproval = false; assert.equal((await f.bootstrap()).status, 'configured');
  f.agents.values().next().value.adapterConfig.args.push('--unexpected'); await assert.rejects(f.bootstrap(), { code: 'REVIEW_ROLE_BINDING_CHANGED' });
});
test('durable role intent compare-and-swap rejects stale writers and unsafe stores', t => {
  const f = reviewFixture(t), directory = path.join(f.directory, 'isolated-store'), first = new ReviewRoleBindings({ directory }), second = new ReviewRoleBindings({ directory });
  try { const claim = first.begin('fixture', { safe: true }); first.update(claim.record, 'sending', { safe: true }); assert.throws(() => second.update(claim.record, 'sending', { safe: true }), { code: 'REVIEW_INTENT_STALE' }); }
  finally { first.close(); second.close(); }
  assert.equal(fs.statSync(path.join(directory, 'role-bindings.sqlite')).mode & 0o777, 0o600);
});

function pendingRegistry(f) {
  const operation = f.registry.getOperation(f.repository);
  f.registry.updateOperation(f.repository, { expectedRevision: operation.revision, state: 'configuration_updating', data: operation.data });
}
function pendingScheduler(f) {
  f.scheduler.setPaused(true);
  f.scheduler.beginConfigurationUpdate({ repository: f.repository, updateId: randomUUID(), previousHash: f.registration.configHash, nextHash: 'f'.repeat(64) });
}
test('pending registry rejects review plans and synchronous intent before invoking its action', t => {
  const f = reviewFixture(t), plan = buildReviewPlan({ registry: f.registry, repository: f.repository }); let invoked = false;
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(plan)), 'registry'), false);
  pendingRegistry(f);
  assert.throws(() => buildReviewPlan({ registry: f.registry, repository: f.repository }), { code: 'REGISTRY_CONFIG_CHANGED' });
  assert.throws(() => withReviewConfiguration(plan, () => { invoked = true; }), { code: 'REGISTRY_CONFIG_CHANGED' });
  assert.equal(invoked, false);
});
test('read-only native verification remains available during update but mutation is fenced', async t => {
  const f = reviewFixture(t), plan = buildReviewPlan({ registry: f.registry, repository: f.repository }), { pc } = reviewCommands(plan, f.run);
  pendingRegistry(f);
  assert.deepEqual(await pc(['agent', 'list', '--company-id', f.companyId]), []);
  await assert.rejects(pc(['agent', 'create', '--company-id', f.companyId, '--payload-json', '{}']), { code: 'REGISTRY_CONFIG_CHANGED' });
  assert.equal(f.calls.filter(row => row.args[1] === 'create').length, 0);
});
test('scheduler cutover rejects review plan and first provisioning intent without creating native resources', async t => {
  const f = reviewFixture(t); pendingScheduler(f);
  await assert.rejects(f.bootstrap(), { code: 'SCHEDULER_CONFIGURATION_UPDATING' });
  assert.equal(f.calls.length, 0); assert.equal(f.agents.size, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(f.main.dispatchConfigPath), 'review')), false);
});
test('configuration update between role reads and create leaves planned intent and sends no native create', async t => {
  const f = reviewFixture(t), run = f.run;
  f.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (args[0] === 'agent' && args[1] === 'list') pendingRegistry(f);
    return result;
  };
  await assert.rejects(f.bootstrap(), { code: 'REGISTRY_CONFIG_CHANGED' });
  const store = new ReviewRoleBindings({ directory: path.join(path.dirname(f.main.dispatchConfigPath), 'review') });
  try { assert.equal(store.get('role:reviewer').state, 'planned'); assert.equal(store.list().length, 1); } finally { store.close(); }
  assert.equal(f.agents.size, 0); assert.equal(f.calls.some(row => row.args[1] === 'create'), false);
});
