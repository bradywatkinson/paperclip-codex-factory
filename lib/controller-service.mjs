import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runCommand } from './cloud-dispatch.mjs';

export const CONTROLLER_SERVICE_LABEL = 'ing.paperclip.codex-factory.controller';
const OWNER = 'paperclip-codex-factory-controller-v1';
const PINNED_NODE = 'v24.15.0';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash = content => createHash('sha256').update(content).digest('hex');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
export class ControllerServiceError extends Error {
  constructor(code) { super(code); this.name = 'ControllerServiceError'; this.code = code; }
}
const fail = code => { throw new ControllerServiceError(code); };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const encode = value => JSON.stringify(value, null, 2) + '\n';
function stat(filename) { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function file(filename) { const value = stat(filename); if (!value?.isFile() || value.isSymbolicLink()) fail('CONTROLLER_SERVICE_FILE_UNSAFE'); fs.accessSync(filename, fs.constants.R_OK); return value; }
function directory(filename, create = false) {
  if (create) fs.mkdirSync(filename, { recursive: true, mode: 0o700 });
  const value = stat(filename); if (!value?.isDirectory() || value.isSymbolicLink()) fail('CONTROLLER_SERVICE_DIRECTORY_UNSAFE');
  return value;
}
function syncDirectory(filename) { const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function immutable(filename, content) {
  directory(path.dirname(filename), true);
  const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporary, filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (file(filename).size !== Buffer.byteLength(content) || fs.readFileSync(filename, 'utf8') !== content) fail('CONTROLLER_SERVICE_CONFIG_CONFLICT'); }
    syncDirectory(path.dirname(filename));
  } finally { if (fd !== undefined) fs.closeSync(fd); if (stat(temporary)) { fs.unlinkSync(temporary); syncDirectory(path.dirname(filename)); } }
}

export function validateControllerServiceConfig(input = {}, { home = os.homedir() } = {}) {
  const allowed = ['schemaVersion', 'nodeCommand', 'controllerEntrypoint', 'runnerEntrypoint', 'registryDirectory', 'schedulerDirectory', 'instanceDirectory', 'homeDirectory', 'logDirectory', 'logMaxBytes', 'logMaxFiles', 'logMaxLineBytes', 'intervalMs', 'graceMs'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || (input.schemaVersion !== undefined && input.schemaVersion !== 1) || !absolute(home)) fail('INVALID_CONTROLLER_SERVICE_CONFIG');
  const instance = input.instanceDirectory ?? path.join(home, '.paperclip/instances/factory');
  const config = {
    schemaVersion: 1,
    nodeCommand: input.nodeCommand ?? path.join(home, '.local/share/paperclip-runtime-next/node_modules/node/bin/node'),
    controllerEntrypoint: input.controllerEntrypoint ?? path.join(ROOT, 'scripts/factory-controller.mjs'),
    runnerEntrypoint: input.runnerEntrypoint ?? path.join(ROOT, 'scripts/controller-service-runner.mjs'),
    registryDirectory: input.registryDirectory ?? path.join(instance, 'repositories'),
    schedulerDirectory: input.schedulerDirectory ?? path.join(instance, 'onboarding/scheduler'),
    instanceDirectory: instance, homeDirectory: input.homeDirectory ?? home,
    logDirectory: input.logDirectory ?? path.join(instance, 'logs/factory-controller'),
    logMaxBytes: input.logMaxBytes ?? 5 * 1024 * 1024, logMaxFiles: input.logMaxFiles ?? 5, logMaxLineBytes: input.logMaxLineBytes ?? 32768,
    intervalMs: input.intervalMs ?? 30000, graceMs: input.graceMs ?? 20000,
  };
  for (const key of ['nodeCommand', 'controllerEntrypoint', 'runnerEntrypoint', 'registryDirectory', 'schedulerDirectory', 'instanceDirectory', 'homeDirectory', 'logDirectory']) { if (!absolute(config[key])) fail('INVALID_CONTROLLER_SERVICE_PATH'); config[key] = path.normalize(config[key]); }
  if (config.homeDirectory !== home || path.basename(config.controllerEntrypoint) !== 'factory-controller.mjs' || path.basename(config.runnerEntrypoint) !== 'controller-service-runner.mjs') fail('CONTROLLER_SERVICE_BINDING_CHANGED');
  const repo = path.dirname(path.dirname(config.controllerEntrypoint));
  if (config.instanceDirectory === repo || config.instanceDirectory.startsWith(repo + path.sep)) fail('CONTROLLER_SERVICE_PRIVATE_CWD_REQUIRED');
  for (const [key, min, max] of [['logMaxBytes', 1024, 5 * 1024 * 1024], ['logMaxFiles', 1, 5], ['logMaxLineBytes', 64, 32768], ['intervalMs', 15000, 3600000], ['graceMs', 1000, 20000]]) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) fail('INVALID_CONTROLLER_SERVICE_LIMIT');
  return Object.freeze(config);
}
export function controllerServiceEnvironment(config) {
  return {
    HOME: config.homeDirectory,
    PATH: [...new Set([path.dirname(config.nodeCommand), path.join(config.homeDirectory, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter),
    PAPERCLIP_HOME: path.join(config.homeDirectory, '.paperclip'), PAPERCLIP_INSTANCE_ID: 'factory', PAPERCLIP_TELEMETRY_DISABLED: '1', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
  };
}
export function planControllerService({ config: input = {}, home = os.homedir(), uid = process.getuid?.() } = {}) {
  const config = validateControllerServiceConfig(input, { home });
  if (!Number.isInteger(uid) || uid < 0) fail('INVALID_CONTROLLER_SERVICE_USER');
  const configHash = hash(encode(config)), privateDirectory = path.join(config.instanceDirectory, 'managed-controller');
  const configPath = path.join(privateDirectory, 'config.' + configHash + '.json'), receiptPath = path.join(privateDirectory, 'receipt.' + configHash + '.json');
  const plistPath = path.join(home, 'Library/LaunchAgents', CONTROLLER_SERVICE_LABEL + '.plist');
  const args = [config.nodeCommand, config.runnerEntrypoint, '--config', configPath], environment = controllerServiceEnvironment(config);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${OWNER} config=${configHash} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${CONTROLLER_SERVICE_LABEL}</string>\n<key>ProgramArguments</key><array>${args.map(value => '<string>' + xml(value) + '</string>').join('')}</array>\n<key>WorkingDirectory</key><string>${xml(config.instanceDirectory)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => '<key>' + xml(key) + '</key><string>' + xml(value) + '</string>').join('')}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>30</integer>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
  return { label: CONTROLLER_SERVICE_LABEL, config, configHash, configPath, receiptPath, plistPath, plist, domain: 'gui/' + uid, target: 'gui/' + uid + '/' + CONTROLLER_SERVICE_LABEL, privateDirectory };
}
function ownedReceipt({ configHash, home, instanceDirectory, uid }) {
  const receiptPath = path.join(instanceDirectory, 'managed-controller', 'receipt.' + configHash + '.json');
  let receipt;
  try { if (file(receiptPath).size > 128000) fail('CONTROLLER_SERVICE_UNOWNED_PLIST'); receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
  catch { fail('CONTROLLER_SERVICE_UNOWNED_PLIST'); }
  const plan = planControllerService({ config: receipt.config, home, uid });
  if (receipt.owner !== OWNER || receipt.schemaVersion !== 1 || receipt.label !== CONTROLLER_SERVICE_LABEL || receipt.configHash !== configHash || plan.configHash !== configHash || plan.config.instanceDirectory !== instanceDirectory || receipt.plistSha256 !== hash(plan.plist)) fail('CONTROLLER_SERVICE_UNOWNED_PLIST');
  if (file(plan.configPath).size > 128000 || fs.readFileSync(plan.configPath, 'utf8') !== encode(plan.config)) fail('CONTROLLER_SERVICE_CONFIG_CONFLICT');
  return plan;
}
function ownedInstallation({ home, instanceDirectory, uid }) {
  const plistPath = path.join(home, 'Library/LaunchAgents', CONTROLLER_SERVICE_LABEL + '.plist'), existing = stat(plistPath);
  if (!existing) return null;
  if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 128000) fail('CONTROLLER_SERVICE_UNOWNED_PLIST');
  const plist = fs.readFileSync(plistPath, 'utf8'), match = new RegExp('<!-- ' + OWNER + ' config=([a-f0-9]{64}) -->').exec(plist);
  if (!match) fail('CONTROLLER_SERVICE_UNOWNED_PLIST');
  const plan = ownedReceipt({ configHash: match[1], home, instanceDirectory, uid });
  if (plan.plist !== plist) fail('CONTROLLER_SERVICE_UNOWNED_PLIST');
  return plan;
}
// launchctl prints one complete, unquoted argument per line. Any ambiguous or
// changed representation is unknown ownership, never permission to control it.
function loadedIdentity(output) {
  const programs = [...output.matchAll(/^\s*program = (.+)\r?$/gm)];
  const blocks = [...output.matchAll(/^([ \t]*)arguments = \{\r?\n([\s\S]*?)^\1\}\s*$/gm)];
  if (programs.length !== 1 || blocks.length !== 1) return null;
  const args = blocks[0][2].split(/\r?\n/).filter(line => line.trim()).map(line => line.trim());
  if (args.length !== 4 || args.some(value => /[{}\u0000-\u001f]/.test(value))) return null;
  return { program: programs[0][1].trim(), args };
}
function ownedLoadedIdentity(output, plan) {
  const identity = loadedIdentity(output);
  if (!identity || identity.args[2] !== '--config') return null;
  const filename = identity.args[3], match = /^config\.([a-f0-9]{64})\.json$/.exec(path.basename(filename));
  if (!match || path.dirname(filename) !== plan.privateDirectory) return null;
  try {
    const owned = ownedReceipt({ configHash: match[1], home: plan.config.homeDirectory, instanceDirectory: plan.config.instanceDirectory, uid: Number(plan.domain.slice(4)) });
    if (identity.program !== owned.config.nodeCommand || JSON.stringify(identity.args) !== JSON.stringify([owned.config.nodeCommand, owned.config.runnerEntrypoint, '--config', owned.configPath])) return null;
    return owned;
  } catch { return null; }
}
async function validateFiles(plan, run, inspectDatabases = true) {
  for (const filename of [plan.config.nodeCommand, plan.config.controllerEntrypoint, plan.config.runnerEntrypoint, path.join(plan.config.registryDirectory, 'registry.sqlite'), path.join(plan.config.schedulerDirectory, 'dispatch-scheduler.sqlite')]) file(filename);
  for (const dir of [plan.config.registryDirectory, plan.config.schedulerDirectory, plan.config.instanceDirectory]) directory(dir);
  const realRepo = fs.realpathSync(path.dirname(path.dirname(plan.config.controllerEntrypoint))), realInstance = fs.realpathSync(plan.config.instanceDirectory);
  if (realInstance === realRepo || realInstance.startsWith(realRepo + path.sep)) fail('CONTROLLER_SERVICE_PRIVATE_CWD_REQUIRED');
  // Read-only SQLite can create WAL coordination sidecars. A dry-run performs
  // file/readability checks only and leaves schema inspection to installation.
  if (inspectDatabases) for (const [filename, scheduler] of [[path.join(plan.config.registryDirectory, 'registry.sqlite'), false], [path.join(plan.config.schedulerDirectory, 'dispatch-scheduler.sqlite'), true]]) {
    let db;
    try {
      db = new DatabaseSync(filename, { readOnly: true });
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) fail('CONTROLLER_SERVICE_DATABASE_UNSUPPORTED');
      if (scheduler) {
        if (db.prepare('PRAGMA application_id').get().application_id !== 0x46534348 || !db.prepare("SELECT sql FROM sqlite_master WHERE name='scheduler_executions'").get()?.sql.includes("'held'")) fail('CONTROLLER_SERVICE_DATABASE_UNSUPPORTED');
        db.prepare('SELECT revision,global_limit,repository_limit,attempt_limit FROM scheduler_settings WHERE id=1').get();
      } else db.prepare('SELECT repository,config_hash,policy_json FROM repositories LIMIT 0').all();
    } catch (error) { throw error instanceof ControllerServiceError ? error : new ControllerServiceError('CONTROLLER_SERVICE_DATABASE_UNSUPPORTED'); }
    finally { db?.close(); }
  }
  fs.accessSync(plan.config.nodeCommand, fs.constants.X_OK);
  const version = await run(plan.config.nodeCommand, ['--version'], { env: controllerServiceEnvironment(plan.config), timeoutMs: 5000, maxOutputBytes: 4096 });
  if (version?.code !== 0 || version.stdout?.trim() !== PINNED_NODE || version.timedOut || version.signal || version.outputExceeded || version.failedToStart) fail('CONTROLLER_SERVICE_NODE_VERSION_MISMATCH');
}
async function launchStatus(plan, run) {
  const response = await run('/bin/launchctl', ['print', plan.target], { timeoutMs: 5000, maxOutputBytes: 64000 });
  if (response?.timedOut || response?.failedToStart || response?.outputExceeded || response?.signal) return { loaded: null, active: null, pid: null, state: 'unknown', code: 'CONTROLLER_SERVICE_STATUS_UNAVAILABLE' };
  if (response?.code !== 0) {
    if (!response?.timedOut && !response?.failedToStart && !response?.outputExceeded && /Could not find service|service could not be found|No such process/i.test(response?.stderr ?? '')) return { loaded: false, active: false, pid: null, state: 'not_loaded', loadedConfigMatches: false };
    return { loaded: null, active: null, pid: null, state: 'unknown', code: 'CONTROLLER_SERVICE_STATUS_UNAVAILABLE' };
  }
  const output = response.stdout ?? '', state = /^\s*state = ([a-z_]+)\s*$/m.exec(output)?.[1];
  if (!state) return { loaded: null, active: null, pid: null, state: 'unknown', code: 'CONTROLLER_SERVICE_STATUS_UNAVAILABLE' };
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(output)?.[1] ?? 0), owned = ownedLoadedIdentity(output, plan);
  return { loaded: true, active: pid > 0 && state === 'running', pid: pid > 0 ? pid : null, state, loadedOwnershipVerified: Boolean(owned), loadedConfigMatches: owned?.configHash === plan.configHash, lastExitCode: /^\s*last exit code = (-?\d+)\s*$/m.test(output) ? Number(/^\s*last exit code = (-?\d+)\s*$/m.exec(output)[1]) : null };
}
async function control(run, args) {
  const result = await run('/bin/launchctl', args, { timeoutMs: 10000, maxOutputBytes: 64000 });
  if (result?.code !== 0 || result.timedOut || result.signal || result.outputExceeded || result.failedToStart) fail('CONTROLLER_SERVICE_CONTROL_FAILED');
}

/** Managed user LaunchAgent operations. No Paperclip or Cloud commands execute. */
export async function manageControllerService({ command, config, home = os.homedir(), instanceDirectory, uid = process.getuid?.(), run = runCommand, dryRun = false, replace = false, platform = process.platform } = {}) {
  if (!['install', 'start', 'stop', 'status', 'uninstall'].includes(command)) fail('USAGE_CONTROLLER_SERVICE');
  const desired = planControllerService({ config: config ?? { ...(instanceDirectory ? { instanceDirectory } : {}) }, home, uid });
  const current = ownedInstallation({ home, instanceDirectory: desired.config.instanceDirectory, uid });
  if (command === 'install') {
    await validateFiles(desired, run, !dryRun);
    const changed = current && current.configHash !== desired.configHash;
    const changes = current ? Object.keys(desired.config).filter(key => desired.config[key] !== current.config[key]) : Object.keys(desired.config);
    if (dryRun) return { status: 'planned', command, plan: desired, installed: Boolean(current), changed: Boolean(changed), changes, requiresReplace: Boolean(changed), databaseSchemaChecked: false };
    if (platform !== 'darwin') fail('CONTROLLER_SERVICE_PLATFORM_UNSUPPORTED');
    const loaded = await launchStatus(current ?? desired, run);
    if (loaded.loaded === null) fail('CONTROLLER_SERVICE_STATUS_UNAVAILABLE');
    if (loaded.loaded && !loaded.loadedOwnershipVerified) fail('CONTROLLER_SERVICE_UNOWNED_LOADED_JOB');
    if (changed && !replace) fail('CONTROLLER_SERVICE_REPLACE_REQUIRED');
    if (current && !changed) return { status: 'already_installed', label: desired.label, plistPath: desired.plistPath, configHash: desired.configHash };
    directory(desired.privateDirectory, true); fs.chmodSync(desired.privateDirectory, 0o700);
    immutable(desired.configPath, encode(desired.config));
    immutable(desired.receiptPath, encode({ schemaVersion: 1, owner: OWNER, label: desired.label, configHash: desired.configHash, plistSha256: hash(desired.plist), config: desired.config }));
    directory(path.dirname(desired.plistPath), true);
    if (!current) immutable(desired.plistPath, desired.plist);
    else {
      const checked = ownedInstallation({ home, instanceDirectory: desired.config.instanceDirectory, uid });
      if (checked?.configHash !== current.configHash) fail('CONTROLLER_SERVICE_CONFIG_CONFLICT');
      const staged = path.join(desired.privateDirectory, 'plist.' + desired.configHash + '.xml'); immutable(staged, desired.plist);
      // Source and target live in the same user's filesystem. The new config and
      // receipt are already durable, so either old or new plist is recoverable.
      const temp = desired.plistPath + '.' + randomUUID() + '.tmp';
      try { fs.copyFileSync(staged, temp, fs.constants.COPYFILE_EXCL); const fd = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, desired.plistPath); syncDirectory(path.dirname(desired.plistPath)); }
      finally { if (stat(temp)) fs.unlinkSync(temp); }
    }
    return { status: changed ? 'updated' : 'installed', label: desired.label, plistPath: desired.plistPath, configHash: desired.configHash, startRequired: true };
  }
  if (dryRun) return { status: 'planned', command, installed: Boolean(current), target: (current ?? desired).target };
  if (platform !== 'darwin') fail('CONTROLLER_SERVICE_PLATFORM_UNSUPPORTED');
  const plan = current ?? desired;
  let state = await launchStatus(plan, run);
  if (command === 'status') return { status: state.loaded && !state.loadedOwnershipVerified ? 'needs_attention' : state.active ? 'running' : state.loaded === false ? 'not_loaded' : state.loaded && !state.lastExitCode ? 'loaded' : 'needs_attention', installed: Boolean(current), label: plan.label, plistPath: plan.plistPath, ...state };
  if (state.loaded === null) fail('CONTROLLER_SERVICE_STATUS_UNAVAILABLE');
  if (state.loaded && !state.loadedOwnershipVerified) fail('CONTROLLER_SERVICE_UNOWNED_LOADED_JOB');
  if (!current) {
    if (!state.loaded && ['stop', 'uninstall'].includes(command)) return { status: 'not_installed', installed: false, loaded: false, active: false };
    fail('CONTROLLER_SERVICE_NOT_INSTALLED');
  }
  if (command === 'stop' || command === 'uninstall') {
    if (state.loaded) await control(run, ['bootout', plan.target]);
    state = await launchStatus(plan, run);
    if (state.loaded !== false) fail('CONTROLLER_SERVICE_STOP_UNVERIFIED');
    if (command === 'uninstall') { ownedInstallation({ home, instanceDirectory: plan.config.instanceDirectory, uid }); fs.unlinkSync(plan.plistPath); syncDirectory(path.dirname(plan.plistPath)); }
    return { status: command === 'uninstall' ? 'uninstalled' : 'stopped', installed: command !== 'uninstall', ...state };
  }
  await validateFiles(plan, run);
  if (state.loaded && !state.loadedConfigMatches) { await control(run, ['bootout', plan.target]); state = await launchStatus(plan, run); if (state.loaded !== false) fail('CONTROLLER_SERVICE_STOP_UNVERIFIED'); }
  if (!state.loaded) { await control(run, ['enable', plan.target]); await control(run, ['bootstrap', plan.domain, plan.plistPath]); }
  else if (!state.active) await control(run, ['kickstart', plan.target]);
  state = await launchStatus(plan, run);
  if (state.loaded !== true || !state.loadedOwnershipVerified || !state.loadedConfigMatches) fail('CONTROLLER_SERVICE_START_UNVERIFIED');
  return { status: state.active ? 'running' : 'starting', installed: true, label: plan.label, ...state };
}
