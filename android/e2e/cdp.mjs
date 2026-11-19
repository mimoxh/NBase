// Usage: node cdp.mjs <file-with-expression>   Evaluates in the NBase page of the app's WebView.
// Expects the page at http://127.0.0.1:4330 (adb reverse) and a DevTools port forwarded by Connect-Cdp.
import { readFileSync } from 'node:fs';
const expression = readFileSync(process.argv[2], 'utf8');
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:4330'));
if (!page) { console.log(JSON.stringify(targets.map((t) => [t.type, t.url]))); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const result = await new Promise((resolve) => {
  ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.id === 1) resolve(m.result); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
});
console.log(JSON.stringify(result.exceptionDetails ? result.exceptionDetails : result.result.value));
ws.close();
