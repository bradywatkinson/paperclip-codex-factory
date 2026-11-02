import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function temporaryHome(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-bootstrap-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(home) {
  const env = { ...process.env, HOME: home };
  for (const key of ['PAPERCLIP_CLI', 'PAPERCLIP_SHIM_PATH', 'PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PORT', 'PAPERCLIP_TELEMETRY_DISABLED']) delete env[key];
  return env;
}

test('wrapper prefers global launcher and selects it for native services', async t => {
  const home = await temporaryHome(t);
  const launcher = path.join(home, '.local/share/paperclip-factory/bin/paperclipai');
  const managed = path.join(home, '.local/bin/paperclipai');
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.mkdir(path.dirname(managed), { recursive: true });
  await fs.mkdir(path.join(home, '.paperclip'));
  await fs.writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" global "$PAPERCLIP_SHIM_PATH" "$PAPERCLIP_TELEMETRY_DISABLED" "$@"\n', { mode: 0o700 });
  await fs.writeFile(managed, '#!/bin/sh\necho managed\n', { mode: 0o700 });
  const options = { env: cleanEnv(home) };
  const global = await exec('/bin/bash', [path.join(root, 'scripts/paperclip'), 'service', 'status'], options);
  assert.deepEqual(global.stdout.trimEnd().split('\n'), ['global', launcher, '1', 'service', 'status']);
  const explicitShim = path.join(home, 'explicit-service-launcher');
  const explicit = await exec('/bin/bash', [path.join(root, 'scripts/paperclip')], {
    env: { ...options.env, PAPERCLIP_CLI: launcher, PAPERCLIP_SHIM_PATH: explicitShim },
  });
  assert.deepEqual(explicit.stdout.trimEnd().split('\n'), ['global', explicitShim, '1']);
  await fs.rm(launcher);
  const fallback = await exec('/bin/bash', [path.join(root, 'scripts/paperclip')], options);
  assert.equal(fallback.stdout.trim(), 'managed');
});

test('global bootstrap generates a launcher that quotes runtime and payload paths', async t => {
  const dir = await temporaryHome(t);
  const home = path.join(dir, "home with spaces ' $(touch INJECTED)");
  const bin = path.join(dir, "node bin ' $(touch INJECTED)");
  const npmRoot = path.join(dir, 'npm-root');
  const npmBin = path.join(npmRoot, 'npm/bin');
  const record = path.join(dir, 'npm-args.json');
  const realNode = process.execPath;
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(npmBin, { recursive: true });
  // Stubs make this a filesystem/shell test: no real npm installation or download.
  const node = path.join(bin, 'node');
  await fs.writeFile(node, '#!/bin/bash\nif [[ "$1" == -e ]]; then exit 0; fi\nexec "$FIXTURE_REAL_NODE" "$@"\n', { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_NPM_ROOT"\n', { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 20000000 0 20000000 0%% /\\n"\n', { mode: 0o700 });
  await fs.writeFile(path.join(npmBin, 'npx-cli.js'), '');
  await fs.writeFile(path.join(npmBin, 'npm-cli.js'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify(args));
const prefix = args[args.indexOf('--prefix') + 1];
const entry = path.join(prefix, 'lib/node_modules/paperclipai/dist/index.js');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, "const {spawnSync}=require('node:child_process'); const codex=spawnSync('codex',['--version'],{encoding:'utf8'}); console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,codexStatus:codex.status,codexOutput:codex.stdout?.trim()}))");
`);
  const env = {
    ...cleanEnv(home), PAPERCLIP_NODE: node, PAPERCLIP_INSTALL_METHOD: 'global',
    FIXTURE_REAL_NODE: realNode, FIXTURE_NPM_ROOT: npmRoot, FIXTURE_RECORD: record,
  };
  await exec('/bin/bash', [path.join(root, 'scripts/bootstrap')], { cwd: dir, env });
  const args = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.equal(args[0], 'install');
  assert.ok(args.includes('--global'));
  assert.equal(args[args.indexOf('--prefix') + 1], path.join(home, '.local/share/paperclip-global'));
  assert.ok(args.includes('paperclipai@2026.1023.0'));
  const launcher = path.join(home, '.local/share/paperclip-factory/bin/paperclipai');
  const cliBin = path.join(home, '.local/bin');
  await fs.mkdir(cliBin, { recursive: true });
  await fs.writeFile(path.join(cliBin, 'codex'), '#!/bin/sh\nprintf "%s\\n" fixture-codex\n', { mode: 0o700 });
  assert.equal((await fs.stat(launcher)).mode & 0o777, 0o700);
  const launched = await exec(launcher, ['argument with spaces', '$(touch INJECTED)', "quote'argument"], { cwd: dir, env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  const result = JSON.parse(launched.stdout);
  assert.deepEqual(result.args, ['argument with spaces', '$(touch INJECTED)', "quote'argument"]);
  assert.deepEqual(result.path.split(path.delimiter).slice(0, 4), [bin, cliBin, '/opt/homebrew/bin', '/usr/local/bin']);
  assert.equal(result.codexStatus, 0);
  assert.equal(result.codexOutput, 'fixture-codex');
  assert.ok(!(await fs.readdir(dir)).includes('INJECTED'));
  assert.deepEqual(await fs.readdir(path.dirname(launcher)), ['paperclipai']);
});
