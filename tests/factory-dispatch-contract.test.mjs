import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt, validateProjectConfig } from '../lib/cloud-dispatch.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const project = () => ({ schemaVersion: 1, companyId: ID, projectId: ID, repository: 'example/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'code_change', factoryConfig: { schemaVersion: 1, repository: 'example/project', cloud: { environmentId: 'a'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } }, delivery: { requiredChecks: ['unit'] } } });
const task = description => ({ id: ID, title: 'Repair a bounded defect', description });
test('registered dispatch rejects missing or ambiguous immutable task base before Cloud work', () => {
  const config = validateProjectConfig(project());
  for (const description of ['Do the work.', `Factory base SHA: ${'b'.repeat(40)}\nFactory base SHA: ${'c'.repeat(40)}`]) {
    assert.throws(() => buildPrompt(task(description), config), { code: 'FACTORY_TASK_BASE_REQUIRED' });
  }
});
test('registered dispatcher consumes implementation role and configured commands and gates', () => {
  const config = validateProjectConfig(project());
  const prompt = buildPrompt(task(`Factory base SHA: ${'b'.repeat(40)}\nFix the defect and report evidence.`), config);
  assert.match(prompt, /implementer/i);
  assert.ok(prompt.includes('b'.repeat(40)));
  assert.ok(prompt.includes('"argv":["node","--test"]'));
  assert.ok(prompt.includes('"requiredChecks":["unit"]'));
  assert.ok(prompt.includes('"autoMerge":false'));
});
test('registered contracts cannot override the validated repository, environment, branch or retry ceiling', () => {
  for (const changed of [
    { ...project(), repository: 'other/project' },
    { ...project(), environmentId: 'c'.repeat(32) },
    { ...project(), branch: 'other' },
  ]) assert.throws(() => validateProjectConfig(changed), { code: 'FACTORY_CONFIG_BINDING_MISMATCH' });
  assert.throws(() => validateProjectConfig({ ...project(), attempt: 4 }), { code: 'FACTORY_ATTEMPT_LIMIT' });
});
