import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseRoleArtifactDiff, reviewArtifactPath } from '../lib/review-artifact.mjs';

const executionId = randomUUID(), taskId = randomUUID();
const binding = { pipelineId: randomUUID(), jobId: randomUUID(), roleExecutionId: executionId, sourceExecutionId: randomUUID(), repository: 'fixture/project', pullRequestNumber: 7, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), sourcePatchSha256: 'c'.repeat(64) };
function report(role = 'reviewer', patch = {}) {
  return { schemaVersion: 1, templateVersion: 1, role, taskId, repository: binding.repository, baseSha: binding.baseSha, headSha: binding.headSha, summary: 'Observed review outcome.', evidence: [{ kind: 'command', description: 'Focused tests ran.', status: 'passed', command: ['node', '--test'], exitCode: 0 }], ...(role === 'reviewer' ? { outcome: 'clean', findings: [] } : { outcome: 'passed', checks: [{ criterion: 'Acceptance criterion checked.', status: 'passed', evidenceIndexes: [0] }] }), ...patch };
}
function diff(envelope, { path = reviewArtifactPath(executionId), content = JSON.stringify(envelope, null, 2) + '\n' } = {}) {
  const lines = content.slice(0, -1).split('\n');
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1234567', '--- /dev/null', '+++ b/' + path, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => '+' + line), ''].join('\n');
}
const options = role => ({ role, executionId, taskId, expectedBinding: binding });

test('complete reviewer and QA evidence files are extracted without applying a patch', () => {
  for (const role of ['reviewer', 'qa']) {
    const parsed = parseRoleArtifactDiff(diff({ schemaVersion: 1, binding, report: report(role) }), options(role));
    assert.equal(parsed.artifactPath, reviewArtifactPath(executionId));
    assert.equal(parsed.report.role, role); assert.equal(parsed.report.evidenceVerified, false);
    assert.equal(parsed.report.evidenceSource, 'agent_report'); assert.match(parsed.artifactSha256, /^[a-f0-9]{64}$/);
  }
});

test('wrong path, additional application edits, modes, removals, truncated hunks and binary output fail closed', () => {
  const valid = diff({ schemaVersion: 1, binding, report: report() });
  for (const patch of [
    valid.replaceAll(reviewArtifactPath(executionId), 'src/application.mjs'), valid + valid,
    valid.replace('100644', '120000'), valid.replace('100644', '100755'), valid.replace('--- /dev/null', '--- a/' + reviewArtifactPath(executionId)),
    valid.replace(/\+\}\n$/, ''), valid.replace('+{', '-{'), valid.replace('new file mode 100644', 'GIT binary patch'), valid.slice(0, -1),
  ]) assert.throws(() => parseRoleArtifactDiff(patch, options('reviewer')));
});

test('duplicate JSON keys at any depth and YAML-only syntax cannot conceal a report field', () => {
  const original = JSON.stringify({ schemaVersion: 1, binding, report: report() });
  for (const content of [original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1') + '\n', original.replace('"outcome":"clean"', '"outcome":"changes_requested","outcome":"clean"') + '\n', 'schemaVersion: 1\n']) {
    assert.throws(() => parseRoleArtifactDiff(diff(null, { content }), options('reviewer')), { code: 'INVALID_REVIEW_ARTIFACT_JSON' });
  }
});

test('every immutable source identity is checked and model verified flags are rejected', () => {
  for (const patch of [{ headSha: 'f'.repeat(40) }, { sourceExecutionId: randomUUID() }, { pipelineId: randomUUID() }, { sourcePatchSha256: 'e'.repeat(64) }, { pullRequestNumber: 8 }]) {
    assert.throws(() => parseRoleArtifactDiff(diff({ schemaVersion: 1, binding: { ...binding, ...patch }, report: report() }), options('reviewer')), { code: 'REVIEW_ARTIFACT_BINDING_CHANGED' });
  }
  assert.throws(() => parseRoleArtifactDiff(diff({ schemaVersion: 1, binding, report: report('reviewer', { evidenceVerified: true }) }), options('reviewer')), { code: 'INVALID_REVIEW_ARTIFACT_REPORT' });
  assert.throws(() => parseRoleArtifactDiff(diff({ schemaVersion: 1, binding, report: report('reviewer', { taskId: randomUUID() }) }), options('reviewer')), { code: 'INVALID_REVIEW_ARTIFACT_REPORT' });
});

test('blocking and infrastructure findings cannot be reported as clean', () => {
  for (const classification of ['blocking', 'infrastructure']) {
    const result = report('reviewer', { findings: [{ id: 'R1', classification, message: 'A specific defect or unavailable evidence.' }] });
    assert.throws(() => parseRoleArtifactDiff(diff({ schemaVersion: 1, binding, report: result }), options('reviewer')), { code: 'INVALID_REVIEW_ARTIFACT_REPORT' });
  }
});

test('artifact paths and input size reject injection without echoing provider content', () => {
  assert.throws(() => reviewArtifactPath('../escape'), { code: 'INVALID_REVIEW_EXECUTION' });
  assert.throws(() => parseRoleArtifactDiff('SECRET_FIXTURE'.repeat(25_000), options('reviewer')), error => !error.message.includes('SECRET_FIXTURE'));
});
