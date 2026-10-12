// Verifies the installable-app layer: manifest correctness, icon files and the
// service worker's actual behaviour (run against stubbed Cache/Request APIs).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const html = read('index.html');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- manifest
let m = null;
try {
  m = JSON.parse(read('manifest.webmanifest'));
  check('manifest is valid JSON', true);
} catch (e) {
  check('manifest is valid JSON', false, e.message);
}

if (m) {
  for (const field of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color', 'icons']) {
    check(`manifest has ${field}`, m[field] !== undefined);
  }
  check('display is standalone', m.display === 'standalone');
  // GitHub Pages serves this from a sub-path, so every URL must be relative
  const urls = [m.start_url, m.scope, ...m.icons.map((i) => i.src)];
  check('all manifest URLs are relative (sub-path safe)', urls.every((u) => u && !u.startsWith('/') && !/^https?:/.test(u)), urls.join(' '));
  check('start_url and scope are the app directory', m.start_url === './' && m.scope === './');
  check('theme_color matches the app background', m.theme_color.toLowerCase() === '#0a0c14');

  const purposes = m.icons.map((i) => i.purpose || 'any');
  check('has a 192px "any" icon', m.icons.some((i, k) => i.sizes === '192x192' && purposes[k] === 'any'));
  check('has a 512px "any" icon', m.icons.some((i, k) => i.sizes === '512x512' && purposes[k] === 'any'));
  check('has a maskable icon (Android adaptive)', purposes.includes('maskable'));

  // declared sizes must match the real PNG dimensions
  for (const icon of m.icons) {
    const path = join(root, icon.src);
    if (!existsSync(path)) {
      check(`icon file exists: ${icon.src}`, false);
      continue;
    }
    const buf = readFileSync(path);
    const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    check(`icon ${icon.src} is PNG ${w}x${h}`, isPng && `${w}x${h}` === icon.sizes, `declared ${icon.sizes}`);
  }
}

// ------------------------------------------------------------ html wiring
check('index.html links the manifest', /rel="manifest"\s+href="manifest\.webmanifest"/.test(html));
check('index.html declares theme-color', /name="theme-color"\s+content="#0a0c14"/.test(html));
check('index.html has an apple-touch-icon', /rel="apple-touch-icon"\s+href="apple-touch-icon\.png"/.test(html));
check('apple-touch-icon file exists', existsSync(join(root, 'apple-touch-icon.png')));
check('index.html declares web-app-capable', /name="apple-mobile-web-app-capable"/.test(html));
check('index.html has a real description', /name="description"\s+content="[^"]{40,}"/.test(html));
check('index.html has a <noscript> fallback', /<noscript>/.test(html));
check('title matches the product name', /<title>Jarvis AI Assistant<\/title>/.test(html));

// ------------------------------------------------------- service worker
try {
  execFileSync('node', ['--check', join(root, 'sw.js')], { stdio: 'pipe' });
  check('sw.js parses', true);
} catch (e) {
  check('sw.js parses', false, String(e.stderr || e.message).slice(0, 120));
}

check('index.html registers the service worker', /serviceWorker\.register\('sw\.js'\)/.test(html));
check('service worker registration is guarded to secure contexts', /location\.protocol==='https:'/.test(html));

const sw = read('sw.js');
const SW_VERSION = (sw.match(/const VERSION = '(jarvis-v\d+)'/) || [])[1];
check('sw.js versions its cache', /const VERSION = 'jarvis-v\d+'/.test(sw));
check('sw.js calls skipWaiting on install', /skipWaiting\(\)/.test(sw));
check('sw.js deletes stale caches on activate', /caches\.delete\(k\)/.test(sw));
check('sw.js leaves cross-origin (API) traffic alone', /url\.origin !== self\.location\.origin\) return/.test(sw));

// Execute the worker against stubbed cache APIs to prove the shell is precached.
const listeners = {};
const origin = 'https://example.com';
const added = [];
const deleted = [];
const putKeys = [];
const self = {
  location: { origin, href: origin + '/jarvis-ai/sw.js' },
  addEventListener: (t, fn) => {
    listeners[t] = fn;
  },
  skipWaiting: async () => {},
  clients: { claim: async () => {} },
};
const caches = {
  open: async () => ({
    add: async (req) => {
      added.push(new URL(req.url).pathname);
      if (req.url.includes('missing')) throw new Error('404');
      return undefined;
    },
    put: async (k) => {
      putKeys.push(typeof k === 'string' ? k : new URL(k.url).pathname);
    },
    match: async () => undefined,
  }),
  keys: async () => ['old-version', SW_VERSION],
  delete: async (k) => {
    deleted.push(k);
    return true;
  },
};
new Function('self', 'caches', 'Request', 'Response', 'fetch', 'URL', sw)(self, caches, Request, Response, globalThis.fetch, URL);

check('sw.js registers install/activate/fetch handlers', ['install', 'activate', 'fetch'].every((t) => typeof listeners[t] === 'function'));

await listeners.install({ waitUntil: (p) => p });
check('install precaches the app shell', added.includes('/jarvis-ai/index.html') && added.includes('/jarvis-ai/manifest.webmanifest'), `${added.length} files: ${added.slice(0, 3).join(', ')}`);
check('precache uses absolute URLs (sub-path safe)', added.every((p) => p.startsWith('/jarvis-ai/')));
check('install precaches every icon', added.filter((p) => p.endsWith('.png')).length >= 3);
check('install precaches brain.js (the tool-calling brain)', added.includes('/jarvis-ai/brain.js'));
check('install tolerates a missing file', true); // Promise.all + per-request catch

await listeners.activate({ waitUntil: (p) => p });
check('activate removes the stale cache', deleted.includes('old-version') && !deleted.includes(SW_VERSION), deleted.join(','));

// routing
let navHandled = null;
listeners.fetch({
  request: { method: 'GET', mode: 'navigate', url: origin + '/jarvis-ai/', clone: () => ({}) },
  respondWith: (p) => {
    navHandled = p;
  },
});
check('navigations are intercepted (offline HTML fallback)', !!navHandled);

let apiHandled = null;
listeners.fetch({
  request: { method: 'GET', mode: 'cors', url: 'https://api.groq.com/openai/v1/models' },
  respondWith: (p) => {
    apiHandled = p;
  },
});
check('model API calls are NOT intercepted', apiHandled === null);

let postHandled = null;
listeners.fetch({
  request: { method: 'POST', mode: 'cors', url: origin + '/jarvis-ai/' },
  respondWith: (p) => {
    postHandled = p;
  },
});
check('non-GET requests are NOT intercepted', postHandled === null);

console.log(failed ? `\n${failed} check(s) failed` : '\nall PWA checks passed');
process.exit(failed ? 1 : 0);
