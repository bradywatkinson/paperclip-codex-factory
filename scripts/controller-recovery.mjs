#!/usr/bin/env node
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionJournal, JournalError } from '../lib/execution-journal.mjs';
import { validateReconcileConfig, ReconcileError } from '../lib/cloud-reconcile.mjs';
import { recoverOnce } from '../lib/controller-recovery.mjs';

let journal, stopped = false;
const cancellation = new AbortController();
const stop = () => { stopped = true; cancellation.abort(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const options = new Map();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--config', '--once', '--loop', '--cooldown-ms', '--resume-poll'].includes(key) || options.has(key)) throw new ReconcileError('USAGE_CONTROLLER_RECOVERY');
    if (['--once', '--loop'].includes(key)) options.set(key, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new ReconcileError('USAGE_CONTROLLER_RECOVERY');
      options.set(key, value);
    }
  }
  if (!options.has('--config') || ['--once', '--loop', '--resume-poll'].filter(key => options.has(key)).length !== 1 || (options.has('--resume-poll') && options.has('--cooldown-ms'))) throw new ReconcileError('USAGE_CONTROLLER_RECOVERY');
  let input;
  try { input = JSON.parse(await fs.readFile(options.get('--config'), 'utf8')); } catch { throw new ReconcileError('INVALID_CONFIG_FILE'); }
  const config = validateReconcileConfig(input);
  const cooldown = options.has('--cooldown-ms') ? Number(options.get('--cooldown-ms')) : null;
  if (cooldown !== null && (!Number.isInteger(cooldown) || cooldown < 1000 || cooldown > 86400000)) throw new ReconcileError('INVALID_PROVIDER_COOLDOWN');
  journal = new ExecutionJournal({ directory: config.stateDir, companyId: config.companyId });
  if (options.has('--resume-poll')) {
    const resumed = journal.resumePolling(options.get('--resume-poll'), { now: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'polling_resumed', executionId: resumed.record.executionId, nextPollAt: resumed.polling.nextPollAt }));
  } else {
    if (cooldown !== null) journal.deferProviderRequests({ now: new Date().toISOString(), delayMs: cooldown });
    let recoveryCursor;
    do {
      const result = await recoverOnce({ config, journal, recoveryCursor, shouldStop: () => stopped,
        sleep: async ms => { try { await delay(ms, undefined, { signal: cancellation.signal }); } catch { /* Stop interrupts rate waits. */ } },
      });
      recoveryCursor = result.recoveryCursor;
      console.log(JSON.stringify(result));
      if (options.has('--once') || stopped) break;
      for (let remaining = config.intervalMs; remaining > 0 && !stopped; remaining -= 250) await delay(Math.min(remaining, 250));
    } while (!stopped);
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'needs_attention', code: error instanceof ReconcileError || error instanceof JournalError ? error.code : 'CONTROLLER_RECOVERY_FAILED' }));
  process.exitCode = 1;
} finally { journal?.close(); }
