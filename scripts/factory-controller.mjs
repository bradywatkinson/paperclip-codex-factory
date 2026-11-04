#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { DispatchScheduler, SCHEDULER_FILENAME } from '../lib/dispatch-scheduler.mjs';
import { runFactoryControllerOnce } from '../lib/factory-controller.mjs';

const HELP = `Usage: factory controller --once|--loop [--registry ABS_DIRECTORY]
  [--scheduler ABS_DIRECTORY] [--interval-ms 30000] [--json]

Reconciles registered company journals and wakes eligible queued dispatchers.
Cloud submission remains inside the dispatcher admission gate. The controller
does not retry ambiguous submissions or reopen human task statuses.
`;
const failure = code => { throw Object.assign(new Error(), { code }); };
export async function runFactoryControllerCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), home = os.homedir(), run, env = process.env } = {}) {
  let registry, scheduler;
  let stopped = false;
  const cancellation = new AbortController();
  const stop = () => { stopped = true; cancellation.abort(); };
  const json = args.includes('--json');
  try {
    if (!args.length || args.includes('--help')) { stdout(HELP); return 0; }
    const options = new Map();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (options.has(flag)) failure('USAGE_FACTORY_CONTROLLER');
      if (['--json', '--once', '--loop'].includes(flag)) options.set(flag, true);
      else if (['--registry', '--scheduler', '--interval-ms'].includes(flag)) {
        const value = args[++index]; if (!value || value.startsWith('--')) failure('USAGE_FACTORY_CONTROLLER'); options.set(flag, value);
      } else failure('USAGE_FACTORY_CONTROLLER');
    }
    if (Number(options.has('--once')) + Number(options.has('--loop')) !== 1) failure('USAGE_FACTORY_CONTROLLER');
    const intervalMs = Number(options.get('--interval-ms') ?? 30_000);
    if (!Number.isInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 3_600_000) failure('USAGE_FACTORY_CONTROLLER');
    const registryDirectory = options.get('--registry') ?? path.join(home, '.paperclip/instances/factory/repositories');
    if (!path.isAbsolute(registryDirectory)) failure('USAGE_FACTORY_CONTROLLER');
    let stat;
    try { stat = fs.lstatSync(path.join(registryDirectory, 'registry.sqlite')); } catch { failure('FACTORY_REGISTRY_NOT_FOUND'); }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.lstatSync(registryDirectory).isSymbolicLink()) failure('FACTORY_REGISTRY_NOT_FOUND');
    registry = new RepositoryRegistry({ directory: registryDirectory });
    const registrations = registry.list().filter(entry => ['configured', 'approval_required'].includes(registry.getOperation(entry.repository)?.state));
    if (!registrations.length) failure('FACTORY_NO_BOOTSTRAPPED_REPOSITORIES');
    const directories = new Set(registrations.map(entry => registry.getOperation(entry.repository).data.plan.schedulerDirectory));
    const policies = new Set(registrations.map(entry => JSON.stringify(entry.policy.concurrency)));
    if (directories.size !== 1 || policies.size !== 1) failure('FACTORY_ACCOUNT_CONFIG_DIVERGED');
    const schedulerDirectory = options.get('--scheduler') ?? [...directories][0];
    if (typeof schedulerDirectory !== 'string' || !path.isAbsolute(schedulerDirectory) || !directories.has(schedulerDirectory)) failure('FACTORY_ACCOUNT_CONFIG_DIVERGED');
    scheduler = new DispatchScheduler({ directory: schedulerDirectory, ...(fs.existsSync(path.join(schedulerDirectory, SCHEDULER_FILENAME)) ? {} : { limits: registrations[0].policy.concurrency }) });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let lastStatus;
    do {
      const result = await runFactoryControllerOnce({ registry, scheduler, env, ...(run ? { run } : {}), shouldStop: () => stopped,
        sleep: async ms => { try { await delay(ms, undefined, { signal: cancellation.signal }); } catch { /* Stop interrupts waiting. */ } },
      });
      lastStatus = result.status;
      stdout(json ? JSON.stringify(result) + '\n' : `${result.status}\n${JSON.stringify(result, null, 2)}\n`);
      if (options.has('--once') || stopped) break;
      try { await delay(intervalMs, undefined, { signal: cancellation.signal }); } catch { /* Stop interrupts the interval. */ }
    } while (!stopped);
    return options.has('--once') && lastStatus === 'needs_attention' ? 1 : 0;
  } catch (error) {
    const result = { status: 'needs_attention', code: typeof error.code === 'string' ? error.code : 'FACTORY_CONTROLLER_FAILED' };
    stderr(json ? JSON.stringify(result) + '\n' : `${result.code}\n`); return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    scheduler?.close(); registry?.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runFactoryControllerCli(process.argv.slice(2));
