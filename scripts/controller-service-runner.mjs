#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { controllerServiceEnvironment, planControllerService } from '../lib/controller-service.mjs';
import { RotatingControllerLog } from '../lib/controller-log.mjs';

function writeReport(plan, value) {
  const filename = path.join(plan.privateDirectory, 'runtime.json');
  try { if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe runtime report'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
    const dir = fs.openSync(plan.privateDirectory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

/** Foreground service wrapper. Only its child performs the existing controller loop. */
export async function runControllerServiceProcess(config, { spawnChild = spawn } = {}) {
  if (process.version !== 'v24.15.0') throw new Error('Unsupported pinned service runtime');
  const plan = planControllerService({ config }), c = plan.config;
  let child, closed, childExited = false, requestedStop = false, logFailure = false, timer, report = { schemaVersion: 1, pid: process.pid, configHash: plan.configHash, childPid: null, phase: 'starting', controllerStatus: null, updatedAt: new Date().toISOString() };
  const publish = patch => { report = { ...report, ...patch, updatedAt: new Date().toISOString() }; writeReport(plan, report); };
  const log = new RotatingControllerLog({ directory: c.logDirectory, maxBytes: c.logMaxBytes, maxFiles: c.logMaxFiles, maxLineBytes: c.logMaxLineBytes, onReport: controllerStatus => publish({ controllerStatus }) });
  const stop = () => {
    if (requestedStop) return;
    requestedStop = true;
    child?.kill('SIGTERM');
    timer = setTimeout(() => { child?.kill('SIGKILL'); }, c.graceMs); timer.unref();
  };
  const capture = (channel, bytes) => {
    if (logFailure) return;
    try { log.write(channel, bytes); }
    catch { logFailure = true; stop(); }
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    publish({});
    child = spawnChild(c.nodeCommand, [c.controllerEntrypoint, '--loop', '--registry', c.registryDirectory, '--scheduler', c.schedulerDirectory, '--interval-ms', String(c.intervalMs), '--json'], { cwd: c.instanceDirectory, env: controllerServiceEnvironment(c), shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = new Promise(resolve => {
      child.once('error', () => { logFailure = true; });
      child.once('close', (code, signal) => { childExited = true; resolve({ code, signal }); });
    });
    child.stdout.on('data', bytes => capture('stdout', bytes)); child.stderr.on('data', bytes => capture('stderr', bytes));
    publish({ phase: 'running', childPid: child.pid ?? null });
    const outcome = await closed;
    clearTimeout(timer);
    try { log.close(); } catch { logFailure = true; }
    publish({ phase: 'exited', childPid: null, childExitCode: outcome.code, childSignal: outcome.signal, requestedStop, logFailure });
    return logFailure ? 1 : requestedStop ? 0 : outcome.code === 0 ? 0 : 1;
  } finally {
    if (child && !childExited) { stop(); await closed; }
    clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    try { log.close(); } catch { /* A metadata/log failure cannot leave its child running. */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw new Error('Invalid service runner arguments');
    const stat = fs.lstatSync(args[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) throw new Error('Invalid service runner configuration');
    const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    process.exitCode = await runControllerServiceProcess(config);
  } catch { process.stderr.write('CONTROLLER_SERVICE_RUNNER_FAILED\n'); process.exitCode = 1; }
}
