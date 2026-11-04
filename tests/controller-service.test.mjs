import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';
import { manageControllerService, planControllerService, validateControllerServiceConfig, controllerServiceEnvironment, CONTROLLER_SERVICE_LABEL } from '../lib/controller-service.mjs';
import { RotatingControllerLog } from '../lib/controller-log.mjs';
import { runControllerServiceCli } from '../scripts/controller-service.mjs';
import { runControllerServiceProcess } from '../scripts/controller-service-runner.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-controller-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home with spaces & unicode'), instance = path.join(home, '.paperclip/instances/factory');
  fs.mkdirSync(instance, { recursive: true });
  const config = validateControllerServiceConfig({ nodeCommand: process.execPath, instanceDirectory: instance }, { home });
  const registry = new RepositoryRegistry({ directory: config.registryDirectory }); registry.close();
  const scheduler = new DispatchScheduler({ directory: config.schedulerDirectory }); scheduler.close();
  const plan = planControllerService({ config, home, uid: 501 });
  const state = { calls: [], loaded: false, active: false, permissionDenied: false, version: 'v24.15.0', loadedConfig: null, lastExitCode: 0, loadedProgram: config.nodeCommand, loadedRunner: config.runnerEntrypoint, nativeOutput: null };
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (command !== '/bin/launchctl') { assert.equal(args[0], '--version'); return { code: 0, stdout: state.version + '\n', stderr: '' }; }
    if (state.permissionDenied) return { code: 5, stdout: '', stderr: 'Operation not permitted PRIVATE_FIXTURE_DIAGNOSTIC' };
    if (args[0] === 'print') return state.loaded ? { code: 0, stdout: state.nativeOutput ?? `${plan.target} = {\n program = ${state.loadedProgram}\n state = ${state.active ? 'running' : 'waiting'}\n pid = ${state.active ? 4321 : 0}\n last exit code = ${state.lastExitCode}\n arguments = {\n ${state.loadedProgram}\n ${state.loadedRunner}\n --config\n ${state.loadedConfig}\n }\n}`, stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service "' + CONTROLLER_SERVICE_LABEL + '" in domain for user gui: 501' };
    if (args[0] === 'bootstrap') {
      const source = fs.readFileSync(plan.plistPath, 'utf8'), selected = /config=([a-f0-9]{64})/.exec(source)[1];
      state.loadedConfig = path.join(instance, 'managed-controller', 'config.' + selected + '.json');
      const loaded = JSON.parse(fs.readFileSync(state.loadedConfig, 'utf8')); state.loadedProgram = loaded.nodeCommand; state.loadedRunner = loaded.runnerEntrypoint;
      state.loaded = true; state.active = true;
    } else if (args[0] === 'bootout') { state.loaded = false; state.active = false; }
    else if (args[0] === 'kickstart') state.active = true;
    else assert.equal(args[0], 'enable');
    return { code: 0, stdout: '', stderr: '' };
  };
  const invoke = (command, options = {}) => manageControllerService({ command, config: command === 'install' ? config : undefined, home, instanceDirectory: instance, uid: 501, run, platform: 'darwin', ...options });
  return { root, home, instance, config, plan, state, run, invoke };
}

test('install dry-run validates concrete paths/runtime and renders XML without writes or launchctl mutations', async t => {
  const f = fixture(t), result = await f.invoke('install', { dryRun: true });
  assert.equal(result.status, 'planned'); assert.equal(result.plan.label, 'ing.paperclip.codex-factory.controller');
  assert.equal(result.plan.plist.includes('&amp;'), true); assert.equal(result.plan.plist.includes(f.home), false);
  assert.match(result.plan.plist, /<key>WorkingDirectory<\/key><string>.*instances\/factory<\/string>/);
  assert.match(result.plan.plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(result.plan.plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(result.plan.plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(result.plan.plist, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
  assert.equal(fs.existsSync(f.plan.privateDirectory), false); assert.equal(fs.existsSync(f.plan.plistPath), false);
  assert.deepEqual(fs.readdirSync(f.config.registryDirectory), ['registry.sqlite']);
  assert.deepEqual(fs.readdirSync(f.config.schedulerDirectory), ['dispatch-scheduler.sqlite']);
  assert.equal(result.databaseSchemaChecked, false);
  assert.equal(f.state.calls.some(call => call.command === '/bin/launchctl'), false);
});

test('owned installation is exact, private, idempotent and has no credentials or shell interpolation', async t => {
  const f = fixture(t), first = await f.invoke('install');
  assert.equal(first.status, 'installed'); assert.equal((await f.invoke('install')).status, 'already_installed');
  for (const filename of [f.plan.configPath, f.plan.receiptPath, f.plan.plistPath]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const source = fs.readFileSync(f.plan.plistPath, 'utf8');
  assert.equal(source.includes('PAPERCLIP_API_KEY'), false); assert.equal(source.includes('OPENAI_API_KEY'), false);
  const env = controllerServiceEnvironment(f.config);
  assert.equal(env.PAPERCLIP_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(env.PATH.startsWith(path.dirname(process.execPath)));
  assert.equal(env.PAPERCLIP_INSTANCE_ID, 'factory');
  assert.equal(f.state.calls.some(call => call.args.includes('sh') || call.args.includes('-c')), false);
});

test('installation accepts supported legacy/current registry and scheduler schemas without migrating them', async t => {
  for (const registryVersion of [1, 2]) for (const schedulerVersion of [1, 2]) await t.test(`registry ${registryVersion}, scheduler ${schedulerVersion}`, async t => {
    const f = fixture(t), names = [path.join(f.config.registryDirectory, 'registry.sqlite'), path.join(f.config.schedulerDirectory, 'dispatch-scheduler.sqlite')];
    for (const [index, version] of [registryVersion, schedulerVersion].entries()) {
      const db = new DatabaseSync(names[index]);
      try { if (version === 1) db.exec(`DROP TABLE ${index === 0 ? 'configuration_updates' : 'scheduler_configuration_fences'}; PRAGMA user_version=1;`); } finally { db.close(); }
    }
    const before = names.map(filename => fs.readFileSync(filename));
    assert.equal((await f.invoke('install')).status, 'installed');
    for (const [index, filename] of names.entries()) {
      assert.deepEqual(fs.readFileSync(filename), before[index]);
      const db = new DatabaseSync(filename, { readOnly: true });
      try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, index === 0 ? registryVersion : schedulerVersion); } finally { db.close(); }
    }
  });
});

test('foreign, future, incomplete and uninitialized database contracts reject before native control or publication', async t => {
  for (const [name, scheduler, mutation] of [
    ['future registry', false, 'PRAGMA user_version=3'],
    ['future scheduler', true, 'PRAGMA user_version=3'],
    ['foreign registry application', false, 'PRAGMA application_id=1234'],
    ['foreign scheduler application', true, 'PRAGMA application_id=1234'],
    ['uninitialized registry', false, 'PRAGMA user_version=0'],
    ['missing registry update table', false, 'DROP TABLE configuration_updates'],
    ['missing scheduler fence table', true, 'DROP TABLE scheduler_configuration_fences'],
    ['incomplete scheduler fence columns', true, 'ALTER TABLE scheduler_configuration_fences DROP COLUMN next_hash'],
    ['missing scheduler settings', true, 'DELETE FROM scheduler_settings'],
  ]) await t.test(name, async t => {
    const f = fixture(t), filename = path.join(scheduler ? f.config.schedulerDirectory : f.config.registryDirectory, scheduler ? 'dispatch-scheduler.sqlite' : 'registry.sqlite');
    const db = new DatabaseSync(filename); try { db.exec(mutation); } finally { db.close(); }
    await assert.rejects(f.invoke('install'), { code: 'CONTROLLER_SERVICE_DATABASE_UNSUPPORTED' });
    assert.equal(fs.existsSync(f.plan.privateDirectory), false); assert.equal(fs.existsSync(f.plan.plistPath), false);
    assert.equal(f.state.calls.some(call => call.command === '/bin/launchctl'), false);
  });
});

test('plist path escaping is XML-safe and accepted by the platform plist linter when present', t => {
  const f = fixture(t), source = f.plan.plist;
  const escaped = planControllerService({ config: { ...f.config, nodeCommand: path.join(f.home, 'node "quoted" <tag> & apostrophe\'') }, home: f.home, uid: 501 });
  assert.match(escaped.plist, /&amp;/);
  assert.match(escaped.plist, /&quot;quoted&quot;/); assert.match(escaped.plist, /&lt;tag&gt;/); assert.match(escaped.plist, /&apos;/);
  const temporary = path.join(f.root, 'generated.plist'); fs.writeFileSync(temporary, source);
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/plutil')) {
    const checked = spawnSync('/usr/bin/plutil', ['-lint', temporary], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  }
});

test('start/stop/status use actual launchctl state; plist presence alone is never active health', async t => {
  const f = fixture(t); await f.invoke('install');
  const installed = await f.invoke('status'); assert.equal(installed.installed, true); assert.equal(installed.loaded, false); assert.equal(installed.active, false);
  const started = await f.invoke('start'); assert.equal(started.status, 'running'); assert.equal(started.pid, 4321); assert.equal(started.loadedConfigMatches, true);
  await f.invoke('start');
  assert.equal(f.state.calls.filter(row => row.command === '/bin/launchctl' && row.args[0] === 'bootstrap').length, 1);
  const stopped = await f.invoke('stop'); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.active, false);
  assert.equal((await f.invoke('stop')).status, 'stopped');
  assert.equal(fs.existsSync(f.plan.plistPath), true);
  assert.equal(f.state.calls.every(row => row.command !== '/bin/launchctl' || row.args[0] !== 'kill'), true);
});

test('explicit replacement keeps prior loaded process until start reloads the exact new owned configuration', async t => {
  const f = fixture(t); await f.invoke('install'); await f.invoke('start');
  const changed = { ...f.config, intervalMs: 60000 }, before = fs.readFileSync(f.plan.plistPath, 'utf8');
  await assert.rejects(f.invoke('install', { config: changed }), { code: 'CONTROLLER_SERVICE_REPLACE_REQUIRED' });
  assert.equal(fs.readFileSync(f.plan.plistPath, 'utf8'), before);
  const dryRun = await f.invoke('install', { config: changed, dryRun: true });
  assert.equal(dryRun.requiresReplace, true); assert.deepEqual(dryRun.changes, ['intervalMs']);
  assert.equal((await f.invoke('install', { config: changed, replace: true })).status, 'updated');
  assert.equal(f.state.active, true); assert.equal((await f.invoke('status')).loadedConfigMatches, false);
  const restarted = await f.invoke('start'); assert.equal(restarted.status, 'running'); assert.equal(restarted.loadedConfigMatches, true);
  assert.equal(f.state.calls.filter(row => row.command === '/bin/launchctl' && row.args[0] === 'bootstrap').length, 2);
  assert.equal(f.state.calls.filter(row => row.command === '/bin/launchctl' && row.args[0] === 'bootout').length, 1);
});

test('foreign loaded label with no disk installation cannot be adopted or controlled', async t => {
  const f = fixture(t); f.state.loaded = true; f.state.active = true;
  f.state.loadedProgram = '/usr/bin/foreign'; f.state.loadedConfig = '/tmp/foreign.json';
  for (const command of ['install', 'start', 'stop', 'uninstall']) await assert.rejects(f.invoke(command), { code: 'CONTROLLER_SERVICE_UNOWNED_LOADED_JOB' });
  const status = await f.invoke('status'); assert.equal(status.status, 'needs_attention'); assert.equal(status.loadedOwnershipVerified, false);
  assert.equal(fs.existsSync(f.plan.plistPath), false); assert.equal(fs.existsSync(f.plan.privateDirectory), false);
  assert.equal(f.state.calls.filter(row => row.command === '/bin/launchctl').every(row => row.args[0] === 'print'), true);
});

test('expected config path cannot authenticate a foreign loaded program or extra/malformed arguments', async t => {
  const f = fixture(t); await f.invoke('install'); await f.invoke('start');
  f.state.loadedProgram = '/usr/bin/foreign';
  for (const command of ['install', 'start', 'stop', 'uninstall']) await assert.rejects(f.invoke(command), { code: 'CONTROLLER_SERVICE_UNOWNED_LOADED_JOB' });
  f.state.loadedProgram = f.config.nodeCommand;
  const native = `${f.plan.target} = {\n program = ${f.config.nodeCommand}\n state = running\n pid = 4321\n arguments = {\n ${f.config.nodeCommand}\n ${f.config.runnerEntrypoint}\n --config\n ${f.plan.configPath}\n EXTRA\n }\n}`;
  f.state.nativeOutput = native;
  const before = f.state.calls.length;
  for (const command of ['install', 'start', 'stop', 'uninstall']) await assert.rejects(f.invoke(command), { code: 'CONTROLLER_SERVICE_UNOWNED_LOADED_JOB' });
  assert.equal((await f.invoke('status')).status, 'needs_attention');
  assert.equal(f.state.calls.slice(before).filter(row => row.command === '/bin/launchctl').every(row => row.args[0] === 'print'), true);
  assert.equal(fs.existsSync(f.plan.plistPath), true);
});

test('private cwd rejects lexical traversal and real ancestor symlink containment', async t => {
  const f = fixture(t), repo = path.resolve('.');
  assert.throws(() => validateControllerServiceConfig({ ...f.config, controllerEntrypoint: path.join(repo, 'scripts') + '/../scripts/factory-controller.mjs', instanceDirectory: repo }, { home: f.home }), { code: 'CONTROLLER_SERVICE_PRIVATE_CWD_REQUIRED' });
  const linkedRepo = path.join(f.root, 'linked-repo'); fs.symlinkSync(repo, linkedRepo);
  await assert.rejects(f.invoke('install', { config: { ...f.config, controllerEntrypoint: path.join(linkedRepo, 'scripts/factory-controller.mjs'), instanceDirectory: repo } }), { code: 'CONTROLLER_SERVICE_PRIVATE_CWD_REQUIRED' });
  assert.equal(fs.existsSync(f.plan.plistPath), false);
});

test('unowned or manually altered plist is preserved even with replacement requested', async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.plan.plistPath), { recursive: true });
  const foreign = '<plist><dict><key>Label</key><string>' + CONTROLLER_SERVICE_LABEL + '</string></dict></plist>';
  fs.writeFileSync(f.plan.plistPath, foreign);
  await assert.rejects(f.invoke('install', { replace: true }), { code: 'CONTROLLER_SERVICE_UNOWNED_PLIST' });
  await assert.rejects(f.invoke('stop'), { code: 'CONTROLLER_SERVICE_UNOWNED_PLIST' });
  assert.equal(fs.readFileSync(f.plan.plistPath, 'utf8'), foreign); assert.equal(f.state.calls.length, 0);
  fs.unlinkSync(f.plan.plistPath); await f.invoke('install'); fs.appendFileSync(f.plan.plistPath, '\n<!-- user edit -->');
  await assert.rejects(f.invoke('install', { replace: true }), { code: 'CONTROLLER_SERVICE_UNOWNED_PLIST' });
  assert.match(fs.readFileSync(f.plan.plistPath, 'utf8'), /user edit/);
});

test('native permission failures remain unknown and never erase an installed service', async t => {
  const f = fixture(t); await f.invoke('install'); f.state.permissionDenied = true;
  const status = await f.invoke('status'); assert.equal(status.status, 'needs_attention'); assert.equal(status.loaded, null); assert.equal(status.active, null);
  await assert.rejects(f.invoke('uninstall'), { code: 'CONTROLLER_SERVICE_STATUS_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.plan.plistPath), true);
  assert.equal(JSON.stringify(status).includes('PRIVATE_FIXTURE_DIAGNOSTIC'), false);
});

test('a loaded crashing job or unrecognized native status cannot be reported as healthy', async t => {
  const f = fixture(t); await f.invoke('install'); await f.invoke('start');
  f.state.active = false; f.state.lastExitCode = 78;
  const crashed = await f.invoke('status'); assert.equal(crashed.status, 'needs_attention'); assert.equal(crashed.lastExitCode, 78);
  const unknown = await f.invoke('status', { run: async () => ({ code: 0, stdout: 'unrecognized native output', stderr: '' }) });
  assert.equal(unknown.status, 'needs_attention'); assert.equal(unknown.active, null);
});

test('missing/corrupt databases and wrong pinned runtime reject installation before publishing files', async t => {
  const f = fixture(t); f.state.version = 'v22.0.0';
  await assert.rejects(f.invoke('install'), { code: 'CONTROLLER_SERVICE_NODE_VERSION_MISMATCH' });
  assert.equal(fs.existsSync(f.plan.privateDirectory), false);
  f.state.version = 'v24.15.0'; fs.writeFileSync(path.join(f.config.registryDirectory, 'registry.sqlite'), 'foreign data');
  await assert.rejects(f.invoke('install'), { code: 'CONTROLLER_SERVICE_DATABASE_UNSUPPORTED' });
  assert.equal(fs.existsSync(f.plan.plistPath), false);
});

test('uninstall removes only the owned LaunchAgent and preserves configuration, logs and journal storage', async t => {
  const f = fixture(t); await f.invoke('install'); await f.invoke('start');
  fs.mkdirSync(f.config.logDirectory, { recursive: true }); fs.writeFileSync(path.join(f.config.logDirectory, 'controller.log'), 'prior diagnostics');
  assert.equal((await f.invoke('uninstall')).status, 'uninstalled');
  assert.equal(fs.existsSync(f.plan.plistPath), false); assert.equal(fs.existsSync(f.plan.configPath), true);
  assert.equal(fs.existsSync(path.join(f.config.registryDirectory, 'registry.sqlite')), true);
  assert.equal(fs.readFileSync(path.join(f.config.logDirectory, 'controller.log'), 'utf8'), 'prior diagnostics');
  assert.equal((await f.invoke('uninstall')).status, 'not_installed');
});

test('bounded combined logs rotate, redact split credentials and drop oversized lines without buffering them', t => {
  const f = fixture(t), reports = [];
  const log = new RotatingControllerLog({ directory: f.config.logDirectory, maxBytes: 1024, maxFiles: 3, maxLineBytes: 256, onReport: value => reports.push(value) });
  for (let index = 0; index < 100; index++) log.write('stdout', Buffer.from('line-' + index + '-' + 'x'.repeat(80) + '\n'));
  log.write('stderr', 'Authorization: Bea'); log.write('stderr', 'rer PRIVATE_TOKEN_SECRET\n');
  log.write('stdout', 'https://example.test/?token=PRIVATE_QUERY_SECRET\n');
  log.write('stderr', 'api_key=PRIVATE_KEY_SECRET\n');
  log.write('stdout', 'x'.repeat(20000)); log.write('stdout', '\n');
  log.write('stdout', '{"status":"idle"}\n'); log.close();
  const files = fs.readdirSync(f.config.logDirectory); assert.ok(files.length <= 3);
  let output = '';
  for (const name of files) { const filename = path.join(f.config.logDirectory, name); assert.ok(fs.statSync(filename).size <= 1024); assert.equal(fs.statSync(filename).mode & 0o777, 0o600); output += fs.readFileSync(filename, 'utf8'); }
  for (const secret of ['PRIVATE_TOKEN_SECRET', 'PRIVATE_QUERY_SECRET', 'PRIVATE_KEY_SECRET']) assert.equal(output.includes(secret), false);
  assert.match(output, /LOG_LINE_DROPPED/); assert.deepEqual(reports, ['idle']);
});

test('logging refuses symlink destinations rather than following or replacing them', t => {
  const f = fixture(t), target = path.join(f.root, 'operator-file'); fs.writeFileSync(target, 'preserve');
  fs.mkdirSync(f.config.logDirectory, { recursive: true }); fs.symlinkSync(target, path.join(f.config.logDirectory, 'controller.log'));
  assert.throws(() => new RotatingControllerLog({ directory: f.config.logDirectory }), { code: 'CONTROLLER_LOG_UNSAFE_FILE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('service CLI dry-run emits the reviewable plan through fixture provider only', async t => {
  const f = fixture(t), filename = path.join(f.root, 'service-config.json'); fs.writeFileSync(filename, JSON.stringify(f.config));
  let stdout = '', stderr = '';
  const code = await runControllerServiceCli(['dry-run', '--config', filename, '--json'], { home: f.home, uid: 501, platform: 'darwin', run: f.run, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).status, 'planned');
  assert.equal(fs.existsSync(f.plan.plistPath), false);
});

async function waitFor(action, milliseconds = 10000) {
  const until = Date.now() + milliseconds;
  for (;;) { try { const value = action(); if (value) return value; } catch {} if (Date.now() >= until) throw new Error('Inert service fixture observation timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
test('real runner uses private cwd, bounded logs and graceful SIGTERM without inherited credential environment', { timeout: 20000 }, async t => {
  const f = fixture(t), fakeRoot = path.join(f.root, 'fake-repo'), entrypoint = path.join(fakeRoot, 'scripts/factory-controller.mjs'), observed = path.join(f.root, 'child-observed.json'), stopped = path.join(f.root, 'child-stopped');
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({cwd:process.cwd(),apiKey:process.env.PAPERCLIP_API_KEY??null,providerKey:process.env.OPENAI_API_KEY??null,args:process.argv.slice(2)}));console.log(JSON.stringify({status:'idle'}));const timer=setInterval(()=>{console.log('x'.repeat(2000));console.error('Authorization: Bearer PRIVATE_RUNNER_SECRET')},10);process.on('SIGTERM',()=>{clearInterval(timer);fs.writeFileSync(${JSON.stringify(stopped)},'SIGTERM');process.exit(0)});`);
  const config = { ...f.config, controllerEntrypoint: entrypoint, logMaxBytes: 1024, logMaxFiles: 3, logMaxLineBytes: 256, graceMs: 2000 };
  await f.invoke('install', { config });
  const plan = planControllerService({ config, home: f.home, uid: 501 });
  const child = spawn(process.execPath, [path.resolve('scripts/controller-service-runner.mjs'), '--config', plan.configPath], { env: { HOME: f.home, PATH: process.env.PATH, PAPERCLIP_API_KEY: 'FIXTURE_BEARER', OPENAI_API_KEY: 'FIXTURE_PROVIDER' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => { exited = true; resolve({ code, signal }); }));
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await closed; } });
  const value = await waitFor(() => JSON.parse(fs.readFileSync(observed, 'utf8')));
  assert.equal(value.cwd, fs.realpathSync(f.instance)); assert.equal(value.apiKey, null); assert.equal(value.providerKey, null);
  assert.ok(value.args.includes('--loop')); assert.ok(value.args.includes(f.config.registryDirectory));
  await waitFor(() => fs.readdirSync(f.config.logDirectory).some(name => fs.readFileSync(path.join(f.config.logDirectory, name), 'utf8').includes('LOG_LINE_DROPPED')));
  child.kill('SIGTERM'); const outcome = await closed;
  assert.equal(outcome.code, 0, stderr); assert.equal(outcome.signal, null); assert.equal(fs.readFileSync(stopped, 'utf8'), 'SIGTERM');
  assert.equal(stdout, ''); assert.equal(stderr.includes('PRIVATE_RUNNER_SECRET'), false);
  const report = JSON.parse(fs.readFileSync(path.join(plan.privateDirectory, 'runtime.json'), 'utf8'));
  assert.equal(report.phase, 'exited'); assert.equal(report.requestedStop, true);
  const logs = fs.readdirSync(f.config.logDirectory); assert.ok(logs.length <= 3);
  for (const name of logs) { const filename = path.join(f.config.logDirectory, name); assert.ok(fs.statSync(filename).size <= 1024); assert.equal(fs.readFileSync(filename, 'utf8').includes('PRIVATE_RUNNER_SECRET'), false); }
});

test('a metadata publication failure after spawn shuts down its child instead of orphaning a controller', async t => {
  const f = fixture(t), config = { ...f.config, homeDirectory: os.homedir() };
  const plan = planControllerService({ config }); fs.mkdirSync(plan.privateDirectory, { recursive: true });
  const child = new EventEmitter(); child.pid = 123456; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => { signals.push(signal); queueMicrotask(() => child.emit('close', 0, null)); return true; };
  const original = fs.renameSync; let publications = 0;
  fs.renameSync = (source, target) => { if (path.basename(target) === 'runtime.json' && ++publications === 2) throw Object.assign(new Error('injected storage failure'), { code: 'ENOSPC' }); return original(source, target); };
  try { await assert.rejects(runControllerServiceProcess(config, { spawnChild: () => child }), { code: 'ENOSPC' }); }
  finally { fs.renameSync = original; }
  assert.deepEqual(signals, ['SIGTERM']);
});
