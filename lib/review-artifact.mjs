import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { validateRoleResult } from './agent-roles.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const BINDING_FIELDS = ['pipelineId', 'jobId', 'roleExecutionId', 'sourceExecutionId', 'repository', 'pullRequestNumber', 'baseSha', 'headSha', 'sourcePatchSha256'];
const hash = text => createHash('sha256').update(text).digest('hex');
export class ReviewArtifactError extends Error {
  constructor(code) { super(code); this.name = 'ReviewArtifactError'; this.code = code; }
}
const fail = code => { throw new ReviewArtifactError(code); };
function mapping(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || ['__proto__', 'constructor', 'prototype'].some(key => Object.hasOwn(value, key))) fail('INVALID_REVIEW_ARTIFACT');
}
export function reviewArtifactPath(executionId) {
  if (!UUID.test(executionId ?? '')) fail('INVALID_REVIEW_EXECUTION');
  return '.factory/reviews/' + executionId + '.json';
}

/** Extract a complete new evidence file, never apply a provider-controlled patch. */
export function parseRoleArtifactDiff(patch, { role, executionId, expectedBinding, taskId } = {}) {
  if (!['reviewer', 'qa'].includes(role) || !UUID.test(taskId ?? '')) fail('INVALID_REVIEW_ROLE');
  const artifactPath = reviewArtifactPath(executionId);
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 262_144 || /[\0\x1b]/.test(patch) || !patch.endsWith('\n')) fail('INVALID_REVIEW_ARTIFACT_DIFF');
  const lines = patch.slice(0, -1).split('\n');
  if (lines[0] !== `diff --git a/${artifactPath} b/${artifactPath}` || lines[1] !== 'new file mode 100644' || !/^index 0{7,40}\.\.[a-f0-9]{7,40}$/.test(lines[2] ?? '') || lines[3] !== '--- /dev/null' || lines[4] !== '+++ b/' + artifactPath) fail('INVALID_REVIEW_ARTIFACT_DIFF');
  const hunk = /^@@ -0,0 \+1(?:,(\d+))? @@$/.exec(lines[5] ?? '');
  const count = Number(hunk?.[1] ?? 1);
  if (!hunk || !Number.isSafeInteger(count) || count < 1 || lines.length !== count + 6 || lines.slice(6).some(line => !line.startsWith('+'))) fail('INVALID_REVIEW_ARTIFACT_DIFF');
  const content = lines.slice(6).map(line => line.slice(1)).join('\n') + '\n';
  if (Buffer.byteLength(content) > 128_000) fail('REVIEW_ARTIFACT_TOO_LARGE');
  let envelope;
  try {
    // JSON.parse alone would silently accept duplicate keys. YAML's JSON schema
    // checks uniqueness first; JSON.parse then excludes YAML-only syntax.
    const document = parseDocument(content, { schema: 'json', strict: true, uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length) fail('INVALID_REVIEW_ARTIFACT_JSON');
    envelope = JSON.parse(content);
  } catch { fail('INVALID_REVIEW_ARTIFACT_JSON'); }
  mapping(envelope, ['schemaVersion', 'binding', 'report']);
  if (envelope.schemaVersion !== 1) fail('INVALID_REVIEW_ARTIFACT');
  mapping(envelope.binding, BINDING_FIELDS);
  const binding = envelope.binding;
  if (BINDING_FIELDS.some(key => !Object.hasOwn(binding, key)) || ['pipelineId', 'jobId', 'roleExecutionId', 'sourceExecutionId'].some(key => !UUID.test(binding[key] ?? '')) || binding.roleExecutionId !== executionId || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(binding.repository ?? '') || !Number.isSafeInteger(binding.pullRequestNumber) || binding.pullRequestNumber < 1 || !SHA.test(binding.baseSha ?? '') || !SHA.test(binding.headSha ?? '') || !HASH.test(binding.sourcePatchSha256 ?? '')) fail('INVALID_REVIEW_ARTIFACT');
  if (!expectedBinding || BINDING_FIELDS.some(key => key === 'repository' ? binding[key].toLowerCase() !== expectedBinding[key]?.toLowerCase() : binding[key] !== expectedBinding[key])) fail('REVIEW_ARTIFACT_BINDING_CHANGED');
  let report;
  try { report = validateRoleResult(role, envelope.report, { taskId, repository: binding.repository, baseSha: binding.baseSha, headSha: binding.headSha }); }
  catch { fail('INVALID_REVIEW_ARTIFACT_REPORT'); }
  return Object.freeze({ schemaVersion: 1, artifactPath, artifactSha256: hash(content), patchSha256: hash(patch), content, binding: Object.freeze({ ...binding }), report });
}
