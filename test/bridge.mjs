// Tests the phone bridge end to end: it starts the real Python server, hits it
// over HTTP, and checks validation, auth, confinement and static serving.
//
// The Termux:API commands are replaced by fake executables on PATH that echo
// their argv as JSON. That proves two important things a dry-run cannot: the
// command really is executed with a list of arguments, and a hostile string in
// an argument stays a single argument (no shell, no injection).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-123';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

/* ------------------------------------------------------------- fake phone */
const fake = mkdtempSync(join(tmpdir(), 'jarvis-fake-'));
const jarvisHome = join(fake, 'home');
mkdirSync(jarvisHome, { recursive: true });
for (const cmd of ['termux-battery-status', 'termux-sms-send', 'termux-volume', 'termux-torch',
  'termux-clipboard-get', 'termux-notification-list', 'termux-sms-list']) {
  const file = join(fake, cmd);
  writeFileSync(file, `#!/bin/sh\nexec python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"\n`);
  chmodSync(file, 0o755);
}

// --port 0 lets the OS pick a free port, so two test runs can never collide.
const boot = (_unused, extraArgs) => new Promise((resolve, reject) => {
  const proc = spawn('python3', [join(root, 'bridge', 'jarvis_bridge.py'), '--root', root,
    '--host', '127.0.0.1', '--port', '0', '--token', TOKEN,
    '--allow-origin', 'https://example.com', ...extraArgs], {
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, JARVIS_HOME: jarvisHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  let out = '';
  procs.push(proc);                     // kill it even if boot fails
  proc.stderr.on('data', (d) => { err += d; });
  const deadline = Date.now() + 15000;
  const poll = async () => {
    if (proc.exitCode !== null) return reject(new Error('bridge exited: ' + err.slice(0, 300)));
    const port = (out.match(/http:\/\/127\.0\.0\.1:(\d+)/) || [])[1];
    if (port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) { proc.port = Number(port); return resolve(proc); }
      } catch {}
    }
    if (Date.now() > deadline) return reject(new Error('bridge never became ready: ' + (err + out).slice(0, 300)));
    setTimeout(poll, 120);
  };
  proc.stdout.on('data', (d) => { out += d; if (!proc.port) poll(); });
  poll();
});

const call = async (port, path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: { 'X-Jarvis-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { res, body };
};
const exec = (port, name, args, headers) => call(port, '/api/exec', { method: 'POST', headers, body: JSON.stringify({ name, arguments: args }) });

let portA = null;
let portB = null;
let a = null;
let b = null;
const procs = [];

try {
  /* =============================================== phase A: real execution */
  a = await boot(null, []);
  portA = a.port;

  const health = await call(portA, '/api/health');
  check('health responds', health.res.ok && health.body.ok === true);
  check('health reports the tool count', health.body.tools === 28, String(health.body.tools));
  check('health says this is not an Android device', health.body.android === false);
  check('health reports that a token is required', health.body.tokenRequired === true);

  const listed = await call(portA, '/api/tools');
  check('/api/tools needs no body and returns schemas', listed.body.tools.length === 28);
  const torch = listed.body.tools.find((t) => t.function.name === 'torch');
  check('tools are OpenAI function schemas', torch.type === 'function' && torch.function.parameters.type === 'object');
  check('required arguments are declared', torch.function.parameters.required.includes('state'));
  check('enum values reach the schema', torch.function.parameters.properties.state.enum.includes('on'));
  check('tool groups and titles are exposed for the UI', torch.group === 'Device' && torch.title === 'Flashlight');
  const sms = listed.body.tools.find((t) => t.function.name === 'send_sms');
  check('dangerous tools are flagged', sms.danger === true);
  const shell = listed.body.tools.find((t) => t.function.name === 'run_command');
  check('the shell tool is off by default', shell.defaultOff === true);
  const missing = listed.body.tools.find((t) => t.function.name === 'termux_location' || t.function.name === 'location');
  check('an installed command is reported ready', torch.available === true);
  check('a command that is not installed is reported missing', missing.available === false);
  check('the missing tool explains how to fix it', /pkg install termux-api/.test(missing.unavailableReason));

  // --- real execution through the fake termux binary
  const batt = await exec(portA, 'battery_status', {});
  check('a command tool actually runs', batt.body.ok === true && batt.body.name === 'battery_status', batt.body.error || '');
  check('argv is passed as a list, not a shell string', batt.body.output === '[]', batt.body.output);

  const vol = await exec(portA, 'volume_set', { stream: 'music', level: 7 });
  check('arguments are substituted into the command', JSON.stringify(JSON.parse(vol.body.output)) === '["music","7"]', vol.body.output);

  const inj = await exec(portA, 'send_sms', { number: '03001234567', message: 'hi; rm -rf / && echo pwned `id`' });
  const argv = JSON.parse(inj.body.output);
  check('a hostile message stays one argv element', argv.length === 3 && argv[2] === 'hi; rm -rf / && echo pwned `id`', inj.body.output);
  check('the sms number is a separate argument', argv[1] === '03001234567');

  const listed2 = await exec(portA, 'read_sms', { limit: 5 });
  check('defaults are applied when an argument is omitted', JSON.parse(listed2.body.output)[0] === '-l' && JSON.parse(listed2.body.output)[1] === '5');

  // --- validation
  const badEnum = await exec(portA, 'torch', { state: 'maybe' });
  check('a bad enum is rejected', badEnum.res.status === 400 && /must be one of/.test(badEnum.body.error), badEnum.body.error);
  const badNum = await exec(portA, 'brightness_set', { level: 900 });
  check('an out-of-range number is rejected', badNum.res.status === 400 && /at most 255/.test(badNum.body.error));
  const badPhone = await exec(portA, 'call_number', { number: 'hello' });
  check('a bad phone number is rejected', badPhone.res.status === 400 && /unsupported format/.test(badPhone.body.error));
  const longSms = await exec(portA, 'send_sms', { number: '03001234567', message: 'x'.repeat(600) });
  check('an over-long message is rejected', longSms.res.status === 400 && /longer than 480/.test(longSms.body.error));
  const extra = await exec(portA, 'torch', { state: 'on', sneaky: 1 });
  check('unknown arguments are rejected', extra.res.status === 400 && /unknown argument/.test(extra.body.error));
  const noName = await exec(portA, 'nope_not_a_tool', {});
  check('an unknown tool is rejected', noName.res.status === 404);
  const path = await exec(portA, 'read_file', { path: '../../etc/passwd' });
  check('path traversal is rejected', path.res.status === 400 && /outside the folders/.test(path.body.error), path.body.error);
  const home = await exec(portA, 'read_file', { path: join(jarvisHome, '..', 'jarvis-allowed.txt') });
  check('relative paths out of the sandbox are rejected too', home.res.status === 400, home.body.error || 'accepted');

  // --- a real file read inside the allowed root
  writeFileSync(join(jarvisHome, 'note.txt'), 'hello from the phone\n');
  const read = await exec(portA, 'read_file', { path: join(jarvisHome, 'note.txt') });
  check('a file inside the allowed root is readable', read.body.ok === true && /hello from the phone/.test(read.body.output), read.body.error || '');

  // --- notes (the phone-side memory)
  const saved = await exec(portA, 'note_save', { text: 'the user prefers Urdu' });
  const notes = await exec(portA, 'note_list', {});
  check('a memory can be saved and recalled', saved.body.ok === true && /prefers Urdu/.test(notes.body.output), notes.body.output);

  // --- auth
  const noTok = await fetch(`http://127.0.0.1:${portA}/api/tools`);
  check('the API refuses calls without a token', noTok.status === 401);
  const badTok = await fetch(`http://127.0.0.1:${portA}/api/exec`, {
    method: 'POST',
    headers: { 'X-Jarvis-Token': 'wrong', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'battery_status', arguments: {} }),
  });
  check('a wrong token is refused', badTok.status === 401);
  const bearer = await fetch(`http://127.0.0.1:${portA}/api/tools`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  check('a bearer token also works', bearer.status === 200);
  const healthNoTok = await fetch(`http://127.0.0.1:${portA}/api/health`);
  check('health is readable without a token (for the connect button)', healthNoTok.status === 200);

  // --- protocol errors
  const badJson = await fetch(`http://127.0.0.1:${portA}/api/exec`, {
    method: 'POST',
    headers: { 'X-Jarvis-Token': TOKEN, 'Content-Type': 'application/json' },
    body: 'not json',
  });
  check('a malformed body is rejected', badJson.status === 400);
  const huge = await fetch(`http://127.0.0.1:${portA}/api/exec`, {
    method: 'POST',
    headers: { 'X-Jarvis-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'run_command', arguments: { command: 'x'.repeat(70000) } }),
  });
  check('an oversized body is rejected', huge.status === 413);
  check('an oversized body closes the connection (keeps keep-alive honest)', huge.headers.get('connection') === 'close', String(huge.headers.get('connection')));
  const unknownRoute = await call(portA, '/api/nope');
  check('an unknown endpoint is a 404', unknownRoute.res.status === 404);

  // --- CORS for the hosted app talking to the phone on loopback
  const preflight = await fetch(`http://127.0.0.1:${portA}/api/exec`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
  });
  check('preflight allows the configured origin', preflight.headers.get('access-control-allow-origin') === 'https://example.com');
  check('preflight allows the token header', /X-Jarvis-Token/i.test(preflight.headers.get('access-control-allow-headers') || ''));
  check('preflight clears private-network access (Chrome PNA)', preflight.headers.get('access-control-allow-private-network') === 'true');
  const alien = await fetch(`http://127.0.0.1:${portA}/api/health`, { headers: { Origin: 'https://evil.example' } });
  check('an unlisted origin gets no CORS grant', alien.headers.get('access-control-allow-origin') === null);

  // --- serving the app itself (same-origin install path)
  const page = await fetch(`http://127.0.0.1:${portA}/`);
  const htmlText = await page.text();
  check('the bridge serves the app at /', page.status === 200 && page.headers.get('content-type').startsWith('text/html'));
  check('the served page is the real app', /Jarvis AI Assistant/.test(htmlText));
  check('the served page is marked as bridge-served', /<meta name="jarvis-bridge" content="1">/.test(htmlText));
  check('the served page loads brain.js', /src="brain\.js"/.test(htmlText));
  check('the bridge hands the token to its own loopback page (one-tap setup)',
    new RegExp(`JARVIS_BRIDGE_TOKEN="${TOKEN}"`).test(htmlText), (htmlText.match(/JARVIS_BRIDGE_TOKEN="[^"]*"/) || ['missing'])[0]);
  const js = await fetch(`http://127.0.0.1:${portA}/brain.js`);
  check('the token is not injected into other files', !/JARVIS_BRIDGE_TOKEN/.test(await js.text()));
  const man = await fetch(`http://127.0.0.1:${portA}/manifest.webmanifest`);
  check('the manifest gets the manifest MIME type', man.headers.get('content-type').startsWith('application/manifest+json'));
  check('the service worker is allowed at the root', (await fetch(`http://127.0.0.1:${portA}/sw.js`)).headers.get('service-worker-allowed') === '/');
  // fetch() normalises "../" away before sending, so use the percent-encoded
  // form that a hostile client would actually send.
  const trav = await fetch(`http://127.0.0.1:${portA}/..%2fpackage.json`);
  check('static traversal is blocked', trav.status === 403 || trav.status === 404, `status ${trav.status}`);
  const trav2 = await fetch(`http://127.0.0.1:${portA}/%2e%2e/%2e%2e/etc/passwd`);
  check('deep static traversal is blocked', trav2.status === 403 || trav2.status === 404, `status ${trav2.status}`);
  check('a missing file is a 404', (await fetch(`http://127.0.0.1:${portA}/nope.txt`)).status === 404);

  /* ==================================== phase B: dry run, nothing executed */
  b = await boot(null, ['--dry-run', '--assume-installed', '--no-token']);
  portB = b.port;

  const dryTools = await call(portB, '/api/tools');
  check('dry run reports every tool as available', dryTools.body.tools.every((t) => t.available === true));
  const drySms = await exec(portB, 'send_sms', { number: '+923001234567', message: 'hello' });
  check('dry run shows the exact command', drySms.body.dryRun === true && drySms.body.argv.join(' ') === 'termux-sms-send -n +923001234567 hello', JSON.stringify(drySms.body.argv));
  const dryCmd = await exec(portB, 'run_command', { command: 'ls ~/storage/shared | head' });
  check('the shell tool is clearly a shell invocation', dryCmd.body.argv[0] === 'sh' && dryCmd.body.argv[1] === '-c');
  const dryCam = await exec(portB, 'camera_photo', { camera: '1' });
  check('a default photo path gets a timestamp', /storage\/pictures\/jarvis-\d{8}-\d{6}\.jpg$/.test(dryCam.body.argv[3]), JSON.stringify(dryCam.body.argv));
  const dryHealth = await call(portB, '/api/health');
  check('health reports dry-run mode', dryHealth.body.dryRun === true);

  // --no-token is the local-demo escape hatch: the app must still work against it
  const openTools = await fetch(`http://127.0.0.1:${portB}/api/tools`);
  check('demo mode answers without a token', openTools.status === 200);
  check('demo mode says no token is needed', dryHealth.body.tokenRequired === false);
  const openExec = await fetch(`http://127.0.0.1:${portB}/api/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'torch', arguments: { state: 'on' } }),
  });
  const openBody = await openExec.json();
  check('demo mode runs an action without a token', openBody.ok === true, JSON.stringify(openBody));
  check('demo mode still refuses an invalid argument',
    (await fetch(`http://127.0.0.1:${portB}/api/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'torch', arguments: { state: 'nope' } }) })).status === 400);

  // sanity: both servers share the same tool manifest, so the app can rely on it
  const manifest = JSON.parse(readFileSync(join(root, 'bridge', 'tools.json'), 'utf8'));
  check('the manifest and the server agree on the tool count', manifest.tools.length === dryTools.body.tools.length);
} catch (err) {
  check('bridge test completed without a crash', false, String(err && err.stack || err).slice(0, 400));
} finally {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  await new Promise((r) => setTimeout(r, 200));
  rmSync(fake, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall bridge checks passed');
process.exit(failed ? 1 : 0);
