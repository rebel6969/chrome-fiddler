import db from './db.js';

const logger = {
  info: (msg, ctx) => db.addLog('info', msg, ctx),
  error: (msg, ctx) => db.addLog('error', msg, ctx),
  warn: (msg, ctx) => db.addLog('warn', msg, ctx)
};

let attachedTabs = new Set();
let activeSiteCaptures = new Set();

// Persistence Helpers
const updateStoredState = async () => {
  await chrome.storage.local.set({
    attachedTabs: Array.from(attachedTabs),
    activeSiteCaptures: Array.from(activeSiteCaptures)
  });
};

const restoreState = async () => {
  const result = await chrome.storage.local.get(['attachedTabs', 'activeSiteCaptures']);
  if (result.attachedTabs) attachedTabs = new Set(result.attachedTabs);
  if (result.activeSiteCaptures) activeSiteCaptures = new Set(result.activeSiteCaptures);
  logger.info("State restored from storage", { 
    attached: attachedTabs.size, 
    siteCaptures: activeSiteCaptures.size 
  });
};

const detachFromTab = async (tabId) => {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, async () => {
      // Accessing lastError "checks" it and prevents the console warning
      if (chrome.runtime.lastError) {
        // Silently ignore if already detached
      }
      attachedTabs.delete(tabId);
      await updateStoredState();
      resolve();
    });
  });
};

const attachToTab = async (tabId) => {
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", async () => {
      if (chrome.runtime.lastError) {
        if (chrome.runtime.lastError.message.includes("already attached")) {
          attachedTabs.add(tabId);
          await updateStoredState();
          resolve(true);
          return;
        }
        logger.error(`Failed to attach debugger: ${chrome.runtime.lastError.message}`, { tabId });
        resolve(false);
        return;
      }
      attachedTabs.add(tabId);
      await updateStoredState();
      chrome.debugger.sendCommand({ tabId }, "Network.enable");
      await db.clearTab(tabId);
      logger.info(`Capture started for tab ${tabId}`, { tabId });
      resolve(true);
    });
  });
};

const startSiteCapture = async (origin) => {
  activeSiteCaptures.add(origin);
  await updateStoredState();
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const results = [];
  for (const tab of tabs) {
    if (!attachedTabs.has(tab.id)) {
      results.push(attachToTab(tab.id));
    }
  }
  await Promise.all(results);
  logger.info(`Site capture started for origin ${origin}`, { origin });
};

const stopSiteCapture = async (origin) => {
  activeSiteCaptures.delete(origin);
  await updateStoredState();
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const results = [];
  for (const tab of tabs) {
    if (attachedTabs.has(tab.id)) {
      results.push(detachFromTab(tab.id));
    }
  }
  await Promise.all(results);
  await db.clearOrigin(origin);
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startCapture") {
    attachToTab(message.tabId).then(() => sendResponse({ success: true }));
    return true;
  } else if (message.action === "stopCapture") {
    detachFromTab(message.tabId).then(() => {
      logger.info(`Capture stopped for tab ${message.tabId}`, { tabId: message.tabId });
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "getCaptureStatus") {
    sendResponse({ isCapturing: attachedTabs.has(message.tabId) });
    return true;
  } else if (message.action === "clearAll") {
    db.clearAll().then(() => sendResponse({ success: true }));
    return true;
  } else if (message.action === "startSiteCapture") {
    startSiteCapture(message.origin).then(() => sendResponse({ success: true }));
    return true;
  } else if (message.action === "stopSiteCapture") {
    stopSiteCapture(message.origin).then(() => sendResponse({ success: true }));
    return true;
  } else if (message.action === "getSiteCaptureStatus") {
    sendResponse({ isCapturing: activeSiteCaptures.has(message.origin) });
    return true;
  } else if (message.action === "getRequestsByOrigin") {
    db.getRequestsByPageOrigin(message.origin).then(requests => {
      sendResponse({ requests });
    });
    return true;
  } else if (message.action === "getRequests") {
    db.getRequests(message.tabId).then(requests => {
      sendResponse({ requests });
    });
    return true; 
  } else if (message.action === "getUniqueOrigins") {
    db.getUniqueOrigins().then(origins => {
      sendResponse({ origins });
    });
    return true;
  } else if (message.action === "getAllRequests") {
    db.getAllRequests().then(requests => {
      sendResponse({ requests });
    });
    return true;
  }
});

const safeSendMessage = (message) => {
  chrome.runtime.sendMessage(message).catch(() => {});
};

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  try {
    const tabId = source.tabId;
    if (method === "Network.requestWillBeSent") {
      const request = params.request;
      let origin = null;
      let host = null;
      try {
        const urlObj = new URL(request.url);
        origin = urlObj.origin;
        host = urlObj.host;
      } catch (e) {}

      // Get page origin for correctly grouping site-wide requests
      let pageOrigin = null;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url) pageOrigin = new URL(tab.url).origin;
      } catch (e) {}

      const requestData = {
        tabId: tabId,
        requestId: params.requestId,
        url: request.url,
        origin,
        pageOrigin,
        host,
        method: request.method,
        headers: request.headers,
        postData: request.postData,
        timestamp: params.timestamp
      };
      
      await db.addRequest(requestData);
      safeSendMessage({ action: "newRequest", request: requestData });
    } else if (method === "Network.responseReceived") {
      const response = params.response;
      const responseData = {
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        responseHeaders: response.headers
      };
      
      await db.updateRequest(params.requestId, responseData);
      
      const skipBody = response.status === 204 || response.status === 304 || 
                       response.fromDiskCache || response.fromServiceWorker;

      if (!skipBody) {
        chrome.debugger.sendCommand({ tabId: tabId }, "Network.getResponseBody", { requestId: params.requestId }, (result) => {
          if (chrome.runtime.lastError) return;
          if (result) {
            db.updateRequest(params.requestId, { 
              responseBody: result.body, 
              base64Encoded: result.base64Encoded 
            }).catch(e => logger.error(`DB Update Error: ${e.message}`));
          }
        });
      }

      safeSendMessage({ action: "updateRequest", requestId: params.requestId, update: responseData });
    }
  } catch (err) {
    logger.error(`Event Handler Error (${method}): ${err.message}`, { source, params });
  }
});

chrome.debugger.onDetach.addListener(async (source) => {
  attachedTabs.delete(source.tabId);
  await updateStoredState();
  logger.info(`Debugger detached for tab ${source.tabId}`, { tabId: source.tabId });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    try {
      const urlObj = new URL(tab.url);
      const origin = urlObj.origin;
      if (activeSiteCaptures.has(origin) && !attachedTabs.has(tabId)) {
        attachToTab(tabId);
      }
    } catch (e) {}
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    await updateStoredState();
  }
});

// Initialization
chrome.runtime.onStartup.addListener(async () => {
  await restoreState();
  await db.clearAll();
  logger.info("Database cleared on browser startup");
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('dbCleanup', { periodInMinutes: 240 });
  await restoreState();
  logger.info("Cleanup alarm scheduled and state restored");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dbCleanup') {
    await db.clearAll();
    logger.info("Scheduled database cleanup performed");
  }
});

restoreState();
logger.info("Service worker initialized");
