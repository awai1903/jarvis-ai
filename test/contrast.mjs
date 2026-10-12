// WCAG contrast audit for the app's real foreground/background pairings.
// Pairs are listed explicitly because the colours live in CSS variables and
// inline styles that no generic class scanner can resolve correctly.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function hex(c) {
  const h = c.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
const lin = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (c) => {
  const [r, g, b] = hex(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

// Surfaces
const BG = '#0a0c14';
const SURF = '#151927';
const SURF2 = '#1f2538';
const ACCENT = '#4f8cff';

// [label, foreground, background, minimum required]
const PAIRS = [
  ['body text (--fg) on page', '#eef1fa', BG, 4.5],
  ['body text (--fg) on card', '#eef1fa', SURF, 4.5],
  ['muted text (--dim) on page', '#8d96ad', BG, 4.5],
  ['muted text (--dim) on card', '#8d96ad', SURF, 4.5],
  ['muted text on input (--surf2)', '#8d96ad', SURF2, 4.5],
  ['placeholder (--dim) on input', '#8d96ad', BG, 4.5],
  ['section heading #ffb347 on card', '#ffb347', SURF, 4.5],
  ['details summary #ffd9a0 on card', '#ffd9a0', SURF, 4.5],
  ['assistant error text #ff9aa8 on page', '#ff9aa8', BG, 4.5],
  ['connection ok dot text #4ade80 on card', '#4ade80', SURF, 4.5],
  ['accent fill, old ink (--fg) [reference only]', '#eef1fa', ACCENT, null],
  ['accent fill, new ink #08121f on accent', '#08121f', ACCENT, 4.5],
  ['wave button ink #08121f on #10b8a0', '#08121f', '#10b8a0', 4.5],
  // user chat bubble: white on a blue->violet gradient (every user message)
  ['user bubble text on gradient start', '#ffffff', '#2b57d6', 4.5],
  ['user bubble text on gradient end', '#ffffff', '#6540e0', 4.5],
  ['voice-mode close button on #d92b4a', '#ffffff', '#d92b4a', 4.5],
  // device control UI
  ['device action line #cfd6ea on page', '#cfd6ea', BG, 4.5],
  ['device action line #cfd6ea on card', '#cfd6ea', SURF, 4.5],
  ['confirm dialog body #cfd6ea on #12151f', '#cfd6ea', '#12151f', 4.5],
  ['confirm dialog title #ffffff on #12151f', '#ffffff', '#12151f', 4.5],
  ['confirm button ink #08121f on accent', '#08121f', ACCENT, 4.5],
  ['bridge status text (--dim) on card', '#8d96ad', SURF, 4.5],
  ['tool group heading #ffb347 on card', '#ffb347', SURF, 4.5],
];

let failed = 0;
console.log('pair                                        ratio   need  verdict');
for (const [label, fg, bg, need] of PAIRS) {
  const r = ratio(fg, bg);
  if (need === null) {
    // documents a pairing that was fixed, without failing the build
    console.log(`${label.padEnd(42)} ${r.toFixed(2).padStart(6)}   n/a  INFO  (was below AA before the fix)`);
    continue;
  }
  const ok = r >= need;
  if (!ok) failed++;
  console.log(`${label.padEnd(42)} ${r.toFixed(2).padStart(6)}  ${String(need).padStart(4)}  ${ok ? 'PASS' : 'FAIL'}`);
}

// Sanity: the colours we audited must still be the ones in the file, otherwise
// this test silently drifts away from reality.
const AUDITED = ['#0a0c14', '#151927', '#1f2538', '#4f8cff', '#8d96ad', '#eef1fa', '#10b8a0', '#2b57d6', '#6540e0', '#d92b4a', '#cfd6ea', '#12151f'];
const present = AUDITED.filter((c) => html.includes(c));
if (present.length !== AUDITED.length) {
  console.log(`\nWARN: audited palette not fully present in index.html (found ${present.length}/${AUDITED.length}) — update the pair table.`);
  failed++;
}

console.log('');
if (failed) {
  console.log(`${failed} contrast pair(s) below target.`);
  process.exit(1);
}
console.log('all text pairings meet WCAG AA (4.5:1)');
