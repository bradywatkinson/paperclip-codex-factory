#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';
import { loadFactoryPolicy } from '../lib/repository-config.mjs';

const HELP = `Usage: factory scheduler COMMAND [--directory ABS_DIRECTORY] [--json]
  status
  pause | resume [--repository OWNER/REPO]
  cooldown --milliseconds 900000
  configure --policy FILE --expected-revision N
  configure-repo --repository OWNER/REPO --max-active N --max-attempts N --expected-revision N
  resume-execution --execution UUID --expected-revision N

Pause stops admission; it does not cancel or forget accepted Cloud work.
Configure is an explicit compare-and-swap operation. Unknown submissions keep slots.
`;
const fail = code => { throw Object.assign(new Error(), { code }); };
export async function runSchedulerCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), home = os.homedir() } = {}) {
  let scheduler;
  const json = args.includes('--json');
  try {
    if (!args.length || args.includes('--help')) { stdout(HELP); return 0; }
    const command = args[0], options = new Map();
    const allowed = {
      status: [], pause: ['--repository'], resume: ['--repository'], cooldown: ['--milliseconds'],
      configure: ['--policy', '--expected-revision'], 'configure-repo': ['--repository', '--max-active', '--max-attempts', '--expected-revision'],
      'resume-execution': ['--execution', '--expected-revision'],
    };
    if (!Object.hasOwn(allowed, command)) fail('USAGE_SCHEDULER');
    for (let index = 1; index < args.length; index++) {
      const flag = args[index];
      if (options.has(flag) || !['--directory', '--json', ...allowed[command]].includes(flag)) fail('USAGE_SCHEDULER');
      if (flag === '--json') options.set(flag, true);
      else { const value = args[++index]; if (!value || value.startsWith('--')) fail('USAGE_SCHEDULER'); options.set(flag, value); }
    }
    if (command === 'cooldown' && !options.has('--milliseconds')) fail('USAGE_SCHEDULER');
    if (['configure', 'configure-repo', 'resume-execution'].includes(command) && !allowed[command].every(flag => options.has(flag))) fail('USAGE_SCHEDULER');
    const directory = options.get('--directory') ?? path.join(home, '.paperclip/instances/factory/onboarding/scheduler');
    if (!path.isAbsolute(directory)) fail('USAGE_SCHEDULER');
    const policy = command === 'configure' ? await loadFactoryPolicy(path.resolve(options.get('--policy'))) : undefined;
    scheduler = new DispatchScheduler({ directory });
    let control;
    if (command === 'pause' || command === 'resume') control = scheduler.setPaused(command === 'pause', { ...(options.has('--repository') ? { repository: options.get('--repository') } : {}), reasonCode: command === 'pause' ? 'OPERATOR_PAUSED' : 'OPERATOR_RESUMED' });
    if (command === 'cooldown') control = scheduler.deferProviderRequests({ delayMs: Number(options.get('--milliseconds')) });
    if (command === 'configure') control = scheduler.configureLimits({ expectedRevision: Number(options.get('--expected-revision')), limits: policy.concurrency });
    if (command === 'configure-repo') control = scheduler.configureRepository({ repository: options.get('--repository'), expectedRevision: Number(options.get('--expected-revision')), maxActive: Number(options.get('--max-active')), maxAttempts: Number(options.get('--max-attempts')) });
    if (command === 'resume-execution') control = scheduler.resumeHeld(options.get('--execution'), { expectedRevision: Number(options.get('--expected-revision')) });
    const result = { status: command === 'status' ? 'scheduler_status' : 'control_applied', command, ...(control ? { control } : {}), snapshot: scheduler.snapshot() };
    if (json) stdout(JSON.stringify(result) + '\n');
    else {
      stdout(`${result.status}\n`);
      stdout(JSON.stringify(result.snapshot, null, 2) + '\n');
    }
    return 0;
  } catch (error) {
    const result = { status: 'needs_attention', code: typeof error.code === 'string' ? error.code : 'SCHEDULER_FAILED', correction: 'Inspect scheduler status and the current revision before changing controls. Do not clear unknown submissions to free capacity.' };
    stderr(json ? JSON.stringify(result) + '\n' : `${result.code}: ${result.correction}\n`); return 1;
  } finally { scheduler?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runSchedulerCli(process.argv.slice(2));
