#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextFromEnv, DispatchError } from '../lib/cloud-dispatch.mjs';
import { dispatchReviewFromPaperclip } from '../lib/review-dispatch.mjs';

export async function runReviewDispatchCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), context = contextFromEnv(), ...dependencies } = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw new DispatchError('USAGE_REVIEW_DISPATCH_CONFIG');
    const stat = fs.lstatSync(args[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) throw new DispatchError('INVALID_CONFIG_FILE');
    let config; try { config = JSON.parse(fs.readFileSync(args[1], 'utf8')); } catch { throw new DispatchError('INVALID_CONFIG_FILE'); }
    const result = await dispatchReviewFromPaperclip({ config, context, ...dependencies });
    stdout(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const safe = error instanceof DispatchError ? error : new DispatchError('REVIEW_DISPATCH_FAILED');
    stderr(JSON.stringify({ status: 'needs_attention', evidenceVerified: false, code: safe.code, outcome: safe.outcome, ...(safe.cloudTaskId ? { cloudTaskId: safe.cloudTaskId } : {}) }) + '\n'); return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runReviewDispatchCli(process.argv.slice(2));
