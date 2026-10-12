// Tests the agent loop in brain.js: streaming assembly, tool round-trips,
// error feedback, the step budget and the fallback for models without tools.
// No network: the model is a fake fetch, the tools are a fake executor.
import brain from '../brain.js';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

/* ------------------------------------------------------- streamed tool calls */
const asm = new brain.ToolCallAssembler();
asm.add([{ index: 0, id: 'call_1', function: { name: 'tor', arguments: '' } }]);
asm.add([{ index: 0, function: { name: 'ch', arguments: '{"sta' } }]);
asm.add([{ index: 0, function: { arguments: 'te":"on"}' } }]);
const calls = asm.take();
check('streamed tool call fragments are joined', calls.length === 1 && calls[0].name === 'torch');
check('streamed arguments are parsed', calls[0].args.state === 'on', JSON.stringify(calls[0].args));
check('tool call keeps its provider id', calls[0].id === 'call_1');
check('a delta with no name is ignored', new brain.ToolCallAssembler().add([{ index: 0, arguments: '{}' }]) === undefined);

const asm2 = new brain.ToolCallAssembler();
asm2.add([{ index: 0, function: { name: 'a', arguments: '{}' } }, { index: 1, function: { name: 'b', arguments: '{}' } }]);
check('parallel tool calls keep their order', asm2.take().map((c) => c.name).join(',') === 'a,b');

/* ------------------------------------------------------------- parseArgs */
check('valid JSON args parse', brain.parseArgs('{"level":5}').args.level === 5);
check('trailing comma is repaired', brain.parseArgs('{"a":1,}').args.a === 1);
check('prose around the JSON is ignored', brain.parseArgs('here: {"n":"1"} ok').args.n === '1');
check('broken JSON reports an error', !!brain.parseArgs('{oops').error);
check('empty args are allowed', Object.keys(brain.parseArgs('').args).length === 0);

/* ------------------------------------------------------------- streamChat */
function sse(parts) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const sseBody = (deltas) => deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';

let sentBody = null;
const goodFetch = async (url, init) => {
  sentBody = JSON.parse(init.body);
  // one valid SSE payload, then cut it at arbitrary byte offsets: the reader
  // must reassemble lines and JSON that arrive split across chunks.
  const full = sseBody([
    { choices: [{ delta: { content: 'Tur' } }] },
    { choices: [{ delta: { content: 'ning the ' } }] },
    { choices: [{ delta: { content: 'torch on.' }, finish_reason: 'stop' }] },
  ]);
  return sse([full.slice(0, 23), full.slice(23, 97), full.slice(97)]);
};
const pieces = [];
const r1 = await brain.streamChat({
  base: 'https://api.example.com/v1',
  key: 'k',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'torch' } }],
  fetchImpl: goodFetch,
  onDelta: (t) => pieces.push(t),
});
check('streaming text is assembled across chunk boundaries', r1.text === 'Turning the torch on.', JSON.stringify(r1.text));
check('onDelta receives every fragment', pieces.join('') === 'Turning the torch on.');
check('tools are sent as OpenAI tool schemas', Array.isArray(sentBody.tools) && sentBody.tool_choice === 'auto');
check('the request is a streamed chat completion', sentBody.stream === true && sentBody.messages.length === 1);

const toolFetch = async () => sse([sseBody([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'send_sms', arguments: '{"numb' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'er":"123","message":"hi"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
])]);
const r2 = await brain.streamChat({ base: 'https://x/v1', key: 'k', model: 'm', messages: [], fetchImpl: toolFetch });
check('streamed tool_calls survive chunk splits', r2.toolCalls.length === 1 && r2.toolCalls[0].name === 'send_sms');
check('streamed tool arguments are parsed', r2.toolCalls[0].args.number === '123');
check('finish_reason is reported', r2.finish === 'tool_calls');

const jsonFetch = async () => new Response(
  JSON.stringify({ choices: [{ message: { content: 'hello', tool_calls: [{ id: 'z', function: { name: 'torch', arguments: '{"state":"off"}' } }] }, finish_reason: 'stop' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } }
);
const r3 = await brain.streamChat({ base: 'https://x/v1', key: 'k', model: 'm', messages: [], fetchImpl: jsonFetch });
check('a non-streaming JSON reply still works', r3.text === 'hello' && r3.toolCalls[0].args.state === 'off');

const errFetch = async (url, init) => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
let e1 = null;
try { await brain.streamChat({ base: 'https://x/v1', key: 'k', model: 'm', messages: [], fetchImpl: errFetch }); } catch (e) { e1 = e; }
check('an API error carries its status', e1 && e1.status === 401, e1 && e1.message);

const noToolFetch = async () => new Response(JSON.stringify({ error: { message: 'model does not support tools' } }), { status: 400, headers: { 'content-type': 'application/json' } });
let e2 = null;
try { await brain.streamChat({ base: 'https://x/v1', key: 'k', model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'torch' } }], fetchImpl: noToolFetch }); } catch (e) { e2 = e; }
check('a model without tool support is flagged for fallback', e2 && e2.needsToolFallback === true);

const netFetch = async () => { throw new TypeError('Failed to fetch'); };
let e3 = null;
try { await brain.streamChat({ base: 'https://x/v1', key: 'k', model: 'm', messages: [], fetchImpl: netFetch }); } catch (e) { e3 = e; }
check('a network failure is reported as such', e3 && e3.network === true && e3.status === undefined);

/* --------------------------------------------------------------- runAgent */
const toolSchema = { type: 'function', function: { name: 'torch', parameters: { type: 'object' } } };

async function agent(model, exec, opts = {}) {
  return brain.runAgent(Object.assign({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'turn on the light' }],
    tools: [toolSchema],
    callModel: model,
    execTool: exec,
  }, opts));
}

let seenMessages = null;
let execArgs = null;
let stepCount = 0;
const happy = await agent(async (messages, tools) => {
  stepCount++;
  if (stepCount === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'torch', args: { state: 'on' }, argumentsJson: '{"state":"on"}' }] };
  seenMessages = messages;
  return { text: 'The torch is on.' };
}, async (name, args) => {
  execArgs = { name, args };
  return { ok: true, output: '{"state":"on"}' };
});
check('agent executes the tool the model asked for', execArgs && execArgs.name === 'torch' && execArgs.args.state === 'on');
check('agent returns the final spoken text', happy.text === 'The torch is on.');
check('agent stops after the model answers', happy.steps === 2);
check('the tool result is fed back as a role:tool message', (() => {
  const t = seenMessages.filter((m) => m.role === 'tool');
  return t.length === 1 && t[0].tool_call_id === 'c1' && t[0].name === 'torch' && /state/.test(t[0].content);
})(), JSON.stringify(seenMessages.map((m) => m.role)));
check('the assistant tool call is echoed back in the conversation', (() => {
  const a = seenMessages.filter((m) => m.role === 'assistant' && m.tool_calls);
  return a.length === 1 && a[0].tool_calls[0].function.name === 'torch' && a[0].tool_calls[0].function.arguments === '{"state":"on"}';
})());

let errFedBack = '';
const failing = await agent(async (messages, tools) => {
  if (messages.some((m) => m.role === 'tool')) return { text: 'Sorry, the torch is not available.' };
  return { text: '', toolCalls: [{ id: 'c1', name: 'torch', args: {} }] };
}, async () => {
  errFedBack = 'captured';
  return { ok: false, error: 'termux-api is not installed' };
});
check('a failed tool is fed back to the model', (() => {
  return failing.trace[0].ok === false && /not installed/.test(failing.trace[0].output);
})(), failing.trace[0].output);
check('the model gets to explain the failure', /not available/.test(failing.text));

const thrown = await agent(async (messages) => (messages.some((m) => m.role === 'tool') ? { text: 'ok' } : { text: '', toolCalls: [{ id: 'c', name: 'torch', args: {} }] }),
  async () => { throw new Error('bridge offline'); });
check('an exception inside a tool is caught', thrown.trace[0].ok === false && /bridge offline/.test(thrown.trace[0].output));

const badArgs = await agent(async (messages) => (messages.some((m) => m.role === 'tool') ? { text: 'let me try again' } : { text: '', toolCalls: [{ id: 'c', name: 'torch', args: {}, argsError: 'could not read the arguments' }] }),
  async () => { throw new Error('should not run'); });
check('a tool call with broken arguments never reaches the phone', badArgs.trace[0].ok === false && /could not read/.test(badArgs.trace[0].output));

let steps = 0;
let wrapUpTools = 'unset';
const bounded = await agent(async (messages, tools) => {
  steps++;
  if (tools === null) { wrapUpTools = null; return { text: 'Here is what I know so far.' }; }
  return { text: '', toolCalls: [{ id: 'c' + steps, name: 'torch', args: {} }] };
}, async () => ({ ok: true, output: 'on' }), { maxSteps: 3 });
check('the step budget is enforced', steps === 4, `${steps} model calls`);
check('after the budget the model must answer without tools', wrapUpTools === null);
check('the step limit is reported', bounded.hitStepLimit === true && bounded.text === 'Here is what I know so far.');

let notices = 0;
let retriedTools = 'unset';
const noTools = await agent(async (messages, tools) => {
  retriedTools = tools;
  if (tools) { const e = new Error('does not support tools'); e.needsToolFallback = true; throw e; }
  return { text: 'I will just answer with words.' };
}, async () => ({ ok: true, output: '' }), { onNotice: () => notices++ });
check('a tool-less model is retried without tools', noTools.toolsDisabled === true && retriedTools === null);
check('the user is told tools are unavailable', notices === 1);
check('the retry does not burn a step', noTools.steps === 1);

const longOut = await agent(async (messages) => (messages.some((m) => m.role === 'tool') ? { text: 'done' } : { text: '', toolCalls: [{ id: 'c', name: 'read_sms', args: {} }] }),
  async () => ({ ok: true, output: 'x'.repeat(12000) }));
const toolMsg = longOut.trace[0];
check('huge tool output is truncated before it reaches the model', toolMsg.output.length <= brain.MAX_TOOL_RESULT, `${toolMsg.output.length} chars`);

/* ---------------------------------------------------------------- prompt */
const p = brain.buildSystemPrompt({ base: 'BASE', tools: ['torch', 'send_sms'], facts: 'likes tea' });
check('prompt keeps the base instructions', p.startsWith('BASE'));
check('prompt lists the available tools', /torch, send_sms/.test(p));
check('prompt includes remembered facts', /likes tea/.test(p));
check('prompt refuses to invent numbers', /never invent a phone number/.test(p));
check('prompt warns about confirmation', /confirmed by the user first/.test(p));
check('prompt without tools says so', /no device tools/.test(brain.buildSystemPrompt({ base: 'B', tools: [] })));
check('prompt carries the date', /Today is \w{3} \w{3}/.test(p), p.split('\n').pop());

/* --------------------------------------------------------------- UI label */
check('action line names the tool', brain.describeAction({ name: 'torch', args: { state: 'on' }, ok: true }, { torch: 'Flashlight' }) === 'Flashlight · on — done');
check('action line marks failures', /failed$/.test(brain.describeAction({ name: 'send_sms', args: { number: '0300' }, ok: false })));
check('long arguments are shortened', brain.describeAction({ name: 'x', args: { t: 'y'.repeat(50) }, ok: true }).length < 60);

console.log(failed ? `\n${failed} check(s) failed` : '\nall brain checks passed');
process.exit(failed ? 1 : 0);
