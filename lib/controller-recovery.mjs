import { cloudEnvironment, runCommand } from './cloud-dispatch.mjs';
import { reconcileOnce, validateReconcileConfig, ReconcileError } from './cloud-reconcile.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const RACE = new Set(['JOURNAL_STALE_EXECUTION_TRANSITION', 'JOURNAL_STALE_POLL_LEASE', 'JOURNAL_STALE_HANDOFF_LEASE']);

export async function recoverOnce({ config: input, journal, run = runCommand, now = () => new Date().toISOString(), sleep, shouldStop = () => false, env = process.env, recoveryCursor }) {
  const config = validateReconcileConfig(input);
  if (journal.companyId !== config.companyId) throw new ReconcileError('JOURNAL_COMPANY_MISMATCH');
  if (recoveryCursor !== undefined && !UUID.test(recoveryCursor)) throw new ReconcileError('INVALID_RECOVERY_CURSOR');
  const snapshot = journal.listNonterminal();
  const candidates = snapshot.filter(record => record.state === 'dispatching');
  const start = recoveryCursor ? (candidates.findIndex(record => record.executionId === recoveryCursor) + 1) % Math.max(1, candidates.length) : 0;
  const selected = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, config.maxRecords);
  const recovery = { scanned: snapshot.length, interrupted: 0, waiting: 0, deferred: candidates.length - selected.length, needsAttention: [] };
  const owners = new Map();
  const childEnv = { ...cloudEnvironment(env), PAPERCLIP_TELEMETRY_DISABLED: '1' };
  for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') childEnv[key] = env[key];
  for (const record of selected) {
    if (shouldStop()) break;
    recoveryCursor = record.executionId;
    let owner;
    try {
      const response = await run(config.paperclipCommand, ['run', 'get', record.paperclipRunId, '--api-base', config.apiBase, '--json'], { env: childEnv, timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxOutputBytes });
      if (response.code !== 0 || response.signal || response.timedOut || response.outputExceeded || response.failedToStart) throw new Error();
      owner = JSON.parse(response.stdout);
    } catch { owners.set(record.executionId, 'owner_unavailable'); continue; }
    if (owner?.id !== record.paperclipRunId || owner.companyId !== config.companyId || owner.contextSnapshot?.issueId !== record.paperclipIssueId || !UUID.test(owner.agentId ?? '')) {
      owners.set(record.executionId, 'owner_scope_mismatch'); continue;
    }
    if (ACTIVE.has(owner.status)) { owners.set(record.executionId, 'active'); recovery.waiting++; continue; }
    if (!TERMINAL.has(owner.status)) { owners.set(record.executionId, 'owner_unavailable'); continue; }
    try {
      // A terminal owner is evidence only for this captured revision. A caller
      // accepting a receipt while the read was in flight must win unchanged.
      journal.transition(record.paperclipIssueId, { attempt: record.attempt, expectedState: 'dispatching', expectedRevision: record.revision, toState: 'unknown', errorCode: 'INTERRUPTED_DISPATCH' });
      recovery.interrupted++;
    } catch (error) { if (!RACE.has(error?.code)) throw error; }
  }
  const reconciliation = await reconcileOnce({ config, journal, run, now, sleep, shouldStop, env });
  const attention = (record, reason) => recovery.needsAttention.push({ executionId: record.executionId, paperclipIssueId: record.paperclipIssueId, state: record.state, reason, ...(record.cloudTaskId ? { cloudTaskId: record.cloudTaskId } : {}) });
  const unfinished = journal.listNonterminal();
  for (const record of unfinished) {
    if (record.state === 'queued') attention(record, 'queued_not_submitted');
    else if (record.state === 'unknown' && !record.cloudTaskId) attention(record, 'submission_outcome_unknown');
    else if (record.state === 'dispatching' && owners.has(record.executionId) && owners.get(record.executionId) !== 'active') attention(record, owners.get(record.executionId));
    else if (record.cloudTaskId && (journal.polling(record.executionId)?.errorCount ?? 0) >= config.maxPollErrors) attention(record, 'poll_retry_limit');
  }
  let pendingDelivery = false;
  for (const record of journal.list()) {
    for (const handoff of journal.handoffs(record.executionId)) {
      if (['pending', 'leased', 'sending', 'unknown'].includes(handoff.state)) pendingDelivery = true;
      if (handoff.state === 'unknown' || (handoff.state === 'sending' && (!handoff.leaseExpiresAt || handoff.leaseExpiresAt <= now()))) attention(record, 'notification_outcome_unknown');
    }
  }
  const status = recovery.needsAttention.length || reconciliation.unresolved ? 'needs_attention'
    : unfinished.length || pendingDelivery || reconciliation.providerRetryAt ? 'recovering' : 'reconciled';
  return { status, recovery, reconciliation, ...(recoveryCursor ? { recoveryCursor } : {}) };
}
