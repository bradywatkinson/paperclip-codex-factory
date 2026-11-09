import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseCloudPage } from '../lib/cloud-reconcile.mjs';

const directory = new URL('../docs/codex-cloud/fixtures/0.167.0/', import.meta.url);
const read = filename => fs.readFileSync(new URL(filename, directory), 'utf8');

test('captured Codex 0.167.0 read-only observations retain provenance and parse as the production Cloud contract', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.cli_version, '0.167.0');
  assert.equal(manifest.cloudSubmissions, false);
  assert.match(manifest.executable_sha256, /^[a-f0-9]{64}$/);
  for (const command of manifest.commands) {
    assert.equal(command.executable, manifest.executable);
    assert.equal(command.cli_version, manifest.cli_version);
    assert.equal(command.exit_code, 0, command.name);
    assert.equal(command.signal, null, command.name);
    assert.equal(command.timed_out, false, command.name);
    assert.equal(command.error_code, null, command.name);
    assert.ok(Date.parse(command.finished_at_utc) >= Date.parse(command.started_at_utc), command.name);
    assert.ok(command.timeout_seconds > 0, command.name);
    assert.ok(Array.isArray(command.argv), command.name);
    read(command.stdout);
    read(command.stderr);
  }
  const version = manifest.commands.find(command => command.name === 'version');
  assert.equal(read(version.stdout).trim(), 'codex-cli 0.167.0');
  const listing = manifest.commands.find(command => command.name === 'environment-list');
  assert.deepEqual(listing.argv, ['cloud', 'list', '--env', manifest.environment_id, '--limit', '1', '--json']);
  const page = parseCloudPage(read(listing.stdout));
  assert.equal(page.tasks.length, 1);
  const task = page.tasks[0];
  assert.equal(task.environment_label, 'bradywatkinson/story-keeper');
  assert.ok(task.environment_id === null || task.environment_id === manifest.environment_id);
  assert.ok(['pending', 'ready'].includes(task.status));
  assert.equal(task.url, 'https://chatgpt.com/codex/tasks/' + task.id);
  assert.ok(Number.isFinite(Date.parse(task.updated_at)));
  for (const count of Object.values(task.summary)) assert.ok(Number.isInteger(count) && count >= 0);
  assert.equal(task.title, '[redacted task title]');
  assert.ok(listing.redactions.includes('stdout.tasks[0].title'));
  const historical = manifest.commands.find(command => command.name === 'historical-task-status');
  assert.deepEqual(historical.argv, ['cloud', 'status', manifest.historical_task_id]);
  assert.match(read(historical.stdout), /^\[READY\]/);
});
