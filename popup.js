document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const openManager = document.getElementById('openManager');
  const downloadBtn = document.getElementById('downloadBtn');
  const clearBtn = document.getElementById('clearBtn');
  const requestList = document.getElementById('requestList');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin = null;
  try {
    if (tab && tab.url && (tab.url.startsWith('http') || tab.url.startsWith('file'))) {
      origin = new URL(tab.url).origin;
    }
  } catch (e) {
    console.error("Failed to parse tab URL:", e);
  }

  async function refreshUI() {
    if (!origin) {
      startBtn.disabled = true;
      stopBtn.disabled = true;
      startBtn.title = "Cannot capture this type of page (e.g. chrome:// or system pages)";
      return;
    }

    try {
      const siteStatus = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "getSiteCaptureStatus", origin }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ isCapturing: false });
          } else {
            resolve(response);
          }
        });
      });
      const isSiteActive = siteStatus && siteStatus.isCapturing;

      if (isSiteActive) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'block';
      } else {
        startBtn.style.display = 'block';
        stopBtn.style.display = 'none';
      }
    } catch (e) {
      console.warn("Refresh UI failed:", e);
    }
  }

  startBtn.onclick = async () => {
    await chrome.runtime.sendMessage({ action: "startSiteCapture", origin });
    refreshUI();
  };

  stopBtn.onclick = async () => {
    await chrome.runtime.sendMessage({ action: "stopSiteCapture", origin });
    refreshUI();
  };

  openManager.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html`) });
  };

  clearBtn.onclick = () => {
    if (confirm("Clear all captured logs?")) {
      chrome.runtime.sendMessage({ action: "clearAll" }, () => {
        requestList.innerHTML = '';
      });
    }
  };

  downloadBtn.onclick = () => {
    chrome.runtime.sendMessage({ action: "getRequestsByOrigin", origin }, (response) => {
      if (response && response.requests && response.requests.length > 0) {
        let content = `Fiddler Session - ${origin}\n\n`;
        response.requests.forEach((req, i) => {
          content += `--- Request #${i + 1} ---\n`;
          content += `${req.method} ${req.url}\n`;
          content += `cURL: ${generateCurl(req)}\n\n`;
        });
        downloadFile(content, `fiddler_${encodeURIComponent(origin)}.txt`);
      } else {
        alert("No requests captured for this site yet.");
      }
    });
  };

  function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderRequest(req) {
    const card = document.createElement('div');
    card.className = 'request-card glass animate-in';
    const url = new URL(req.url);
    card.innerHTML = `
      <div class="request-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <span class="method-badge">${req.method}</span>
        <span style="font-size: 0.7rem; color: var(--text-secondary);">${url.host}</span>
      </div>
      <div class="url-text" title="${req.url}">${url.pathname}</div>
      <button class="btn btn-ghost" style="width: 100%; font-size: 0.7rem; padding: 0.4rem;">Copy as cURL</button>
    `;
    
    card.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      const curl = generateCurl(req);
      navigator.clipboard.writeText(curl);
      const originalText = e.target.innerText;
      e.target.innerText = 'Copied!';
      e.target.classList.add('btn-success');
      setTimeout(() => {
        e.target.innerText = originalText;
        e.target.classList.remove('btn-success');
      }, 2000);
    };
    requestList.prepend(card);
  }

  function generateCurl(req) {
    let curl = `curl '${req.url}' -X ${req.method}`;
    for (const [key, value] of Object.entries(req.headers || {})) {
      curl += ` -H '${key}: ${value}'`;
    }
    if (req.postData) curl += ` --data-raw '${req.postData}'`;
    return curl;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "newRequest") renderRequest(message.request);
  });

  // Initial load
  refreshUI();
  if (origin) {
    chrome.runtime.sendMessage({ action: "getRequestsByOrigin", origin }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.requests) response.requests.forEach(renderRequest);
    });
  }
});
