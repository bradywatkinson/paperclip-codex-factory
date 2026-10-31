// Configure only a stopped instance. Never print config contents or credentials.
import fs from 'node:fs';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/configure-local.mjs <config.json>');
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
config.server = {
  ...config.server,
  deploymentMode: 'authenticated', exposure: 'private', bind: 'loopback',
  host: '127.0.0.1', port: 3100, allowedHostnames: [], serveUi: true,
};
delete config.server.customBindHost;
config.auth = { ...config.auth, baseUrlMode: 'auto' };
if (config.auth.disableSignUp === undefined) config.auth.disableSignUp = false;
delete config.auth.publicBaseUrl;
const tmp = `${path}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, path);
} finally {
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}
console.log('Configured authenticated private loopback on port 3100.');
