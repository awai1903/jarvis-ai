// End-to-end check of phone control without a phone and without a network.
//
// The real app is booted in jsdom; fetch is replaced by two fakes — an
// OpenAI-compatible model that asks for a tool, and the bridge (serving the
// real bridge/tools.json). Everything the user would touch is then driven
// through the DOM: connect, tick the switches, ask a question, click the
// confirmation dialog.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { installStubs } from './dom-stub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'bridge', 'tools.json'), 'utf8'));
const brainSource = readFileSync(join(root, 'brain.js'));

// jsdom does not load external <script src> unless asked to, and the app really
// does fetch brain.js over the network. Serve it from disk so the tag in
// index.html is exercised the same way a browser would.
class LocalScripts extends ResourceLoader {
  fetch(url, options) {
    if (url.endsWith('brain.js')) return Promise.resolve(brainSource);
    return super.fetch(url, options);
  }
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// the bridge's /api/tools transform, so the app sees exactly what it would on a phone
const bridgeTools = manifest.tools.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries((t.args || []).map((a) => [a.name, {
        type: a.type, description: a.description,
        ...(a.enum ? { enum: a.enum } : {}), ...(a.default !== undefined ? { default: a.default } : {}),
      }])),
      required: (t.args || []).filter((a) => a.required).map((a) => a.name),
    },
  },
  title: t.title, group: t.group,
  danger: !!t.danger, defaultOff: !!t.defaultOff,
  available: true, unavailableReason: '',
}));

const sse = (lines) => {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const delta = (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
const toolSSE = (name, args, id = 'call_1') => sse([
  delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
  'data: [DONE]\n\n',
]);
const textSSE = (text) => sse(text.split(' ').map((w, i) => delta({ content: (i ? ' ' : '') + w }))
  .concat([`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']));

// Boots the app with a scripted model and a scripted bridge.
async function boot({ cfg, model, bridgeToken, demo }) {
  const realToken = bridgeToken || cfg.dev.token;
  const calls = { model: [], exec: [] };
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.message || e.message)));
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: new LocalScripts(),
    pretendToBeVisual: true,
    url: 'https://example.com/jarvis-ai/',
    virtualConsole: vc,
    beforeParse(window) {
      installStubs(window, { fetches: [] });
      window.TextDecoder = TextDecoder;
      window.localStorage.setItem('orb.cfg', JSON.stringify(cfg));
      window.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.endsWith('/chat/completions')) {
          const body = JSON.parse(init.body);
          calls.model.push(body);
          return (await model(body));
        }
        if (target.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true, name: 'jarvis-bridge', tools: 28, android: true, tokenRequired: !demo }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (target.endsWith('/api/tools')) {
          const ok = demo || (init.headers && init.headers['X-Jarvis-Token'] === realToken);
          return new Response(JSON.stringify(ok ? { ok: true, tools: bridgeTools } : { ok: false, error: 'bad or missing token' }),
            { status: ok ? 200 : 401, headers: { 'content-type': 'application/json' } });
        }
        if (target.endsWith('/api/exec')) {
          const body = JSON.parse(init.body);
          calls.exec.push(body);
          const scripted = (cfg.dev && cfg.dev.reply) || cfg.reply || {};
          const reply = scripted[body.name];
          return new Response(JSON.stringify(reply || { ok: true, name: body.name, output: 'done' }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      };
    },
  });
  await tick(60);
  return { window: dom.window, doc: dom.window.document, calls, errors };
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await tick(25);
  }
  return null;
};

const baseCfg = (dev) => ({
  base: 'https://api.example.com/v1', model: 'test-model', key: 'test-key',
  dev: Object.assign({ url: 'http://127.0.0.1:8787', token: 'tok', on: true, confirm: false, off: {} }, dev),
});

/* ============================ scenario A: Jarvis turns the torch on ===== */
{
  const app = await boot({
    cfg: baseCfg({ reply: { torch: { ok: true, name: 'torch', output: '{"state":"on"}' } } }),
    model: async (body) => (body.messages.some((m) => m.role === 'tool')
      ? textSSE('The flashlight is on.')
      : toolSSE('torch', { state: 'on' })),
  });
  const { window, doc, calls, errors } = app;

  check('the brain script is loaded in the page', typeof window.JarvisBrain === 'object');
  check('the device hook is exposed', !!window.JarvisDevice);
  check('the app still boots with no errors', errors.length === 0, errors[0] || '');

  const panel = doc.getElementById('panel');
  check('Settings has a Device card', !!doc.getElementById('devcard'));
  check('the Device card is inside the settings panel', doc.getElementById('devcard').closest('#panel') === panel);
  check('the master switch reflects the saved config', doc.getElementById('don').checked === true);
  check('the bridge address is prefilled', doc.getElementById('durl').value === 'http://127.0.0.1:8787');

  doc.getElementById('dconn').click();
  const connected = await waitFor(() => window.JarvisDevice.status().online);
  check('connecting loads the tool list from the bridge', connected === true);
  check('all 28 bridge tools are known to the app', window.JarvisDevice.status().tools === 28, String(window.JarvisDevice.status().tools));
  check('the status line reports the connection', /Connected · 28 of 28/.test(doc.getElementById('dstat').textContent), doc.getElementById('dstat').textContent);
  check('every tool group is rendered', ['Device', 'Messages', 'Media and apps', 'Files', 'Memory', 'Power']
    .every((g) => [...doc.querySelectorAll('#dlist .dgh')].some((h) => h.textContent === g)));
  check('each tool got a checkbox', doc.querySelectorAll('#dlist .drow input').length === 28);
  check('the shell tool is off by default', doc.querySelector('#dlist input[aria-label="Run a shell command"]').checked === false);
  check('a dangerous tool is on but marked as confirmed first', (() => {
    const box = doc.querySelector('#dlist input[aria-label="Send SMS"]');
    return box.checked === true && /confirmed first/.test(doc.querySelector('#dlist input[aria-label="Send SMS"]').closest('.drow').textContent);
  })());

  window.OrbAssistant.ask('turn on the torch please');
  const answer = await waitFor(() => [...doc.querySelectorAll('#chat .msg.assistant')].map((m) => m.textContent).find((t) => /flashlight is on/i.test(t)));
  check('the final answer is shown in the chat', !!answer, answer || '');

  const first = calls.model[0];
  check('the model call advertised the phone tools', Array.isArray(first.tools) && first.tools.length > 10, `${first.tools ? first.tools.length : 0} tools`);
  check('the shell tool is not advertised while it is off', !first.tools.some((t) => t.function.name === 'run_command'));
  check('the system prompt tells the model to act', /act on the user's phone with tools/.test(first.messages[0].content));
  check('the system prompt lists the enabled actions', /torch/.test(first.messages[0].content));

  const torchCalls = calls.exec.filter((c) => c.name === 'torch');
  check('the phone bridge received exactly the action the model asked for',
    torchCalls.length === 1 && torchCalls[0].arguments.state === 'on', JSON.stringify(calls.exec));
  check('connecting also loads the phone-side memories', calls.exec.some((c) => c.name === 'note_list'));
  check('the tool result was sent back to the model', (() => {
    const second = calls.model[1];
    const tool = second && second.messages.filter((m) => m.role === 'tool');
    return tool && tool.length === 1 && tool[0].name === 'torch' && /"state":"on"/.test(tool[0].content);
  })());
  check('the tool round trip costs exactly one extra model call', calls.model.length === 2, `${calls.model.length} calls`);
  check('the second call still carries the phone tools', Array.isArray(calls.model[1].tools) && calls.model[1].tools.length === 27);
  const note = doc.querySelector('#chat .tnote');
  check('an action line is added to the chat', !!note && /Flashlight · on — done/.test(note.textContent), note ? note.textContent : 'none');
  check('the action line is kept out of the assistant message', [...doc.querySelectorAll('#chat .msg.assistant')].every((m) => !/Flashlight/.test(m.textContent)));
  check('exactly one action line was added for one action', doc.querySelectorAll('#chat .tnote').length === 1);
  check('the final answer text is exactly what the model said', [...doc.querySelectorAll('#chat .msg.assistant')].some((m) => m.textContent === 'The flashlight is on.'));
  check('the turn was added to the conversation history', window.hist.some((m) => m.role === 'assistant' && /flashlight is on/i.test(m.content)));
  check('the question was added to the conversation history', window.hist.some((m) => m.role === 'user' && /torch/i.test(m.content)));
  check('Settings persisted the device config', JSON.parse(window.localStorage.getItem('orb.cfg')).dev.on === true);
  check('no errors during the whole turn', errors.length === 0, errors[0] || '');
  await tick(120);
  window.close();
}

/* ================== scenario B: a dangerous action needs a confirmation === */
{
  const app = await boot({
    cfg: baseCfg({ confirm: true }),
    model: async (body) => {
      const tools = body.messages.filter((m) => m.role === 'tool');
      if (!tools.length) return toolSSE('send_sms', { number: '03001234567', message: 'On my way' });
      return /refused/i.test(tools[0].content) ? textSSE('Okay, I did not send it.') : textSSE('Sent.');
    },
  });
  const { window, doc, calls, errors } = app;
  doc.getElementById('dconn').click();
  await waitFor(() => window.JarvisDevice.status().online);

  window.OrbAssistant.ask('text Ali that I am on my way');
  const dialog = await waitFor(() => doc.querySelector('.cback'));
  check('a confirmation dialog appears before sending an SMS', !!dialog);
  check('the dialog names the action', /Send SMS/.test(dialog.textContent), dialog.textContent.slice(0, 60));
  check('the dialog shows what will be sent', /03001234567/.test(dialog.textContent) && /On my way/.test(dialog.textContent));
  check('the dialog is a modal dialog for assistive tech', dialog.querySelector('[role="dialog"]') && dialog.querySelector('.cbox').getAttribute('aria-modal') === 'true');
  check('focus moves to the confirm button', doc.activeElement === dialog.querySelector('.crow .yes'));

  dialog.querySelector('.crow .no').click();
  await tick(30);
  check('cancelling closes the dialog', !doc.querySelector('.cback'));
  check('a refused action never reaches the phone', calls.exec.filter((c) => c.name === 'send_sms').length === 0, JSON.stringify(calls.exec));

  const refused = await waitFor(() => (calls.model[1] || []).length !== 0) || calls.model[1];
  const toolMsg = calls.model[1].messages.find((m) => m.role === 'tool');
  check('the refusal is reported back to the model', /refused/i.test(toolMsg.content), toolMsg.content);
  const answer = await waitFor(() => [...doc.querySelectorAll('#chat .msg.assistant')].map((m) => m.textContent).find((t) => /did not send/i.test(t)));
  check('Jarvis tells the user nothing was sent', !!answer, answer || '');

  // second turn: same action, but confirmed
  window.OrbAssistant.ask('go on then, send it');
  const dialog2 = await waitFor(() => doc.querySelector('.cback'));
  check('the dialog appears again on the next attempt', !!dialog2);
  dialog2.querySelector('.crow .yes').click();
  const sent = await waitFor(() => calls.exec.find((c) => c.name === 'send_sms'));
  check('confirming actually runs the action', !!sent, JSON.stringify(calls.exec));
  check('the message text is passed through unchanged', sent && sent.arguments.message === 'On my way');
  check('the number is passed through unchanged', sent && sent.arguments.number === '03001234567');
  const sentText = await waitFor(() => [...doc.querySelectorAll('#chat .msg.assistant')].map((m) => m.textContent).find((t) => t.trim() === 'Sent.'));
  check('Jarvis reports that it was sent', !!sentText, sentText || '');
  check('no errors in the confirmation flow', errors.length === 0, errors[0] || '');
  await tick(120);          // let the turn settle before tearing the page down
  window.close();
}

/* ============ scenario C: a broken bridge degrades to plain chat ========= */
{
  const app = await boot({
    cfg: baseCfg({ token: 'wrong-token' }),
    bridgeToken: 'the-real-token',
    model: async () => textSSE('I can still talk without the phone.'),
  });
  const { window, doc, errors } = app;
  doc.getElementById('dconn').click();
  await tick(120);
  check('a rejected token is reported to the user', /Token rejected/.test(doc.getElementById('dstat').textContent), doc.getElementById('dstat').textContent);
  check('the app is not connected after a failed connect', window.JarvisDevice.status().online === false);

  window.OrbAssistant.ask('turn on the torch');
  const answer = await waitFor(() => [...doc.querySelectorAll('#chat .msg.assistant')].map((m) => m.textContent).find((t) => /still talk/.test(t)));
  check('with no bridge, Jarvis answers with words only', !!answer, answer || '');
  check('no tool calls were attempted', doc.querySelectorAll('#chat .tnote').length === 0);
  check('no errors while offline from the bridge', errors.length === 0, errors[0] || '');
  await tick(120);
  window.close();
}

/* ====== scenario D: a token-less demo bridge still drives the phone layer == */
{
  const app = await boot({
    cfg: baseCfg({ token: '' }),
    demo: true,
    model: async () => textSSE('unused'),
  });
  const { window, doc, calls, errors } = app;
  doc.getElementById('dconn').click();
  await waitFor(() => window.JarvisDevice.status().online);
  check('a demo bridge connects without a token', window.JarvisDevice.status().online === true);
  check('the app knows the bridge wants no token', window.JarvisDevice.status().tokenRequired === false);
  check('the status line mentions demo mode', /demo mode/.test(doc.getElementById('dstat').textContent), doc.getElementById('dstat').textContent);
  const out = await window.JarvisDevice.send('torch', { state: 'on' });
  check('an action runs with no token saved', out.ok === true && /done/.test(out.output), JSON.stringify(out));
  check('the action still went through the bridge', calls.exec.some((c) => c.name === 'torch'));
  check('no errors in demo mode', errors.length === 0, errors[0] || '');
  await tick(80);
  window.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall device checks passed');
process.exit(failed ? 1 : 0);
