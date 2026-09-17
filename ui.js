// Shared helpers for popup.html and manager.html.
//
// Captured data comes from arbitrary websites (URLs, headers, bodies), so it is
// only ever placed into the page as text. The previous pages interpolated it
// into innerHTML, which let a captured response body inject markup into this
// extension's own pages -- pages of an extension holding the debugger permission.

export { generateCurl } from './curl.js';

/** Send a message to the service worker; rejects on error replies. */
export async function send(action, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ action, ...extra });
  if (reply === undefined) { throw new Error('no response from service worker'); }
  if (reply.error !== undefined) { throw new Error(reply.error); }
  return reply;
}

/**
 * Receive batched record updates from the service worker. Reconnects if the
 * worker restarts (which closes the port).
 */
export function subscribe(onRequests) {
  let port = null;
  const connect = () => {
    port = chrome.runtime.connect({ name: 'fiddler-ui' });
    port.onMessage.addListener(msg => {
      if (msg?.action === 'requestsUpdated' && Array.isArray(msg.requests)) { onRequests(msg.requests); }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      setTimeout(connect, 500);
    });
  };
  connect();
}

/** Create an element with text content and attributes; never parses HTML. */
export function el(tag, { className, text, title, attrs, style } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) { node.className = className; }
  if (text !== undefined && text !== null) { node.textContent = String(text); }
  if (title) { node.title = title; }
  if (style) { Object.assign(node.style, style); }
  for (const [ k, v ] of Object.entries(attrs ?? {})) { node.setAttribute(k, v); }
  for (const child of children) { if (child) { node.append(child); } }
  return node;
}

export function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host || u.protocol, path: (u.pathname || '') + (u.search || '') };
  } catch {
    return { host: 'invalid-url', path: url };
  }
}

export function downloadText(content, filename, type = 'text/plain') {
  const blob = new Blob([ content ], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: filename } });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy text and show brief feedback on the button. */
export async function copyWithFeedback(button, text, doneLabel = 'Copied!') {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = doneLabel;
    button.classList.add('btn-success');
  } catch (err) {
    button.textContent = 'Copy failed';
    console.error('clipboard write failed', err);
  }
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('btn-success');
  }, 2000);
}

/** Text export of cURL commands, shared by the popup and the dashboard. */
export function curlExport(title, requests, generate) {
  const lines = [ title, '' ];
  requests.forEach((req, i) => {
    const { host } = splitUrl(req.url);
    lines.push(`--- Request #${i + 1} (${host}) ---`);
    lines.push(`${req.method} ${req.url}`);
    lines.push(`cURL: ${generate(req) ?? '(URL scheme not supported by cURL)'}`);
    lines.push('');
  });
  return lines.join('\n');
}

export const byTimestampDesc = (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0);
