import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';

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
