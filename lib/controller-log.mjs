import fs from 'node:fs';
import path from 'node:path';

export class ControllerLogError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'ControllerLogError'; }
}
const fail = code => { throw new ControllerLogError(code); };
export function redactControllerDiagnostic(line) {
  return line
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:pcp_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/([?&](?:token|key|access_token|refresh_token)=)[^&#\s"]+/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
}
function regular(filename) {
  try { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink()) fail('CONTROLLER_LOG_UNSAFE_FILE'); return stat; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** One combined log, at most maxFiles * maxBytes, plus bounded per-stream lines. */
export class RotatingControllerLog {
  constructor({ directory, maxBytes = 5 * 1024 * 1024, maxFiles = 5, maxLineBytes = 32768, onReport } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory) || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 5 * 1024 * 1024 || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 5 || !Number.isInteger(maxLineBytes) || maxLineBytes < 64 || maxLineBytes > 32768) fail('INVALID_CONTROLLER_LOG_CONFIG');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('CONTROLLER_LOG_UNSAFE_DIRECTORY');
    fs.chmodSync(directory, 0o700);
    this.directory = directory; this.filename = path.join(directory, 'controller.log');
    this.maxBytes = maxBytes; this.maxFiles = maxFiles; this.maxLineBytes = maxLineBytes; this.onReport = onReport;
    this.streams = new Map();
    for (let index = 0; index < 5; index++) {
      const filename = this.#filename(index), stat = regular(filename);
      if (stat && (index >= maxFiles || stat.size > maxBytes)) fs.unlinkSync(filename);
      else if (stat) fs.chmodSync(filename, 0o600);
    }
  }
  #filename(index) { return index ? this.filename + '.' + index : this.filename; }
  #rotate() {
    const oldest = this.#filename(this.maxFiles - 1);
    if (regular(oldest)) fs.unlinkSync(oldest);
    for (let index = this.maxFiles - 2; index >= 0; index--) {
      const source = this.#filename(index);
      if (regular(source)) fs.renameSync(source, this.#filename(index + 1));
    }
  }
  #line(channel, line, dropped = false) {
    if (channel === 'stdout' && !dropped && this.onReport) {
      try { const result = JSON.parse(line); if (['idle', 'running', 'paused', 'needs_attention', 'stopped'].includes(result.status)) this.onReport(result.status); } catch { /* Only bounded, recognized controller reports become status metadata. */ }
    }
    const safe = dropped ? 'LOG_LINE_DROPPED' : redactControllerDiagnostic(line);
    let output = `[${channel}] ${safe}\n`;
    if (Buffer.byteLength(output) > this.maxBytes) output = `[${channel}] LOG_LINE_DROPPED\n`;
    const before = regular(this.filename);
    if (before && before.size + Buffer.byteLength(output) > this.maxBytes) this.#rotate();
    const fd = fs.openSync(this.filename, 'a', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, output); }
    finally { fs.closeSync(fd); }
  }
  write(channel, chunk) {
    if (!['stdout', 'stderr'].includes(channel)) fail('INVALID_CONTROLLER_LOG_CHANNEL');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const state = this.streams.get(channel) ?? { pending: Buffer.alloc(0), dropping: false };
    this.streams.set(channel, state);
    let offset = 0;
    while (offset < bytes.length) {
      const next = bytes.indexOf(10, offset), end = next === -1 ? bytes.length : next;
      const part = bytes.subarray(offset, end);
      if (!state.dropping) {
        if (state.pending.length + part.length > this.maxLineBytes) { state.pending = Buffer.alloc(0); state.dropping = true; }
        else state.pending = Buffer.concat([state.pending, part]);
      }
      if (next !== -1) { this.#line(channel, state.pending.toString('utf8'), state.dropping); state.pending = Buffer.alloc(0); state.dropping = false; }
      offset = end + 1;
    }
  }
  end(channel) {
    const state = this.streams.get(channel);
    if (state && (state.pending.length || state.dropping)) this.#line(channel, state.pending.toString('utf8'), state.dropping);
    this.streams.delete(channel);
  }
  close() { for (const channel of [...this.streams.keys()]) this.end(channel); }
}
