#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createPaperclipMcpServer, validatePaperclipMcpConfig } from '../lib/paperclip-mcp.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw new Error('INVALID_MCP_ARGUMENTS');
  const stat = fs.lstatSync(args[1]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32000) throw new Error('INVALID_MCP_CONFIG_FILE');
  const bytes = fs.readFileSync(args[1]);
  if (bytes.length > 32000) throw new Error('INVALID_MCP_CONFIG_FILE');
  const config = validatePaperclipMcpConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const handle = serveStdio(() => createPaperclipMcpServer({ config }), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128000 }),
    onerror: () => process.stderr.write('MCP_PROTOCOL_ERROR\n'),
  });
  const stop = () => { void handle.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stderr.write('Paperclip factory MCP is listening on stdio.\n');
} catch (error) {
  process.stderr.write((typeof error.code === 'string' && /^(?:INVALID_MCP|MCP)_[A-Z_]+$/.test(error.code) ? error.code : 'MCP_STARTUP_FAILED') + '\n');
  process.exitCode = 1;
}
