#!/usr/bin/env node
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionJournal, JournalError } from '../lib/execution-journal.mjs';
import { reconcileOnce, validateReconcileConfig, ReconcileError } from '../lib/cloud-reconcile.mjs';
let journal;
let stopped = false;
const cancellation = new AbortController();
const stop = () => { stopped = true; cancellation.abort(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--config' || !['--once', '--loop'].includes(args[2])) throw new ReconcileError('USAGE_CLOUD_RECONCILE');
  let input;
  try { input = JSON.parse(await fs.readFile(args[1], 'utf8')); } catch { throw new ReconcileError('INVALID_CONFIG_FILE'); }
  const config = validateReconcileConfig(input);
  journal = new ExecutionJournal({ directory: config.stateDir, companyId: config.companyId });
  do {
    const result = await reconcileOnce({ config, journal, shouldStop: () => stopped,
      sleep: async ms => { try { await delay(ms, undefined, { signal: cancellation.signal }); } catch { /* Stop interrupts rate waits. */ } },
    });
    console.log(JSON.stringify({ status: result.unresolved ? 'needs_attention' : 'reconciled', ...result }));
    if (args[2] === '--once' || stopped) break;
    // Short sleeps allow a prompt stop between cycles.
    for (let remaining = config.intervalMs; remaining > 0 && !stopped; remaining -= 250) await delay(Math.min(remaining, 250));
  } while (!stopped);
} catch (error) {
  console.error(JSON.stringify({ status: 'needs_attention', code: error instanceof ReconcileError || error instanceof JournalError ? error.code : 'RECONCILIATION_FAILED' }));
  process.exitCode = 1;
} finally { journal?.close(); }
