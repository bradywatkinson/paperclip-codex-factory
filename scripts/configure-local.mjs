// Configure only a stopped instance. Never print config contents or credentials.
import fs from 'node:fs';
import net from 'node:net';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/configure-local.mjs <config.json>');
// Refuse to rewrite configuration while the intended HTTP port is in use.
const listening = await new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port: 8100 });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', error => {
    if (error.code === 'ECONNREFUSED') resolve(false);
    else { socket.destroy(); resolve(true); }
  });
  socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
});
if (listening) throw new Error('Port 8100 is in use. Stop the instance before configuring it.');
let config;
try {
  config = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
} catch {
  throw new Error('Cannot read a valid Paperclip config object; file left unchanged.');
}
if (config.server?.port && config.server.port !== 8100) {
  throw new Error('Expected port 8100; stop and configure this instance manually.');
}
config.server = {
  ...config.server,
  deploymentMode: 'authenticated', exposure: 'private', bind: 'loopback',
  host: '127.0.0.1', port: 8100, allowedHostnames: [], serveUi: true,
};
delete config.server.customBindHost;
config.auth = { ...config.auth, baseUrlMode: 'auto' };
if (config.auth.disableSignUp === undefined) config.auth.disableSignUp = false;
delete config.auth.publicBaseUrl;
config.telemetry = { ...config.telemetry, enabled: false };
const tmp = `${path}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, path);
} finally {
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}
console.log('Configured authenticated private loopback on port 8100.');
