# Jarvis AI — personal phone assistant

A voice assistant with a particle orb that you can install on your own phone, where
it can also **act** on the phone: read messages, place calls, control volume,
torch, brightness, open apps, list files, show notifications, and run Termux
commands. You talk to it, it answers out loud, and when the question needs an
action it does the action instead of describing it.

Built for one person on one phone. There is no account, no server of ours, and
nothing is deployed: your API key and the bridge token live on your device only.

---

## 1. What it is made of

```
phone browser (installed app)          your model API (Groq / Gemini / OpenAI / ...)
        |                                          ^
        |  chat + tool calls                       |  streamed answers, tool requests
        v                                          |
   index.html + brain.js  ─────────────────────────┘
        |            the agent loop: ask model -> run tool -> feed result back
        |  POST /api/exec  (loopback, token)
        v
   bridge/jarvis_bridge.py   (Python, standard library only, runs in Termux)
        |  subprocess with an argument list, never a shell
        v
   Termux:API commands  ->  Android (SMS, calls, contacts, volume, torch, files ...)
```

* `index.html` — the whole app: orb, voice, chat, settings. No build step.
* `brain.js` — tool calling and the agent loop. Plain script, also importable in Node.
* `bridge/tools.json` — one source of truth for the 28 actions; the bridge turns
  them into OpenAI tool schemas, the app reads them over `/api/tools`.
* `bridge/jarvis_bridge.py` — validates arguments, runs the Termux command, and
  also serves the app itself so the phone gets it from `http://127.0.0.1:8787`.

## 2. Put it on the phone

Install **Termux** (F-Droid or GitHub build) and **Termux:API** (same source),
copy this folder to the phone, then inside Termux:

```bash
bash bridge/install-termux.sh
```

The script installs `python` + `termux-api`, creates a private token, starts the
bridge in the background with a wake lock, and prints the address:

```
Open this on the phone:      http://127.0.0.1:8787/
```

Open that address in Chrome and add it to the home screen (⋮ → *Add to Home
screen*). Because the bridge serves the page over loopback it is already a secure
origin, so it installs as a real standalone app with the service worker, and it
**fills in its own token** — you only have to:

1. Settings → **Device** → **Connect**
2. tick **Let Jarvis control this phone**
3. pick which actions it may use (all on except *Run a shell command*)

Then ask things like:

> “what is my battery at?” · “turn the torch on” · “text Ali I am on my way”
> “set the music volume to 8” · “read me my latest messages” · “open WhatsApp”
> “remind me to call the plumber in 20 minutes” · “remember that I park on level 3”

Android asks for SMS / Phone / Contacts / Location / Storage permission the first
time an action needs it — allow it there. Notification reading may need
*Settings → Apps → Termux:API → Notification access*.

### Already using the GitHub Pages copy?

Run the bridge with your Pages origin allowed, and paste the token once in
Settings → Device:

```bash
python3 bridge/jarvis_bridge.py --root . --allow-origin https://awai1903.github.io
```

### Try it without a phone

The bridge also serves the app itself, so you can look at the whole thing on a
computer (nothing is executed — `--dry-run` only prints the command it would run):

```bash
npm run demo          # or: python3 bridge/jarvis_bridge.py --root . --dry-run --assume-installed --no-token
# then open http://127.0.0.1:8787/ and press Connect in Settings > Device
```

`--no-token` accepts every `/api` call, which is why it is an explicit flag and
not the default. The phone setup never uses it.

## 3. What it can actually do

| Group | Actions |
| --- | --- |
| Device | battery, Wi-Fi info, device/SIM info, location, volume read/set, brightness, flashlight, vibrate, date & time |
| Messages | **send SMS**, read SMS, **place a call**, contacts, read notifications, show a notification, read/copy the clipboard |
| Media & apps | speak out loud even when the app is closed, on-screen toast, take a photo, open a link, **open another app** |
| Files | list and read files (confined to home folder and shared storage) |
| Memory | remember a fact / recall everything remembered (stored on the phone) |
| Power | **run any Termux shell command** — off by default, opt in per install |

`send SMS`, `place a call` and `run a shell command` are marked dangerous: the app
shows a dialog with the exact number, message or command, and nothing runs until
you tap *Do it*. You can turn that confirmation off, but the default is on.

### What it cannot do — no illusions

* It cannot control other apps' screens or tap buttons inside them. That needs
  root or an Android AccessibilityService; neither is included here.
* It cannot toggle Wi-Fi/Bluetooth/airplane mode: Android blocks that for ordinary
  apps since Android 10.
* It cannot silently read other apps' data. Notifications, SMS, contacts and
  location are all gated behind Android permissions.
* Every answer still comes from your own model API, so it is as smart (and as
  fallible) as the model you point it at. It refuses to promise anything and it
  never invents a phone number, package name or file path — if a value is missing
  it asks for it.
* Anything the Termux:API version on your phone does not support returns the raw
  error; the app prints it instead of pretending it worked.

## 4. Personal-use safety

* The bridge binds to **127.0.0.1 only** unless you pass `--host`. Nothing on the
  network can reach it.
* Every `/api` call needs the token (`X-Jarvis-Token`), compared in constant time.
  The token is created on the phone, `chmod 600`, and only ever handed to a page
  served to a **loopback** client.
* Commands run as a `subprocess` **argument list** — there is no `shell=True`
  anywhere, so a message containing `; rm -rf / && echo pwned` is one harmless
  argument (there is a test that proves exactly that).
* File tools resolve the real path and refuse anything outside your home folder
  and shared storage — `../../etc/passwd` is rejected before a command is built.
* Argument values are validated against the schema (types, ranges, enums, regex,
  length caps) and unknown arguments are rejected.
* Requests larger than 64 KB are refused, and every command has a 25 s timeout.
* Your model API key stays in the browser's `localStorage`; the bridge never sees
  it. The bridge token never leaves your device.
* The one deliberate hole is `--no-token` (local demos): it prints a warning and
  is never part of the phone setup.

## 5. Tests

No browser and no Android device exist in the build sandbox, so the suite boots
the real app in jsdom and runs the real Python bridge against fake Termux
commands:

```bash
npm install     # jsdom only; the app and the bridge have no dependencies
npm test
```

| File | Checks |
| --- | --- |
| `test/smoke.mjs` | boots the real page, built-in replies, escaping, the earlier accessibility fixes |
| `test/brain.mjs` | streaming tool-call assembly across chunk boundaries, argument repair, the agent loop, error feedback, step budget, models without tool support, prompt contents |
| `test/bridge.mjs` | starts the real server: schema generation, validation, auth, path confinement, CORS preflight, static serving with the token injection, and dry-run argv for every action |
| `test/device.mjs` | end-to-end in jsdom with a scripted model *and* a scripted bridge: connect → 28 tools → ask → tool runs → answer spoken; the confirmation dialog (cancel and confirm); a rejected token degrading to plain chat |
| `test/pwa.mjs` | manifest, real icon dimensions, and `sw.js` actually executed against stubbed Cache APIs |
| `test/contrast.mjs` | WCAG ratio for every real foreground/background pair, including the new device UI |

Run the bridge yourself to see what it would do on this machine without touching
anything:

```bash
python3 bridge/jarvis_bridge.py --list-tools        # what is installed here
python3 bridge/jarvis_bridge.py --dry-run --assume-installed --port 0
```

`--dry-run` validates the arguments and prints the exact argv it would run, so you
can see the whole decision path without touching the device. `--assume-installed`
pretends the Termux:API commands exist so every action can be inspected on a
machine that is not an Android phone.

## 6. What changed in this working copy

| Area | Problem found | Fix |
| --- | --- | --- |
| Contrast | accent-filled controls drew `--fg` on `--accent` at **2.85:1**; the user bubble 4.4:1; the voice-mode close button 3.22:1 | dark ink on accent fills (5.85:1), darker bubble gradient (6.1:1), darker red (4.78:1) |
| Screen readers | `#chat` was a polite live region while tokens streamed, so every partial word was announced | the log goes quiet while streaming; finished replies are announced once through `#srlive` |
| Keyboard | no way to leave the settings screen; the settings screen never received focus; the gear button desynced the tab state | focus moves in, `Esc` closes it, the gear routes through the tab state |
| Performance | `setInterval(freshCheck, 150)` and an 80 ms Gemini buffer poll ran forever | both event-driven; the flush timer only exists while audio is pending |
| Memory | chat history grew without bound | last 40 turns |
| Installable | no manifest, no icons, no offline | PWA manifest (incl. a maskable icon), generated icons, versioned service worker |
| **Phone control** | the assistant could only talk | 28 phone actions, an OpenAI tool-calling agent loop, an on-device bridge, per-action switches, a confirmation dialog and a visible action log |
| Bridge protocol | a rejected oversized body was left unread on a keep-alive connection, so a later reply on that same connection could be a stale one (found by a flaky test) | the `413` now asks the client to close the connection |

## 7. Notes

* Voice input is Chrome/Edge. Voice output uses the phone voice by default, or
  Gemini TTS if you paste a Gemini key.
* The model must support tool calling. Groq (`openai/gpt-oss-120b`), Gemini's
  OpenAI endpoint and OpenAI models do. If yours does not, Jarvis notices the 400,
  says so, and keeps answering as a normal chat.
* Without a bridge, the app is exactly what it was before: a voice assistant with
  simple built-in replies when no key is set.
