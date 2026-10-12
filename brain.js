/* Jarvis brain — the part that lets the assistant DO things instead of only talk.
 *
 * It speaks the OpenAI chat-completions dialect (Groq, Gemini's OpenAI
 * endpoint, OpenAI, OpenRouter, xAI, llama.cpp, Ollama...), so it works with
 * whatever key the user already has. No dependencies, no build step: load it
 * with a plain <script> in the browser, or require()/import it in Node for
 * tests.
 *
 * Pipeline:
 *   ask -> runAgent -> callModel (streamChat) -> model asks for a tool
 *                                                   |
 *                             execTool (phone bridge) + feed the result back
 *                                                   |
 *              loop until the model answers with plain text -> speak it
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JarvisBrain = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_STEPS = 6;          // tool round-trips before Jarvis must answer
  var MAX_TOOL_RESULT = 4000; // characters of tool output fed back to the model

  /* ------------------------------------------------------------ tool calls */

  // Streaming providers send tool calls in pieces: the name may arrive in one
  // delta and the JSON arguments across many. This collects and joins them.
  function ToolCallAssembler() {
    this.order = [];
    this.byIndex = {};
  }
  ToolCallAssembler.prototype.add = function (deltas) {
    if (!deltas) return;
    var list = Array.isArray(deltas) ? deltas : [deltas];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d) continue;
      var idx = d.index == null ? this.order.length : d.index;
      var slot = this.byIndex[idx];
      if (!slot) {
        slot = this.byIndex[idx] = { index: idx, id: '', name: '', arguments: '' };
        this.order.push(slot);
      }
      if (d.id) slot.id = d.id;
      var fn = d.function || {};
      if (fn.name) slot.name += fn.name;
      if (fn.arguments) slot.arguments += fn.arguments;
    }
  };
  ToolCallAssembler.prototype.take = function () {
    var out = [];
    for (var i = 0; i < this.order.length; i++) {
      var slot = this.order[i];
      if (!slot.name) continue;                 // a delta with no name yet is noise
      var parsed = parseArgs(slot.arguments);
      out.push({
        id: slot.id || 'call_' + (i + 1),
        name: slot.name,
        argumentsJson: slot.arguments || '{}',
        args: parsed.args,
        argsError: parsed.error
      });
    }
    return out;
  };

  // Models occasionally emit sloppy JSON; recover instead of failing the turn.
  function parseArgs(raw) {
    var text = typeof raw === 'string' ? raw.trim() : raw;
    if (!text) return { args: {}, error: '' };
    if (typeof text === 'object') return { args: text, error: '' };
    try {
      var value = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { args: {}, error: 'arguments must be a JSON object' };
      }
      return { args: value, error: '' };
    } catch (e) {
      var start = text.indexOf('{');
      var end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          var fixed = JSON.parse(text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
          if (fixed && typeof fixed === 'object') return { args: fixed, error: '' };
        } catch (e2) { /* fall through */ }
      }
      return { args: {}, error: 'could not read the arguments the model produced' };
    }
  }

  function serializeToolCall(call) {
    return {
      id: call.id || 'call_x',
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson || JSON.stringify(call.args || {}) }
    };
  }

  /* ----------------------------------------------------------- transport */

  // Streams one completion. Returns { text, toolCalls, finish }.
  // onDelta(chunk) is called with each text fragment so the UI can show it live.
  async function streamChat(opts) {
    var base = String(opts.base || '').replace(/\/+$/, '');
    var url = base + '/chat/completions';
    var body = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      temperature: opts.temperature == null ? 0.6 : opts.temperature,
      max_tokens: opts.maxTokens || 500
    };
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    var res;
    try {
      res = await (opts.fetchImpl || fetch)(url, {
        method: 'POST',
        signal: opts.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.key },
        body: JSON.stringify(body)
      });
    } catch (e) {
      var netErr = new Error('could not reach the API');
      netErr.network = true;
      throw netErr;
    }
    if (!res.ok) {
      var detail = '';
      try {
        var payload = await res.json();
        detail = String((payload.error && payload.error.message) || payload.error || payload.message || '');
      } catch (e) {
        try { detail = String(await res.text()); } catch (e2) { detail = ''; }
      }
      detail = detail.slice(0, 200);
      var err = new Error(detail || ('HTTP ' + res.status));
      err.status = res.status;
      err.needsToolFallback = !!(opts.tools && opts.tools.length) && res.status === 400 &&
        /tool|function[_ ]?call/i.test(detail);
      throw err;
    }

    var asm = new ToolCallAssembler();
    var text = '';
    var finish = '';

    // Some gateways ignore stream:true and answer with one JSON object.
    var ctype = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
    if (!res.body || /application\/json/.test(ctype)) {
      var whole = await res.json();
      var choice = ((whole.choices || [])[0] || {});
      var message = choice.message || {};
      text = message.content || '';
      if (message.tool_calls) asm.add(message.tool_calls);
      if (text && opts.onDelta) opts.onDelta(text);
      return { text: text, toolCalls: asm.take(), finish: choice.finish_reason || '' };
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        var parsed;
        try { parsed = JSON.parse(data); } catch (e) { continue; }
        var ch = (parsed.choices || [])[0];
        if (!ch) continue;
        var delta = ch.delta || {};
        if (ch.finish_reason) finish = ch.finish_reason;
        if (delta.content) {
          text += delta.content;
          if (opts.onDelta) opts.onDelta(delta.content);
        }
        if (delta.tool_calls) asm.add(delta.tool_calls);
      }
    }
    return { text: text, toolCalls: asm.take(), finish: finish };
  }

  /* ---------------------------------------------------------- agent loop */

  // Runs until the model answers with text (or the step budget is spent).
  // Everything that touches the outside world is injected, so this is pure
  // enough to unit-test: callModel(messages, tools, ctx), execTool(name, args).
  async function runAgent(opts) {
    var messages = opts.messages.slice();
    var tools = opts.tools && opts.tools.length ? opts.tools : null;
    var maxSteps = opts.maxSteps || MAX_STEPS;
    var trace = [];
    var step = 0;

    while (step < maxSteps) {
      step++;
      var reply;
      try {
        reply = await opts.callModel(messages, tools, { step: step, onDelta: opts.onDelta });
      } catch (err) {
        if (err && err.needsToolFallback && tools) {
          tools = null;                          // model has no tool support: chat anyway
          step--;                                // this attempt does not count
          if (opts.onNotice) opts.onNotice('This model cannot run tools, so Jarvis will only answer with words.');
          continue;
        }
        throw err;
      }
      if (!reply) throw new Error('the model returned nothing');
      var calls = reply.toolCalls || [];
      if (!calls.length) {
        return { text: String(reply.text || '').trim(), steps: step, trace: trace, toolsDisabled: !tools };
      }

      messages.push({
        role: 'assistant',
        content: reply.text || '',
        tool_calls: calls.map(serializeToolCall)
      });

      for (var i = 0; i < calls.length; i++) {
        var call = calls[i];
        var entry = { name: call.name, args: call.args || {}, ok: true, output: '' };
        if (call.argsError) {
          entry.ok = false;
          entry.output = call.argsError;
        } else {
          try {
            var result = await opts.execTool(call.name, call.args || {});
            if (typeof result === 'string') result = { ok: true, output: result };
            result = result || {};
            entry.ok = result.ok !== false;
            entry.output = String(result.output != null ? result.output : (result.error || ''));
          } catch (err) {
            entry.ok = false;
            entry.output = String((err && err.message) || err || 'the action failed');
          }
        }
        entry.output = entry.output.slice(0, MAX_TOOL_RESULT);
        trace.push(entry);
        if (opts.onTool) opts.onTool(entry);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: entry.output || (entry.ok ? 'done' : 'the action failed')
        });
      }

      if (step >= maxSteps) {
        // Budget spent: force a plain answer so the user is never left hanging.
        var wrapUp = messages.concat([{
          role: 'user',
          content: 'Stop calling tools. Answer now in one or two short sentences using what you already have.'
        }]);
        var final;
        try {
          final = await opts.callModel(wrapUp, null, { step: step + 1, onDelta: opts.onDelta });
        } catch (err) {
          final = { text: summarize(trace), toolCalls: [] };
        }
        return {
          text: String((final && final.text) || summarize(trace)).trim(),
          steps: step, trace: trace, hitStepLimit: true, toolsDisabled: true
        };
      }
    }
    return { text: summarize(trace), steps: step, trace: trace, hitStepLimit: true };
  }

  function summarize(trace) {
    if (!trace.length) return 'I could not finish that.';
    var last = trace[trace.length - 1];
    return last.ok ? ('The action finished: ' + last.output.slice(0, 200)) : ('I could not do that: ' + last.output.slice(0, 200));
  }

  /* -------------------------------------------------------------- prompt */

  function buildSystemPrompt(opts) {
    var base = opts.base || '';
    var names = opts.tools || [];
    var lines = [base];
    if (names.length) {
      lines.push(
        '',
        'You can act on the user\'s phone with tools: ' + names.join(', ') + '.',
        'When the user asks for something a tool can do, call the tool instead of guessing or telling them to do it themselves.',
        'Use exact values you were given (names, numbers) and never invent a phone number, package name or file path.',
        'If a tool fails, say what failed in one sentence; do not repeat the same call more than twice.',
        'Anything that sends a message, places a call or runs a command is confirmed by the user first, so just call it.',
        'After a tool returns, reply with a short spoken sentence, not the raw output, and never read JSON aloud.'
      );
    } else {
      lines.push('', 'You have no device tools right now, so answer with words only.');
    }
    if (opts.facts) lines.push('', 'Things to remember about the user:', opts.facts);
    lines.push('', 'Today is ' + new Date().toDateString() + '.');
    return lines.join('\n');
  }

  /* ----------------------------------------------------------- UI helper */

  // One short line per action, e.g. "Torch · on — done".
  function describeAction(entry, titles) {
    var title = (titles && titles[entry.name]) || entry.name.replace(/_/g, ' ');
    var hint = '';
    var args = entry.args || {};
    var keys = Object.keys(args);
    if (keys.length) {
      var value = args[keys[0]];
      if (typeof value === 'string' && value.length > 28) value = value.slice(0, 27) + '\u2026';
      hint = String(value);
    }
    var status = entry.ok ? 'done' : 'failed';
    return title + (hint ? ' \u00b7 ' + hint : '') + ' \u2014 ' + status;
  }

  return {
    MAX_STEPS: MAX_STEPS,
    MAX_TOOL_RESULT: MAX_TOOL_RESULT,
    ToolCallAssembler: ToolCallAssembler,
    parseArgs: parseArgs,
    serializeToolCall: serializeToolCall,
    streamChat: streamChat,
    runAgent: runAgent,
    buildSystemPrompt: buildSystemPrompt,
    describeAction: describeAction
  };
});
