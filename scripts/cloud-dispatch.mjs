#!/usr/bin/env node
import fs from 'node:fs/promises';
import { contextFromEnv, dispatchFromPaperclip, DispatchError } from '../lib/cloud-dispatch.mjs';
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new DispatchError('USAGE_CLOUD_DISPATCH_CONFIG');
  let config;
  try { config = JSON.parse(await fs.readFile(process.argv[3], 'utf8')); }
  catch { throw new DispatchError('INVALID_CONFIG_FILE'); }
  const receipt = await dispatchFromPaperclip({ config, context: contextFromEnv() });
  console.log(JSON.stringify(receipt));
} catch (error) {
  const safe = error instanceof DispatchError ? error : new DispatchError('DISPATCH_BRIDGE_FAILED');
  console.error(JSON.stringify({ status: 'needs_attention', code: safe.code, outcome: safe.outcome, ...(safe.cloudTaskId ? { cloudTaskId: safe.cloudTaskId } : {}) }));
  process.exitCode = 1;
}
