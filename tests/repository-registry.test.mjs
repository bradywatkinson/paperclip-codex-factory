import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryRegistry, validateConfigurationUpdate } from '../lib/repository-registry.mjs';

const config = () => ({ schemaVersion: 1, repository: 'example/project', defaultBranch: 'main', cloud: { environmentId: 'a'.repeat(32) }, commands: { test: { argv: ['node', '--test'], timeoutMs: 60_000 } } });
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-registry-'));
  const registry = new RepositoryRegistry({ directory });
  t.after(async () => { registry.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, registry };
}
test('repository registration survives restart and deduplicates canonical configuration', async t => {
  const { directory, registry } = await setup(t);
  const first = registry.register(config(), { sourcePath: '/fixture/.factory.yaml' });
  assert.equal(first.created, true);
  const next = registry.register(config(), { sourcePath: '/another/checkout/.factory.yaml' });
  assert.equal(next.created, false);
  assert.deepEqual(next.registration, first.registration);
  const reader = new RepositoryRegistry({ directory });
  try { assert.deepEqual(reader.get('EXAMPLE/PROJECT'), first.registration); }
  finally { reader.close(); }
  assert.equal((await fs.stat(path.join(directory, 'registry.sqlite'))).mode & 0o777, 0o600);
});
test('re-registration never silently replaces a changed Cloud environment or branch', async t => {
  const { registry } = await setup(t);
  const first = registry.register(config(), { sourcePath: '/fixture/.factory.yaml' });
  const changed = config(); changed.cloud.environmentId = 'b'.repeat(32);
  assert.throws(() => registry.register(changed, { sourcePath: '/fixture/.factory.yaml' }), { code: 'REPOSITORY_ALREADY_REGISTERED_WITH_DIFFERENT_CONFIG' });
  assert.deepEqual(registry.get('example/project'), first.registration);
});
test('durable bootstrap intent fences concurrent owners and preserves an ambiguous write', async t => {
  const { registry, directory } = await setup(t);
  const { registration } = registry.register(config(), { sourcePath: '/fixture/.factory.yaml' });
  const original = registry.beginOperation('example/project', { expectedConfigHash: registration.configHash, data: { operationId: 'fixture' } });
  const competitor = new RepositoryRegistry({ directory });
  try {
    assert.throws(() => competitor.beginOperation('example/project', { expectedConfigHash: registration.configHash, data: {} }), { code: 'BOOTSTRAP_OPERATION_EXISTS' });
    const pending = registry.updateOperation('example/project', { expectedRevision: original.revision, state: 'creating_project', data: { ...original.data, pending: { kind: 'project', marker: 'fixture-owned-marker' } } });
    assert.throws(() => competitor.updateOperation('example/project', { expectedRevision: original.revision, state: 'configured', data: {} }), { code: 'BOOTSTRAP_OPERATION_CONFLICT' });
    assert.deepEqual(competitor.getOperation('example/project'), pending);
  } finally { competitor.close(); }
});
test('bootstrap cannot start against stale or absent registration', async t => {
  const { registry } = await setup(t);
  registry.register(config(), { sourcePath: '/fixture/.factory.yaml' });
  assert.throws(() => registry.beginOperation('example/project', { expectedConfigHash: 'stale' }), { code: 'REGISTRY_CONFIG_CHANGED' });
  assert.throws(() => registry.beginOperation('example/missing', { expectedConfigHash: 'stale' }), { code: 'REGISTRY_CONFIG_CHANGED' });
  assert.equal(registry.getOperation('example/project'), null);
});

test('configuration update scope preserves all existing checks and every other effective field', async t => {
  const { registry } = await setup(t);
  const { registration } = registry.register({ ...config(), delivery: { requiredChecks: ['receipt'] } }, { sourcePath: '/fixture/.factory.yaml' });
  const candidate = { ...registration.config, delivery: { ...registration.config.delivery, requiredChecks: ['receipt', 'application tests'] } };
  assert.deepEqual(validateConfigurationUpdate(registration, candidate), candidate);
  for (const bad of [
    { ...candidate, defaultBranch: 'other' },
    { ...candidate, cloud: { environmentId: 'b'.repeat(32) } },
    { ...candidate, commands: { test: { argv: ['other'], timeoutMs: 60_000 } } },
    { ...candidate, delivery: { ...candidate.delivery, requiredChecks: ['application tests'] } },
  ]) assert.throws(() => validateConfigurationUpdate(registration, bad), { code: 'CONFIGURATION_UPDATE_SCOPE_UNSUPPORTED' });
  assert.deepEqual(registry.get(registration.repository), registration);
});

test('configuration guard rejects stale and updating registrations before staging review writes', async t => {
  const { registry } = await setup(t);
  const { registration } = registry.register(config(), { sourcePath: '/fixture/.factory.yaml' });
  const operation = registry.beginOperation(registration.repository, { expectedConfigHash: registration.configHash, state: 'configured' });
  let calls = 0;
  assert.equal(registry.withConfigurationGuard(registration.repository, registration.configHash, () => ++calls), 1);
  assert.throws(() => registry.withConfigurationGuard(registration.repository, 'a'.repeat(64), () => ++calls), { code: 'REGISTRY_CONFIG_CHANGED' });
  registry.updateOperation(registration.repository, { expectedRevision: operation.revision, state: 'configuration_updating', data: {} });
  assert.throws(() => registry.withConfigurationGuard(registration.repository, registration.configHash, () => ++calls), { code: 'REGISTRY_CONFIG_CHANGED' });
  assert.equal(calls, 1);
});

test('schema-one registry upgrade preserves configured bindings and registration bytes', async t => {
  const { directory, registry } = await setup(t);
  const { registration } = registry.register(config(), { sourcePath: '/fixture/.factory.yaml' });
  const operation = registry.beginOperation(registration.repository, { expectedConfigHash: registration.configHash, state: 'configured', data: { operationId: 'preserved-id', projectId: 'preserved-project' } });
  registry.database.exec('DROP TABLE configuration_updates; PRAGMA user_version=1;');
  const reader = new RepositoryRegistry({ directory });
  try {
    assert.deepEqual(reader.get(registration.repository), registration);
    assert.deepEqual(reader.getOperation(registration.repository), operation);
    assert.equal(reader.database.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(reader.getConfigurationUpdate(registration.repository), null);
  } finally { reader.close(); }
});
