#!/usr/bin/env node
import { ExecutionJournal, JournalError, JOURNAL_SCHEMA_VERSION } from '../lib/execution-journal.mjs';

let journal;
try {
  const [command, ...argv] = process.argv.slice(2);
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--state-dir', '--company-id', '--issue-id', '--attempt', '--quiesced'].includes(key) || options.has(key)) throw new JournalError('INVALID_COMMAND_OPTIONS');
    if (key === '--quiesced') options.set(key, true);
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new JournalError('INVALID_COMMAND_OPTIONS'); options.set(key, value); }
  }
  if (!['list', 'get', 'migrate-guards', 'recover'].includes(command) || !options.has('--state-dir') || !options.has('--company-id')) throw new JournalError('USAGE_EXECUTION_JOURNAL');
  if (['migrate-guards', 'recover'].includes(command) && !options.get('--quiesced')) throw new JournalError('QUIESCED_DISPATCHERS_REQUIRED');
  if (['get', 'recover'].includes(command) && !options.has('--issue-id')) throw new JournalError('ISSUE_ID_REQUIRED');
  const attempt = options.has('--attempt') ? Number(options.get('--attempt')) : 1;
  journal = new ExecutionJournal({ directory: options.get('--state-dir'), companyId: options.get('--company-id') });
  let result;
  if (command === 'list') result = journal.list();
  if (command === 'get') result = { execution: journal.get(options.get('--issue-id'), attempt), events: journal.events(options.get('--issue-id'), attempt), runs: journal.runs(options.get('--issue-id'), attempt) };
  if (command === 'migrate-guards') result = options.has('--issue-id') ? journal.importLegacyGuard(options.get('--issue-id')) : journal.importLegacyGuards();
  if (command === 'recover') result = journal.recoverInterrupted(options.get('--issue-id'), attempt);
  console.log(JSON.stringify({ journalSchemaVersion: JOURNAL_SCHEMA_VERSION, result }));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof JournalError ? error.code : 'JOURNAL_OPERATION_FAILED' }));
  process.exitCode = 1;
} finally { journal?.close(); }
