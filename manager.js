import {
  send, subscribe, el, splitUrl, downloadText, copyWithFeedback, curlExport, generateCurl, byTimestampDesc,
} from './ui.js';

const requestList = document.getElementById('requestList');
const siteFilter = document.getElementById('siteFilter');
const exportFiltered = document.getElementById('exportFiltered');
const exportAllFull = document.getElementById('exportAllFull');
const clearAllBtn = document.getElementById('clearAll');
const detailView = document.getElementById('detailView');

// Record summaries (no bodies) by key, and their list items.
const records = new Map();
const items = new Map();
let activeKey = null;

/* ------------------------------------------------------------------------- */
/* Site filter                                                                */

function addOriginOption(origin) {
  if (!origin) { return; }
  for (const opt of siteFilter.options) { if (opt.value === origin) { return; } }
  const options = Array.from(siteFilter.options).slice(1).map(o => o.value);
  options.push(origin);
  options.sort();
  const selected = siteFilter.value;
  siteFilter.replaceChildren(
    el('option', { text: 'All Captured Sites', attrs: { value: '' } }),
    ...options.map(o => el('option', { text: o, attrs: { value: o } })),
  );
  siteFilter.value = selected;
}

async function loadOrigins() {
  const { origins } = await send('getUniqueOrigins');
  const selected = siteFilter.value;
  siteFilter.replaceChildren(
    el('option', { text: 'All Captured Sites', attrs: { value: '' } }),
    ...origins.sort().map(o => el('option', { text: o, attrs: { value: o } })),
  );
  siteFilter.value = origins.includes(selected) ? selected : '';
}

const matchesFilter = req => !siteFilter.value || req.pageOrigin === siteFilter.value;

/* ------------------------------------------------------------------------- */
/* List                                                                       */

function renderItem(req) {
  const { host, path } = splitUrl(req.url);
  const children = [
    el('div', { style: { display: 'flex', gap: '0.75rem', alignItems: 'flex-start' } }, [
      el('span', { className: 'method-badge', text: req.method, style: { flexShrink: '0' } }),
      el('span', { text: path, style: { fontWeight: '500', fontSize: '0.9rem', wordBreak: 'break-all' } }),
    ]),
    el('div', { text: host, style: { fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem', wordBreak: 'break-all' } }),
  ];
  if (req.status || req.errorText) {
    const failed = Boolean(req.errorText) || req.status >= 400;
    children.push(el('div', {
      text: req.errorText ? `failed: ${req.errorText}` : `${req.status} ${req.statusText || ''}`,
      style: { fontSize: '0.75rem', marginTop: '0.25rem', color: failed ? 'var(--danger)' : 'var(--accent)' },
    }));
  }
  const item = el('div', { className: 'request-item' }, children);
  if (req.key === activeKey) { item.classList.add('active'); }
  item.addEventListener('click', () => showDetail(req.key));
  return item;
}

// Newest first. Items are inserted in place instead of rebuilding the whole list
// on every captured request, which the previous dashboard did (re-reading every
// record from the database each time).
function placeItem(req, item) {
  let before = null;
  for (const child of requestList.children) {
    const other = records.get(child.dataset.key);
    if (other && (other.timestamp ?? 0) < (req.timestamp ?? 0)) { before = child; break; }
  }
  requestList.insertBefore(item, before);
}

function upsert(req) {
  records.set(req.key, req);
  addOriginOption(req.pageOrigin);
  const existing = items.get(req.key);
  if (!matchesFilter(req)) {
    if (existing) { existing.remove(); items.delete(req.key); }
    return;
  }
  const item = renderItem(req);
  item.dataset.key = req.key;
  if (existing) {
    existing.replaceWith(item);
  } else {
    placeItem(req, item);
  }
  items.set(req.key, item);
  if (req.key === activeKey) { showDetail(req.key, { keepScroll: true }); }
}

function renderList() {
  items.clear();
  const visible = Array.from(records.values()).filter(matchesFilter).sort(byTimestampDesc);
  const fragment = document.createDocumentFragment();
  for (const req of visible) {
    const item = renderItem(req);
    item.dataset.key = req.key;
    items.set(req.key, item);
    fragment.append(item);
  }
  requestList.replaceChildren(fragment);
}

async function loadAll() {
  const { requests } = await send('getAllRequests');
  records.clear();
  for (const req of requests) {
    const { responseBody, ...summary } = req;
    records.set(req.key, summary);
  }
  renderList();
}

/* ------------------------------------------------------------------------- */
/* Detail                                                                     */

function section(title, content) {
  return el('section', {}, [
    el('h4', { text: title, style: { fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }),
    content,
  ]);
}

function headerBlock(headers) {
  const block = el('div', { className: 'code-block', style: { background: 'rgba(0,0,0,0.3)', padding: '1rem', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.85rem', border: '1px solid var(--surface-border)', wordBreak: 'break-all' } });
  for (const [ k, v ] of Object.entries(headers || {})) {
    block.append(el('div', { style: { marginBottom: '0.25rem' } }, [
      el('span', { text: `${k}: `, style: { color: 'var(--accent)' } }),
      document.createTextNode(v),
    ]));
  }
  return block;
}

function preBlock(text, maxHeight) {
  return el('pre', { className: 'code-block', text, style: { maxHeight, overflow: 'auto' } });
}

// Show text bodies as text; base64 bodies decoded when they are valid UTF-8.
function bodyText(req) {
  if (!req.base64Encoded) { return req.responseBody; }
  try {
    const bytes = Uint8Array.from(atob(req.responseBody), c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `[binary, base64]\n${req.responseBody}`;
  }
}

async function showDetail(key, { keepScroll = false } = {}) {
  activeKey = key;
  for (const [ k, item ] of items) { item.classList.toggle('active', k === key); }
  const scroll = keepScroll ? detailView.scrollTop : 0;

  // Bodies are not kept in the list; read the full record on demand.
  let req;
  try {
    ({ request: req } = await send('getRequest', { key }));
  } catch (err) {
    detailView.replaceChildren(el('div', { className: 'placeholder', text: `Could not load request: ${err.message}` }));
    return;
  }
  if (!req || activeKey !== key) { return; }

  const copyBash = el('button', { className: 'btn btn-primary', text: 'Copy cURL (bash)', style: { padding: '0.5rem 1rem', fontSize: '0.8rem' } });
  const copyCmd = el('button', { className: 'btn btn-ghost', text: 'Copy cURL (cmd)', style: { padding: '0.5rem 1rem', fontSize: '0.8rem' } });
  for (const [ button, platform ] of [ [ copyBash, 'unix' ], [ copyCmd, 'win' ] ]) {
    button.addEventListener('click', () => {
      const curl = generateCurl(req, platform);
      if (curl === null) { button.textContent = 'Unsupported URL scheme'; return; }
      copyWithFeedback(button, curl);
    });
  }

  const statusLine = req.errorText
    ? `failed: ${req.errorText}`
    : (req.status ? `${req.status} ${req.statusText || ''}` : 'pending');
  const meta = [ statusLine, req.type, req.mimeType, req.protocol, req.remoteAddress ].filter(Boolean).join(' · ');

  const sections = [
    section(req.headersProvisional ? 'Request Headers (provisional)' : 'Request Headers', headerBlock(req.headers)),
  ];
  if (req.postData) {
    sections.push(section(req.postDataBase64 ? 'Payload (base64)' : 'Payload', preBlock(req.postData, '200px')));
  }
  if (req.responseHeaders) {
    sections.push(section('Response Headers', headerBlock(req.responseHeaders)));
  }
  if (typeof req.responseBody === 'string') {
    sections.push(section('Response Body', preBlock(bodyText(req), '400px')));
  } else if (req.bodyOmitted) {
    sections.push(section('Response Body', el('div', { text: `Not captured: ${req.bodyOmitted}`, style: { color: 'var(--text-secondary)' } })));
  }

  detailView.replaceChildren(el('div', { className: 'glass', style: { padding: '1.5rem', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', gap: '1.5rem' } }, [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' } }, [
      el('div', { style: { flex: '1', wordBreak: 'break-all' } }, [
        el('div', { className: 'method-badge', text: req.method, style: { marginBottom: '0.5rem' } }),
        el('h3', { text: req.url, style: { fontSize: '1.1rem', lineHeight: '1.4' } }),
        el('div', { text: meta, style: { fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' } }),
      ]),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.5rem' } }, [ copyBash, copyCmd ]),
    ]),
    el('div', { className: 'detail-grid', style: { display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' } }, sections),
  ]));
  detailView.scrollTop = scroll;
}

function resetDetail() {
  activeKey = null;
  detailView.replaceChildren(el('div', { className: 'placeholder' }, [ el('p', { text: 'Select a request from the list to view full details' }) ]));
}

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */

exportFiltered.addEventListener('click', async () => {
  const origin = siteFilter.value;
  const { requests } = origin ? await send('getRequestsByOrigin', { origin }) : await send('getAllRequests');
  requests.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  downloadText(curlExport(`Fiddler Export - ${origin || 'All Sites'}`, requests, generateCurl), `fiddler_export_${Date.now()}.txt`);
});

exportAllFull.addEventListener('click', async () => {
  const { requests } = await send('getAllRequests');
  downloadText(JSON.stringify(requests, null, 2), `fiddler_full_data_${Date.now()}.json`, 'application/json');
});

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Clear all captured data?')) { return; }
  await send('clearAll');
  records.clear();
  renderList();
  await loadOrigins();
  resetDetail();
});

siteFilter.addEventListener('change', renderList);

/* ------------------------------------------------------------------------- */

subscribe(requests => { for (const req of requests) { upsert(req); } });
await Promise.all([ loadOrigins(), loadAll() ]);
