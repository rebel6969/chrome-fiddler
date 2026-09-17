import db from './db.js';

// Chrome Fiddler service worker: captures network traffic of chosen sites through
// the chrome.debugger (Chrome DevTools Protocol) API.
//
// Capture follows what DevTools itself does (front_end/core/sdk/NetworkManager.ts):
//  - Network.enable with maxPostDataSize so small request bodies arrive inline;
//    larger ones are fetched with Network.getRequestPostData.
//  - requestWillBeSent carries only provisional headers; the headers actually
//    sent (Cookie, and others the network stack adds) arrive in
//    requestWillBeSentExtraInfo, one per redirect hop, in order. Both are kept,
//    and the real ones replace the provisional ones.
//  - A redirect reuses the requestId; each hop is recorded separately.
//  - Response bodies exist only after Network.loadingFinished; asking at
//    responseReceived (as before) usually failed with "No data found".

const PROTOCOL_VERSION = '1.3';
const MAX_POST_DATA_INLINE = 64 * 1024;       // same as DevTools
const MAX_STORED_BODY_BYTES = 10 * 1024 * 1024; // larger bodies are not stored
const UI_PUSH_DELAY_MS = 250;
const CLEANUP_ALARM = 'dbCleanup';

/* ------------------------------------------------------------------------- */
/* Logging: errors and warnings persisted; info goes to the console only       */

const logger = {
  info: (msg, ctx) => console.info('[fiddler]', msg, ctx ?? ''),
  warn: (msg, ctx) => { console.warn('[fiddler]', msg, ctx ?? ''); db.addLog('warn', msg, ctx).catch(() => {}); },
  error: (msg, ctx) => { console.error('[fiddler]', msg, ctx ?? ''); db.addLog('error', msg, ctx).catch(() => {}); },
};

/* ------------------------------------------------------------------------- */
/* State                                                                      */

// Origins with site capture on. Persisted in storage.local: survives browser
// restarts, as before.
let siteCaptures = new Set();
// Tabs this extension has a debugger session on. Kept in storage.session: it
// survives service-worker restarts but not browser restarts, which is exactly
// the lifetime of a debugger session.
let attachedTabs = new Set();
// tabId -> { origin, targetId }. targetId is the page target id, which equals
// the tab's main frame id; used to recognise top-level navigations.
const tabInfo = new Map();
// `${tabId}:${requestId}` -> in-flight capture state.
const inflight = new Map();

const ready = (async () => {
  const [ local, session ] = await Promise.all([
    chrome.storage.local.get('activeSiteCaptures'),
    chrome.storage.session.get('attachedTabs'),
  ]);
  siteCaptures = new Set(local.activeSiteCaptures ?? []);
  // Keep only sessions that still exist.
  const stored = new Set(session.attachedTabs ?? []);
  const targets = await chrome.debugger.getTargets();
  const live = new Set(targets.filter(t => t.attached && typeof t.tabId === 'number').map(t => t.tabId));
  attachedTabs = new Set([ ...stored ].filter(id => live.has(id)));
  for (const t of targets) {
    if (typeof t.tabId === 'number' && attachedTabs.has(t.tabId)) {
      tabInfo.set(t.tabId, { origin: originOf(t.url), targetId: t.id });
    }
  }
  if (attachedTabs.size !== stored.size) { await saveAttached(); }
})().catch(err => logger.error(`initialisation failed: ${err.message}`));

const saveAttached = () => chrome.storage.session.set({ attachedTabs: [ ...attachedTabs ] });
const saveSiteCaptures = () => chrome.storage.local.set({ activeSiteCaptures: [ ...siteCaptures ] });

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Attach / detach                                                            */

// One attach per tab at a time; concurrent requests (popup click + tab update)
// share the same promise instead of racing into "already attached" errors.
const attaching = new Map();

function attachToTab(tabId, { clearPrevious = true, origin: knownOrigin = null } = {}) {
  if (attachedTabs.has(tabId)) { return Promise.resolve(true); }
  let p = attaching.get(tabId);
  if (p) { return p; }
  p = (async () => {
    const target = { tabId };
    // Old captures of this tab go first, so the delete cannot touch new ones.
    if (clearPrevious) { await db.clearTab(tabId); }
    try {
      await chrome.debugger.attach(target, PROTOCOL_VERSION);
    } catch (err) {
      logger.warn(`attach failed: ${err.message}`, { tabId });
      return false;
    }
    // Every millisecond between attach and Network.enable is a window in which a
    // page-load request goes unrecorded, so enabling is not delayed by the tab
    // lookups: the tab counts as attached immediately (the event filter checks
    // it), Network.enable is sent at once, and the page origin / main-frame id
    // are resolved in parallel.
    const info = { origin: knownOrigin, targetId: null };
    tabInfo.set(tabId, info);
    attachedTabs.add(tabId);
    const lookups = Promise.all([
      chrome.tabs.get(tabId).catch(() => null),
      chrome.debugger.getTargets(),
    ]).then(([ tab, targets ]) => {
      if (info.origin === null) { info.origin = originOf(tab?.pendingUrl || tab?.url || ''); }
      info.targetId = targets.find(t => t.tabId === tabId)?.id ?? null;
    });
    try {
      await Promise.all([
        chrome.debugger.sendCommand(target, 'Network.enable', { maxPostDataSize: MAX_POST_DATA_INLINE }),
        lookups,
      ]);
    } catch (err) {
      logger.error(`Network.enable failed: ${err.message}`, { tabId });
      forgetTab(tabId);
      await chrome.debugger.detach(target).catch(() => {});
      await saveAttached();
      return false;
    }
    await saveAttached();
    logger.info(`capture started for tab ${tabId}`);
    return true;
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

async function detachFromTab(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {}); // already detached is fine
  forgetTab(tabId);
  await saveAttached();
}

function forgetTab(tabId) {
  attachedTabs.delete(tabId);
  tabInfo.delete(tabId);
  const prefix = `${tabId}:`;
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) { inflight.delete(key); }
  }
}

async function startSiteCapture(origin) {
  siteCaptures.add(origin);
  await saveSiteCaptures();
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  await Promise.all(tabs.map(tab => attachToTab(tab.id)));
  logger.info(`site capture started for ${origin}`);
}

async function stopSiteCapture(origin) {
  siteCaptures.delete(origin);
  await saveSiteCaptures();
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  await Promise.all(tabs.filter(t => attachedTabs.has(t.id)).map(t => detachFromTab(t.id)));
  // Stopping only stops capturing. What was captured stays available in the
  // popup and dashboard until the user clears it (or the startup / periodic
  // cleanup runs), so a session can be reviewed and exported after stopping.
  logger.info(`site capture stopped for ${origin}`);
}

/* ------------------------------------------------------------------------- */
/* UI push: batched, and only to pages that are open                           */

const uiPorts = new Set();
let uiQueue = [];
let uiTimer = null;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'fiddler-ui') { return; }
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
});

// Summary without bodies: the UI lists requests; details are read on demand.
function summarize(record) {
  const { responseBody, ...rest } = record;
  return rest;
}

function pushToUI(record) {
  if (uiPorts.size === 0) { return; }
  uiQueue.push(summarize(record));
  if (uiTimer !== null) { return; }
  uiTimer = setTimeout(() => {
    uiTimer = null;
    const batch = uiQueue;
    uiQueue = [];
    // Later snapshots of the same record supersede earlier ones.
    const latest = new Map();
    for (const r of batch) { latest.set(r.key, r); }
    const message = { action: 'requestsUpdated', requests: [ ...latest.values() ] };
    for (const port of uiPorts) {
      try { port.postMessage(message); } catch { uiPorts.delete(port); }
    }
  }, UI_PUSH_DELAY_MS);
}

function save(record) {
  db.put(record);
  pushToUI(record);
}

/* ------------------------------------------------------------------------- */
/* Network events                                                             */

function headersObject(headers) {
  const out = {};
  for (const [ name, value ] of Object.entries(headers ?? {})) { out[name] = String(value); }
  return out;
}

function applyResponse(record, response) {
  record.status = response.status;
  record.statusText = response.statusText;
  record.mimeType = response.mimeType;
  record.responseHeaders = headersObject(response.headers);
  record.protocol = response.protocol;
  record.remoteAddress = response.remoteIPAddress ? `${response.remoteIPAddress}:${response.remotePort}` : undefined;
  record.fromCache = Boolean(response.fromDiskCache || response.fromPrefetchCache || response.fromServiceWorker);
}

function onRequestWillBeSent(tabId, params) {
  const id = `${tabId}:${params.requestId}`;
  let state = inflight.get(id);
  if (state && params.redirectResponse) {
    // Close the previous hop with the redirect response.
    const prev = state.hops[state.hops.length - 1];
    applyResponse(prev, params.redirectResponse);
    prev.finished = true;
    save(prev);
  }
  if (!state) {
    state = { hops: [], extraInfos: [] };
    inflight.set(id, state);
  }

  const info = tabInfo.get(tabId) ?? { origin: null, targetId: null };
  // A top-level document request starts a navigation: its URL is the page
  // origin from here on (tabs.onUpdated reports it later than this event).
  if (params.type === 'Document' && info.targetId !== null && params.frameId === info.targetId) {
    const navOrigin = originOf(params.request.url);
    if (navOrigin) { info.origin = navOrigin; tabInfo.set(tabId, info); }
  }

  const request = params.request;
  let host = null;
  let origin = null;
  try {
    const u = new URL(request.url);
    host = u.host;
    origin = u.origin;
  } catch { /* data: and similar */ }

  const hop = state.hops.length;
  const record = {
    key: `${id}:${hop}`,
    tabId,
    requestId: params.requestId,
    hop,
    url: request.url + (request.urlFragment ?? ''),
    origin,
    host,
    pageOrigin: info.origin,
    method: request.method,
    headers: headersObject(request.headers),
    headersProvisional: true,
    postData: request.postData,
    type: params.type,
    initiator: params.initiator?.type,
    timestamp: params.wallTime ? params.wallTime * 1000 : Date.now(),
    finished: false,
  };
  state.hops.push(record);

  // Extra info for this hop may already have arrived.
  const extra = state.extraInfos[hop];
  if (extra) { applyExtraInfo(record, extra); }

  // Bodies above maxPostDataSize are not inlined; fetch them.
  if (request.hasPostData && request.postData === undefined) {
    chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId: params.requestId })
      .then(result => {
        if (typeof result?.postData === 'string') {
          record.postData = result.postData;
          if (result.base64Encoded) { record.postDataBase64 = true; }
          save(record);
        }
      })
      .catch(err => logger.warn(`getRequestPostData failed: ${err.message}`, { tabId, url: record.url }));
  }
  save(record);
}

function applyExtraInfo(record, headers) {
  record.headers = headersObject(headers);
  record.headersProvisional = false;
}

function onRequestWillBeSentExtraInfo(tabId, params) {
  const id = `${tabId}:${params.requestId}`;
  let state = inflight.get(id);
  if (!state) {
    // Extra info can precede requestWillBeSent.
    state = { hops: [], extraInfos: [] };
    inflight.set(id, state);
  }
  const index = state.extraInfos.length;
  state.extraInfos.push(params.headers);
  const record = state.hops[index];
  if (record) {
    applyExtraInfo(record, params.headers);
    save(record);
  }
}

function currentHop(tabId, requestId) {
  const state = inflight.get(`${tabId}:${requestId}`);
  return state ? state.hops[state.hops.length - 1] : undefined;
}

function onResponseReceived(tabId, params) {
  const record = currentHop(tabId, params.requestId);
  if (!record) { return; }
  applyResponse(record, params.response);
  save(record);
}

function onLoadingFinished(tabId, params) {
  const id = `${tabId}:${params.requestId}`;
  const record = currentHop(tabId, params.requestId);
  inflight.delete(id);
  if (!record) { return; }
  record.finished = true;
  record.encodedDataLength = params.encodedDataLength;

  const noBody = record.status === 204 || record.status === 304 || record.method === 'HEAD';
  if (noBody) { save(record); return; }
  if (params.encodedDataLength > MAX_STORED_BODY_BYTES) {
    record.bodyOmitted = `larger than ${MAX_STORED_BODY_BYTES / 1048576} MB`;
    save(record);
    return;
  }
  chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
    .then(result => {
      record.responseBody = result.body;
      record.base64Encoded = result.base64Encoded;
    })
    .catch(err => {
      // Expected for some resources (e.g. evicted from the buffer); recorded, not logged.
      record.bodyOmitted = err.message;
    })
    .finally(() => save(record));
}

function onLoadingFailed(tabId, params) {
  const id = `${tabId}:${params.requestId}`;
  const record = currentHop(tabId, params.requestId);
  inflight.delete(id);
  if (!record) { return; }
  record.finished = true;
  record.errorText = params.errorText;
  record.canceled = Boolean(params.canceled);
  record.blockedReason = params.blockedReason;
  save(record);
}

const HANDLERS = {
  'Network.requestWillBeSent': onRequestWillBeSent,
  'Network.requestWillBeSentExtraInfo': onRequestWillBeSentExtraInfo,
  'Network.responseReceived': onResponseReceived,
  'Network.loadingFinished': onLoadingFinished,
  'Network.loadingFailed': onLoadingFailed,
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  const handler = HANDLERS[method];
  if (handler === undefined || typeof source.tabId !== 'number') { return; }
  // Only sessions this extension opened.
  if (!attachedTabs.has(source.tabId)) { return; }
  try {
    handler(source.tabId, params);
  } catch (err) {
    logger.error(`event handler error (${method}): ${err.message}`, { tabId: source.tabId });
  }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (typeof source.tabId !== 'number' || !attachedTabs.has(source.tabId)) { return; }
  forgetTab(source.tabId);
  await saveAttached();
  logger.info(`debugger detached from tab ${source.tabId}: ${reason}`);
});

/* ------------------------------------------------------------------------- */
/* Tabs                                                                       */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;
  const url = changeInfo.url ?? (changeInfo.status === 'loading' ? tab.url : undefined);
  if (!url) { return; }
  const origin = originOf(url);
  const info = tabInfo.get(tabId);
  if (info && origin) { info.origin = origin; }
  // Attach as soon as the tab starts loading a captured origin, not at
  // 'complete' as before, which missed every request made during page load.
  // Measured: a new tab's own document request and fetches issued at the very
  // start of the page can still precede the attach -- chrome.debugger.attach is
  // asynchronous and Chrome does not hold the navigation for it. Attaching from
  // webNavigation.onBeforeNavigate was measured too and captured nothing more.
  if (origin && siteCaptures.has(origin) && !attachedTabs.has(tabId)) {
    attachToTab(tabId, { clearPrevious: false, origin });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (!attachedTabs.has(tabId)) { return; }
  forgetTab(tabId);
  await saveAttached();
});

/* ------------------------------------------------------------------------- */
/* Messages                                                                   */

const MESSAGE_HANDLERS = {
  startCapture: ({ tabId }) => attachToTab(tabId).then(ok => ({ success: ok })),
  stopCapture: ({ tabId }) => detachFromTab(tabId).then(() => ({ success: true })),
  getCaptureStatus: ({ tabId }) => ({ isCapturing: attachedTabs.has(tabId) }),
  startSiteCapture: ({ origin }) => startSiteCapture(origin).then(() => ({ success: true })),
  stopSiteCapture: ({ origin }) => stopSiteCapture(origin).then(() => ({ success: true })),
  getSiteCaptureStatus: ({ origin }) => ({ isCapturing: siteCaptures.has(origin) }),
  getRequestsByOrigin: ({ origin }) => db.getRequestsByPageOrigin(origin).then(requests => ({ requests })),
  getRequests: ({ tabId }) => db.getRequests(tabId).then(requests => ({ requests })),
  getAllRequests: () => db.getAllRequests().then(requests => ({ requests })),
  getRequest: ({ key }) => db.getRequest(key).then(request => ({ request })),
  getUniqueOrigins: () => db.getUniqueOrigins().then(origins => ({ origins })),
  getLogs: () => db.getLogs().then(logs => ({ logs })),
  clearAll: () => db.clearAll().then(() => ({ success: true })),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages may drive capture.
  if (sender.id !== chrome.runtime.id) { return false; }
  const handler = MESSAGE_HANDLERS[message?.action];
  if (handler === undefined) { return false; }
  ready
    .then(() => handler(message))
    .then(result => sendResponse(result))
    .catch(err => {
      logger.error(`message ${message.action} failed: ${err.message}`);
      sendResponse({ error: err.message });
    });
  return true;
});

/* ------------------------------------------------------------------------- */
/* Lifecycle                                                                  */

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  // Captures do not outlive a browser session (unchanged behaviour).
  await db.clearAll();
  logger.info('database cleared on browser startup');
});

chrome.runtime.onInstalled.addListener(async () => {
  // Re-creating an existing alarm resets its schedule; only create if missing.
  if (!(await chrome.alarms.get(CLEANUP_ALARM))) {
    await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 240 });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CLEANUP_ALARM) { return; }
  await ready;
  await db.clearAll();
  logger.info('scheduled database cleanup performed');
});
