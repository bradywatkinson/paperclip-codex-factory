#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { DispatchScheduler, SCHEDULER_FILENAME } from '../lib/dispatch-scheduler.mjs';
import { bootstrapReviewRoles, buildReviewPlan, reviewFail, reviewSafeCode } from '../lib/review-onboarding.mjs';
import { startReviewPipeline, reviewStatus, setReviewPaused } from '../lib/review-controller.mjs';
import { runFactoryControllerOnce } from '../lib/factory-controller.mjs';

const HELP = `Usage: factory review COMMAND OWNER/REPO [options]
  bootstrap [--dry-run]          Provision separate reviewer, QA and repair agents
  start                         Freshly inspect a delivery and approve a bounded batch
  status                        Read durable role, task, execution and approval state
  once | loop                   Run the normal account controller with review orchestration
  pause | resume --pipeline UUID Pause/resume an approved pipeline; retain ambiguous intents
Options:
  --registry ABS_DIRECTORY --json
  start: --observation ABS_JSON --patch ABS_PATCH --approve-dispatch
         --test-check EXACT_CI_NAME (repeatable) --max-repairs 2 --max-handoffs 8
  loop:  --interval-ms 30000
No existing task reassignment, human status writes, merge, push or deployment.
`;
export async function runFactoryReviewCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), home = os.homedir(), run, env = process.env } = {}) {
  let registry, scheduler, stopped = false; const cancellation = new AbortController(), stop = () => { stopped = true; cancellation.abort(); }, json = args.includes('--json');
  try {
    if (!args.length || args.includes('--help')) { stdout(HELP); return 0; }
    const command = args[0], repository = args[1], options = new Map(), testChecks = [];
    if (!['bootstrap', 'start', 'status', 'once', 'loop', 'pause', 'resume'].includes(command) || typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) reviewFail('USAGE_FACTORY_REVIEW');
    for (let index = 2; index < args.length; index++) {
      const flag = args[index]; if (options.has(flag)) reviewFail('USAGE_FACTORY_REVIEW');
      if (['--json', '--dry-run', '--approve-dispatch'].includes(flag)) options.set(flag, true);
      else if (['--registry', '--observation', '--patch', '--pipeline', '--max-repairs', '--max-handoffs', '--interval-ms', '--test-check'].includes(flag)) {
        const value = args[++index]; if (!value || value.startsWith('--')) reviewFail('USAGE_FACTORY_REVIEW'); if (flag === '--test-check') testChecks.push(value); else options.set(flag, value);
      } else reviewFail('USAGE_FACTORY_REVIEW');
    }
    if (options.has('--dry-run') && command !== 'bootstrap' || ['--approve-dispatch', '--observation', '--patch', '--max-repairs', '--max-handoffs'].some(flag => options.has(flag) && command !== 'start') || testChecks.length && command !== 'start' || options.has('--pipeline') && !['pause', 'resume'].includes(command) || options.has('--interval-ms') && command !== 'loop') reviewFail('USAGE_FACTORY_REVIEW');
    const directory = options.get('--registry') ?? path.join(home, '.paperclip/instances/factory/repositories');
    if (!path.isAbsolute(directory)) reviewFail('USAGE_FACTORY_REVIEW');
    let stat; try { stat = fs.lstatSync(path.join(directory, 'registry.sqlite')); } catch { reviewFail('FACTORY_REGISTRY_NOT_FOUND'); }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink()) reviewFail('FACTORY_REGISTRY_NOT_FOUND');
    registry = new RepositoryRegistry({ directory }); const plan = buildReviewPlan({ registry, repository });
    const print = value => stdout(json ? JSON.stringify(value) + '\n' : value.status + '\n' + JSON.stringify(value, null, 2) + '\n');
    if (command === 'bootstrap') { const result = await bootstrapReviewRoles({ registry, repository, run, env, dryRun: options.has('--dry-run') }); print(result); return ['needs_attention', 'approval_required'].includes(result.status) ? 1 : 0; }
    if (command === 'status') { const result = reviewStatus({ registry, repository }); print(result); return result.status === 'needs_attention' ? 1 : 0; }
    if (['pause', 'resume'].includes(command)) {
      if (!/^[a-f0-9-]{36}$/i.test(options.get('--pipeline') ?? '')) reviewFail('USAGE_FACTORY_REVIEW');
      print(setReviewPaused({ registry, repository, pipelineId: options.get('--pipeline'), paused: command === 'pause' })); return 0;
    }
    const registrations = registry.list().filter(row => ['configured', 'approval_required'].includes(registry.getOperation(row.repository)?.state));
    if (new Set(registrations.map(row => registry.getOperation(row.repository).data.plan.schedulerDirectory)).size !== 1 || new Set(registrations.map(row => JSON.stringify(row.policy.concurrency))).size !== 1) reviewFail('FACTORY_ACCOUNT_CONFIG_DIVERGED');
    if (!fs.existsSync(path.join(plan.main.schedulerDirectory, SCHEDULER_FILENAME))) reviewFail('REVIEW_SCHEDULER_MISSING');
    scheduler = new DispatchScheduler({ directory: plan.main.schedulerDirectory });
    if (command === 'start') {
      for (const flag of ['--observation', '--patch']) if (!options.get(flag) || !path.isAbsolute(options.get(flag))) reviewFail('USAGE_FACTORY_REVIEW');
      const result = await startReviewPipeline({ registry, scheduler, repository, observationPath: options.get('--observation'), patchPath: options.get('--patch'), approveDispatch: options.has('--approve-dispatch'), testCheckNames: testChecks, maxRepairs: Number(options.get('--max-repairs') ?? 2), maxHandoffs: Number(options.get('--max-handoffs') ?? 8), run, env }); print(result); return 0;
    }
    const intervalMs = Number(options.get('--interval-ms') ?? 30000); if (!Number.isInteger(intervalMs) || intervalMs < 15000 || intervalMs > 3600000) reviewFail('USAGE_FACTORY_REVIEW');
    process.on('SIGTERM', stop); process.on('SIGINT', stop); let result;
    do {
      result = await runFactoryControllerOnce({ registry, scheduler, run, env, shouldStop: () => stopped, sleep: async ms => { try { await delay(ms, undefined, { signal: cancellation.signal }); } catch {} } }); print(result);
      if (command === 'once' || stopped) break;
      try { await delay(intervalMs, undefined, { signal: cancellation.signal }); } catch {}
    } while (!stopped);
    return command === 'once' && result.status === 'needs_attention' ? 1 : 0;
  } catch (error) { const result = { status: 'needs_attention', code: reviewSafeCode(error), evidenceVerified: false }; stderr(json ? JSON.stringify(result) + '\n' : result.code + '\n'); return 1; }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); scheduler?.close(); registry?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runFactoryReviewCli(process.argv.slice(2));
