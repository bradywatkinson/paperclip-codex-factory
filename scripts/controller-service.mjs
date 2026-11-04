#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { manageControllerService } from '../lib/controller-service.mjs';

const HELP = `Usage: node scripts/controller-service.mjs COMMAND [options]
  install | start | stop | status | uninstall
  dry-run                          Show the exact install plan without writes

Options:
  --config ABS_JSON                Install configuration (no credentials)
  --instance-dir ABS_DIRECTORY     Existing private factory instance
  --dry-run                        Show a plan without writes or launchctl calls
  --replace                        Explicitly replace an owned changed installation
  --json

The separate LaunchAgent is ing.paperclip.codex-factory.controller.
Stop/uninstall retain Cloud receipts, journals, configuration receipts and logs.
`;
export async function runControllerServiceCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), home = os.homedir(), run, uid, platform } = {}) {
  const json = args.includes('--json');
  try {
    if (!args.length || args.includes('--help')) { stdout(HELP); return 0; }
    const command = args[0], options = new Map();
    if (!['install', 'start', 'stop', 'status', 'uninstall', 'dry-run'].includes(command)) throw Object.assign(new Error(), { code: 'USAGE_CONTROLLER_SERVICE' });
    for (let index = 1; index < args.length; index++) {
      const key = args[index];
      if (options.has(key)) throw Object.assign(new Error(), { code: 'USAGE_CONTROLLER_SERVICE' });
      if (['--json', '--dry-run', '--replace'].includes(key)) options.set(key, true);
      else if (['--config', '--instance-dir'].includes(key)) { const value = args[++index]; if (!value || !path.isAbsolute(value)) throw Object.assign(new Error(), { code: 'USAGE_CONTROLLER_SERVICE' }); options.set(key, value); }
      else throw Object.assign(new Error(), { code: 'USAGE_CONTROLLER_SERVICE' });
    }
    if ((options.has('--config') || options.has('--replace')) && !['install', 'dry-run'].includes(command)) throw Object.assign(new Error(), { code: 'USAGE_CONTROLLER_SERVICE' });
    let config;
    if (options.has('--config')) {
      const filename = options.get('--config'), stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) throw Object.assign(new Error(), { code: 'INVALID_CONTROLLER_SERVICE_CONFIG' });
      config = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (options.has('--instance-dir') && config.instanceDirectory !== options.get('--instance-dir')) throw Object.assign(new Error(), { code: 'CONTROLLER_SERVICE_BINDING_CHANGED' });
    }
    const result = await manageControllerService({ command: command === 'dry-run' ? 'install' : command, config, home, instanceDirectory: options.get('--instance-dir'), dryRun: command === 'dry-run' || options.has('--dry-run'), replace: options.has('--replace'), ...(run ? { run } : {}), ...(uid !== undefined ? { uid } : {}), ...(platform ? { platform } : {}) });
    stdout(json ? JSON.stringify(result) + '\n' : `${result.status}\n${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'needs_attention' ? 1 : 0;
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'CONTROLLER_SERVICE_OPERATION_FAILED';
    const result = { status: 'needs_attention', code, correction: 'Inspect the dry-run plan and owned installation. Service permission failures must be resolved in the normal macOS user session.' };
    stderr(json ? JSON.stringify(result) + '\n' : `${code}: ${result.correction}\n`); return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runControllerServiceCli(process.argv.slice(2));
