# Jarvis AI Assistant

A voice assistant in a single `index.html` file, with a glowing particle orb. Type, dictate or talk, and it answers. There is no server and no build step. Your browser talks straight to the AI provider you choose.

## Use it
1. Open the page over https (for example with GitHub Pages).
2. Tap **Settings**, open **Advanced**, and enter your API key. The default provider is Groq with the model `openai/gpt-oss-120b`. Pick another provider from the list if you prefer.
3. Use **Chat** to type, or tap the glowing button at the bottom to talk to Jarvis.

## Screens
- **Home**: greeting and quick questions.
- **Chat**: text chat. The mic icon dictates into the box. Each answer has retry and copy buttons.
- **Glowing button (Jarvis)**: hands-free voice mode. Speak, pause, and Jarvis answers out loud. Tap the orb to interrupt. The sliders icon at the top right changes the voice, language (English, Urdu, Hindi) and audio output.
- **Triggers**: an optional "Hey Jarvis" wake word, reminders and timers ("remind me in 10 minutes to call Ali", "set a timer for 5 minutes"), and custom phrases that make Jarvis say something, open a link or ask the AI something else.
- **Settings**: AI provider, extra APIs, natural voice and privacy.

## AI providers
Groq, Google Gemini, OpenRouter, OpenAI, xAI Grok, or any OpenAI-compatible service through **Custom** (set the API base URL and model under Advanced). In Settings you can add more APIs and switch automatically by task, falling back to the next one if a request fails.

Without a key, Jarvis uses a few simple built-in replies: time, date, small sums, jokes, coin and dice, your name, and repeating what you say.

## Natural voice (optional)
Add a Gemini API key under Settings to use Gemini's text-to-speech for replies. If it fails, Jarvis falls back to your device's voice.

## Privacy
- Your keys and settings are saved only in your own browser (localStorage). They are never part of this code, so do not commit a key to this repo.
- Messages go from your browser directly to the provider you chose. With natural voice on, the text of each reply is also sent to Google.
- **Settings > Privacy > Clear local data** removes everything stored in the browser.

## Notes
- Voice input works best in Chrome or Edge on Android and desktop, and needs microphone permission.
- Some providers block requests made from a browser. If you see a connection error, try another provider.
- The wake word keeps the microphone listening while the page is open, so it is off by default.
