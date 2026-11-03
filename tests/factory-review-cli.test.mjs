import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runFactoryReviewCli } from '../scripts/factory-review.mjs';
import { reviewFixture } from './fixtures/review-runtime.mjs';
const invoke = async (args, dependencies = {}) => { let stdout = '', stderr = ''; const code = await runFactoryReviewCli(args, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, ...dependencies }); return { code, stdout, stderr }; };
test('review CLI refuses absent registry without creating one and reports unsupported arguments', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-review-cli-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'missing'), result = await invoke(['status', 'fixture/project', '--registry', missing, '--json']); assert.equal(result.code, 1); assert.equal(fs.existsSync(missing), false); assert.match(result.stderr, /FACTORY_REGISTRY_NOT_FOUND/);
  assert.equal((await invoke(['start', 'fixture/project', '--invented'])).code, 1);
});
test('review CLI bootstrap, approved start, status and explicit pause/resume use concrete durable state', async t => {
  const f = reviewFixture(t), registry = path.dirname(path.join(f.registry.directory, 'registry.sqlite')), common = ['--registry', registry, '--json'];
  assert.equal((await invoke(['bootstrap', f.repository, ...common, '--dry-run'], { run: f.run })).code, 0); assert.equal(f.agents.size, 0);
  assert.equal((await invoke(['bootstrap', f.repository, ...common], { run: f.run })).code, 0); await f.makeObservation();
  const startArgs = ['start', f.repository, ...common, '--observation', f.observationPath, '--patch', f.patchPath, '--test-check', 'unit'];
  assert.match((await invoke(startArgs, { run: f.run })).stderr, /REVIEW_DISPATCH_APPROVAL_REQUIRED/);
  const started = await invoke([...startArgs, '--approve-dispatch'], { run: f.run }); assert.equal(started.code, 0, started.stderr); const id = JSON.parse(started.stdout).pipeline.pipelineId;
  assert.equal(JSON.parse((await invoke(['status', f.repository, ...common])).stdout).pipelines[0].pipelineId, id);
  assert.equal((await invoke(['pause', f.repository, ...common, '--pipeline', id])).code, 0); assert.equal((await invoke(['resume', f.repository, ...common, '--pipeline', id])).code, 0);
});
test('review CLI rejects source artifact and receipt drift instead of creating unverified work', async t => {
  const f = reviewFixture(t); await f.bootstrap(); await f.makeObservation();
  const input = JSON.parse(fs.readFileSync(f.observationPath)); input.delivery.association.executionId = '11111111-1111-4111-8111-111111111111'; const modified = path.join(f.directory, 'altered.json'); fs.writeFileSync(modified, JSON.stringify(input));
  const result = await invoke(['start', f.repository, '--registry', f.registry.directory, '--observation', modified, '--patch', f.patchPath, '--approve-dispatch', '--test-check', 'unit', '--json'], { run: f.run });
  assert.equal(result.code, 1); assert.match(result.stderr, /REVIEW_SOURCE_EXECUTION_CHANGED/); assert.equal(f.issues.size, 1);
});
