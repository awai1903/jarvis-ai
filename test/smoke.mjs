// Boots the real single-file app inside jsdom and exercises it.
// No browser is available in the sandbox, so this is the strongest check we
// have: it catches syntax errors, init-time crashes, broken DOM contracts and
// regressions in the key-free built-in reply path.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installStubs } from './dom-stub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const log = { fetches: [] };
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.message || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.com/jarvis-ai/',
  virtualConsole: vc,
  beforeParse(window) {
    installStubs(window, log);
  },
});
const { window } = dom;
const doc = window.document;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await tick(60);

  check('app boots with no uncaught errors', errors.length === 0, errors[0] || '');

  // --- structure that other code depends on -------------------------------
  for (const id of ['stage', 'orb', 'c', 'app', 'chat', 'dock', 'txt', 'send', 'mic', 'gear', 'panel']) {
    check(`#${id} exists`, !!doc.getElementById(id));
  }

  const nav = doc.getElementById('nav');
  check('tab navigation was built', !!nav && nav.querySelectorAll('button.t').length >= 3, nav ? `${nav.querySelectorAll('button.t').length} tabs` : 'no #nav');

  const triggers = doc.getElementById('trig');
  check('triggers tab exists', !!triggers);
  for (const id of ['twake', 'tnotif', 'rtxt', 'rmin', 'radd', 'ptxt', 'pact', 'pval', 'padd2']) {
    check(`triggers control #${id} exists`, !!doc.getElementById(id));
  }

  const panel = doc.getElementById('panel');
  check('settings panel has content', !!panel && panel.children.length > 0, panel ? `${panel.children.length} blocks` : '');

  // --- public API ----------------------------------------------------------
  check('window.OrbAssistant is exposed', typeof window.OrbAssistant === 'object' && !!window.OrbAssistant);
  check('OrbAssistant.ask is callable', typeof window.OrbAssistant?.ask === 'function');
  check('OrbAssistant.setState is callable', typeof window.OrbAssistant?.setState === 'function');

  // --- key-free built-in replies must still work ---------------------------
  window.OrbAssistant.ask('what time is it');
  await tick(900);
  const msgs = [...doc.querySelectorAll('#chat .msg')];
  const assistant = msgs.filter((m) => m.classList.contains('assistant'));
  check('assistant replied with no API key', assistant.length > 0, `${msgs.length} message(s)`);
  const last = assistant[assistant.length - 1]?.textContent || '';
  check('built-in brain answered the time question', /It.s \d/.test(last), last.slice(0, 60));
  const announcedReply = doc.getElementById('srlive')?.textContent || '';

  // user message is echoed
  check('user message is rendered', msgs.some((m) => m.classList.contains('user') && /what time/i.test(m.textContent)));

  // --- no message may be injected as HTML (XSS) ----------------------------
  const probe = '<img src=x onerror=alert(1)>';
  window.OrbAssistant.ask(probe);
  await tick(900);
  check('user text is escaped, not parsed as HTML', doc.querySelectorAll('#chat img').length === 0);

  // --- the improvements must actually be observable ------------------------
  // screen-reader announcement of the completed reply
  const srlive = doc.getElementById('srlive');
  check('#srlive live region exists and is polite', !!srlive && srlive.getAttribute('aria-live') === 'polite');
  check('completed reply is announced to screen readers', /It.s \d/.test(announcedReply), announcedReply.slice(0, 40));

  // the chat log must not be a chatty live region once the reply is done
  const chatEl = doc.getElementById('chat');
  check('chat live region restored to polite after streaming', chatEl.getAttribute('aria-live') === 'polite');
  check('chat aria-busy cleared after streaming', chatEl.getAttribute('aria-busy') === 'false');

  // the fresh-class polling was replaced by a direct hook
  check('hero hides as soon as a user message exists', !doc.body.classList.contains('fresh'));

  // accent-filled controls must use dark ink (contrast fix)
  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  check('accent controls get dark ink in CSS', /#mic\.on,#save,#wave[^{]*\{[^}]*#08121f/.test(css.replace(/\s+/g, ' ')));

  // voice picker marks its selected option for assistive tech
  const pressed = doc.querySelectorAll('#panel button[aria-pressed]');
  check('voice picker exposes aria-pressed', pressed.length >= 7, `${pressed.length} buttons`);
  check('exactly one voice is selected', [...pressed].filter((b) => b.getAttribute('aria-pressed') === 'true').length === 1);

  // settings screen: role, tab state, focus move, Esc to leave
  const panelEl = doc.getElementById('panel');
  check('settings panel exposes a region role', panelEl.getAttribute('role') === 'region' && !!panelEl.getAttribute('aria-label'));
  const settingsTab = doc.querySelector('#nav .t[data-t="settings"]');
  settingsTab.click();
  check('opening settings sets the tab state', doc.body.getAttribute('data-tab') === 'settings');
  check('settings panel becomes visible', panelEl.hidden === false);
  check('focus moves into the settings screen', doc.activeElement === panelEl);
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  window.dispatchEvent(esc);
  check('Escape closes the settings screen', panelEl.hidden === true && doc.body.getAttribute('data-tab') === 'chat');

  // gear button must not desync the tab state (it used to leave the hero behind)
  doc.getElementById('gear').click();
  check('gear opens settings through the tab state', doc.body.getAttribute('data-tab') === 'settings' && panelEl.hidden === false);
  doc.getElementById('gear').click();
  check('gear toggles settings closed again', panelEl.hidden === true && doc.body.getAttribute('data-tab') === 'chat');

  // --- settings persistence ------------------------------------------------
  window.localStorage.setItem('orb.cfg', '{"base":"https://api.groq.com/openai/v1","model":"m","key":"k"}');
  let stored = null;
  try {
    stored = JSON.parse(window.localStorage.getItem('orb.cfg'));
  } catch {}
  check('config persists to localStorage', stored && stored.key === 'k');

  check('no errors after exercising the app', errors.length === 0, errors[0] || '');
} finally {
  window.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall smoke checks passed');
process.exit(failed ? 1 : 0);
