import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const configure = path.join(root, 'scripts/configure-local.mjs');

async function fixture(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, content, { mode: 0o644 });
  return { dir, config };
}

async function run(config) {
  try {
    return { code: 0, ...await exec(process.execPath, [configure, config]) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('configuration protects persistent state and refuses a live server', async t => {
  // These tests share the fixed control-plane port and must run in sequence.
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(3100, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));

  await t.test('idempotent, private, preserves signup policy and secrets', async t => {
    const secret = 'SENTINEL_CREDENTIAL_MUST_NOT_APPEAR';
    const { dir, config } = await fixture(t, JSON.stringify({
      server: { port: 3100, customBindHost: '0.0.0.0', unrelated: 'keep' },
      auth: { disableSignUp: true, publicBaseUrl: 'https://old.invalid' },
      database: { connectionString: secret },
    }));
    let previous;
    for (let i = 0; i < 2; i++) {
      const result = await run(config);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
      const actual = JSON.parse(await fs.readFile(config, 'utf8'));
      assert.deepEqual(actual.server, {
        port: 3100, unrelated: 'keep', deploymentMode: 'authenticated',
        exposure: 'private', bind: 'loopback', host: '127.0.0.1',
        allowedHostnames: [], serveUi: true,
      });
      assert.deepEqual(actual.auth, { disableSignUp: true, baseUrlMode: 'auto' });
      assert.equal(actual.database.connectionString, secret);
      assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
      if (previous) assert.deepEqual(actual, previous);
      previous = actual;
    }
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  });

  await t.test('fresh config allows initial registration', async t => {
    const { config } = await fixture(t, JSON.stringify({ server: {} }));
    const result = await run(config);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).auth.disableSignUp, false);
  });

  await t.test('malformed config is unchanged and errors redact contents', async t => {
    const secret = 'SENTINEL_INVALID_JSON_SECRET';
    const { dir, config } = await fixture(t, secret);
    const result = await run(config);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Cannot read a valid Paperclip config object/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    assert.equal(await fs.readFile(config, 'utf8'), secret);
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  });

  await t.test('refuses an occupied control-plane port without writing', async t => {
    const original = JSON.stringify({ server: { port: 3100 } });
    const { config } = await fixture(t, original);
    const server = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(3100, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const result = await run(config);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Port 3100 is in use/);
    assert.equal(await fs.readFile(config, 'utf8'), original);
  });
});

test('wrapper fixes instance scope, working directory, and preserves arguments', async t => {
  const { dir } = await fixture(t, '{}');
  const cli = path.join(dir, 'fake-cli');
  await fs.writeFile(cli, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$PAPERCLIP_HOME" "$PAPERCLIP_INSTANCE_ID" "$@"\n', { mode: 0o700 });
  const result = await exec('/bin/bash', [path.join(root, 'scripts/paperclip'), 'issue', 'a spaced argument', '--json'], {
    cwd: root,
    env: { ...process.env, PAPERCLIP_HOME: dir, PAPERCLIP_INSTANCE_ID: 'test-factory', PAPERCLIP_CLI: cli },
  });
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [dir, dir, 'test-factory', 'issue', 'a spaced argument', '--json']);
});
