import {
  send, subscribe, el, splitUrl, downloadText, copyWithFeedback, curlExport, generateCurl, byTimestampDesc,
} from './ui.js';

// Rendering thousands of cards makes the popup sluggish; the dashboard lists all.
const MAX_CARDS = 200;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const openManager = document.getElementById('openManager');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const requestList = document.getElementById('requestList');

const [ tab ] = await chrome.tabs.query({ active: true, currentWindow: true });
let origin = null;
try {
  if (tab?.url && /^(https?|file):/.test(tab.url)) {
    const o = new URL(tab.url).origin;
    origin = o === 'null' ? null : o;
  }
} catch (err) {
  console.error('failed to parse tab URL', err);
}

const cards = new Map(); // record key -> card element

function setCapturing(isCapturing) {
  startBtn.style.display = isCapturing ? 'none' : 'block';
  stopBtn.style.display = isCapturing ? 'block' : 'none';
}

async function refreshStatus() {
  if (!origin) {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    startBtn.title = 'Cannot capture this type of page (e.g. chrome:// or system pages)';
    return;
  }
  try {
    const { isCapturing } = await send('getSiteCaptureStatus', { origin });
    setCapturing(isCapturing);
  } catch (err) {
    console.warn('status check failed', err);
  }
}

function renderCard(req) {
  const { host, path } = splitUrl(req.url);
  const copy = el('button', { className: 'btn btn-ghost', text: 'Copy as cURL', style: { width: '100%', fontSize: '0.7rem', padding: '0.4rem' } });
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    const curl = generateCurl(req);
    if (curl === null) { copy.textContent = 'Unsupported URL scheme'; return; }
    copyWithFeedback(copy, curl);
  });
  const status = req.status ? `${req.status}` : (req.errorText ? 'failed' : '');
  return el('div', { className: 'request-card glass animate-in' }, [
    el('div', { className: 'request-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' } }, [
      el('span', { className: 'method-badge', text: req.method }),
      el('span', { text: status ? `${status} · ${host}` : host, style: { fontSize: '0.7rem', color: 'var(--text-secondary)' } }),
    ]),
    el('div', { className: 'url-text', text: path, title: req.url }),
    copy,
  ]);
}

function upsert(req) {
  const existing = cards.get(req.key);
  const card = renderCard(req);
  if (existing) {
    existing.replaceWith(card);
  } else {
    requestList.prepend(card);
    if (cards.size >= MAX_CARDS) {
      const oldest = requestList.lastElementChild;
      if (oldest) {
        oldest.remove();
        for (const [ k, v ] of cards) { if (v === oldest) { cards.delete(k); break; } }
      }
    }
  }
  cards.set(req.key, card);
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    await send('startSiteCapture', { origin });
  } finally {
    startBtn.disabled = false;
    refreshStatus();
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    await send('stopSiteCapture', { origin });
    requestList.replaceChildren();
    cards.clear();
  } finally {
    stopBtn.disabled = false;
    refreshStatus();
  }
});

openManager.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear all captured logs?')) { return; }
  await send('clearAll');
  requestList.replaceChildren();
  cards.clear();
});

downloadBtn.addEventListener('click', async () => {
  const { requests } = await send('getRequestsByOrigin', { origin });
  if (!requests.length) { alert('No requests captured for this site yet.'); return; }
  requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  downloadText(curlExport(`Fiddler Session - ${origin}`, requests, generateCurl), `fiddler_${encodeURIComponent(origin)}.txt`);
});

await refreshStatus();
if (origin) {
  subscribe(requests => {
    for (const req of requests) { if (req.pageOrigin === origin) { upsert(req); } }
  });
  try {
    const { requests } = await send('getRequestsByOrigin', { origin });
    // Oldest first so prepend leaves the newest on top; only the newest MAX_CARDS.
    requests.sort(byTimestampDesc).slice(0, MAX_CARDS).reverse().forEach(upsert);
  } catch (err) {
    console.warn('loading captures failed', err);
  }
}
