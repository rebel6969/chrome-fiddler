document.addEventListener('DOMContentLoaded', () => {
  const requestList = document.getElementById('requestList');
  const siteFilter = document.getElementById('siteFilter');
  const exportFiltered = document.getElementById('exportFiltered');
  const exportAllFull = document.getElementById('exportAllFull');
  const clearAllBtn = document.getElementById('clearAll');
  const detailView = document.getElementById('detailView');

  // Load site filter options
  async function updateFilterOptions() {
    chrome.runtime.sendMessage({ action: "getUniqueOrigins" }, (response) => {
      if (response && response.origins) {
        siteFilter.innerHTML = '<option value="">All Captured Sites</option>';
        response.origins.sort().forEach(origin => {
          const option = document.createElement('option');
          option.value = origin;
          option.textContent = origin;
          siteFilter.appendChild(option);
        });
      }
    });
  }

  async function updateList() {
    const selectedOrigin = siteFilter.value;
    const action = selectedOrigin ? "getRequestsByOrigin" : "getAllRequests";
    const payload = selectedOrigin ? { action, origin: selectedOrigin } : { action };

    chrome.runtime.sendMessage(payload, (response) => {
      requestList.innerHTML = '';
      if (response && response.requests) {
        response.requests.sort((a, b) => b.timestamp - a.timestamp).forEach(renderListItem);
      }
    });
  }

  function renderListItem(req) {
    const item = document.createElement('div');
    item.className = 'request-item';
    let url;
    try {
      url = new URL(req.url);
    } catch (e) {
      url = { pathname: req.url, host: 'invalid-url' };
    }
    item.innerHTML = `
      <div style="display: flex; gap: 0.75rem; align-items: flex-start;">
        <span class="method-badge" style="flex-shrink: 0;">${req.method}</span>
        <span style="font-weight: 500; font-size: 0.9rem; word-break: break-all;">${url.pathname}</span>
      </div>
      <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.25rem; word-break: break-all;">${url.host}</div>
      ${req.status ? `<div style="font-size: 0.75rem; margin-top: 0.25rem; color: ${req.status >= 400 ? 'var(--danger)' : 'var(--accent)'}">${req.status} ${req.statusText || ''}</div>` : ''}
    `;
    item.onclick = () => showDetail(req);
    requestList.appendChild(item);
  }

  function showDetail(req) {
    document.querySelectorAll('.request-item').forEach(i => i.classList.remove('active'));
    // Find item and mark active... simplified for now
    
    const curl = generateCurl(req);
    detailView.innerHTML = `
      <div class="glass" style="padding: 1.5rem; border-radius: var(--radius-lg); height: 100%; display: flex; flex-direction: column; gap: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div style="flex: 1; word-break: break-all;">
            <div class="method-badge" style="margin-bottom: 0.5rem;">${req.method}</div>
            <h3 style="font-size: 1.1rem; line-height: 1.4;">${req.url}</h3>
          </div>
          <button id="copyCurl" class="btn btn-primary" style="padding: 0.5rem 1rem; font-size: 0.8rem;">Copy Command</button>
        </div>

        <div class="detail-grid" style="display: grid; grid-template-columns: 1fr; gap: 1.5rem; flex: 1; overflow-y: auto; padding-right: 0.5rem;">
          <section>
            <h4 style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">Request Headers</h4>
            <div class="code-block" style="background: rgba(0,0,0,0.3); padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; border: 1px solid var(--surface-border);">
              ${Object.entries(req.headers || {}).map(([k,v]) => `<div style="margin-bottom: 0.25rem;"><span style="color: var(--accent);">${k}:</span> ${v}</div>`).join('')}
            </div>
          </section>

          ${req.postData ? `
          <section>
            <h4 style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.75rem; text-transform: uppercase;">Payload</h4>
            <pre class="code-block" style="max-height: 200px; overflow: auto; background: rgba(0,0,0,0.3); padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; border: 1px solid var(--surface-border); white-space: pre-wrap;">${req.postData}</pre>
          </section>` : ''}

          ${req.responseBody ? `
          <section>
            <h4 style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.75rem; text-transform: uppercase;">Response Body</h4>
            <pre class="code-block" style="max-height: 400px; overflow: auto; background: rgba(0,0,0,0.3); padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; border: 1px solid var(--surface-border); white-space: pre-wrap;">${req.responseBody}</pre>
          </section>` : ''}
        </div>
      </div>
    `;

    document.getElementById('copyCurl').onclick = (e) => {
      navigator.clipboard.writeText(curl);
      e.target.innerText = 'Copied!';
      setTimeout(() => e.target.innerText = 'Copy Command', 2000);
    };
  }

  function generateCurl(req) {
    let curl = `curl '${req.url}' -X ${req.method}`;
    for (const [key, value] of Object.entries(req.headers || {})) {
      curl += ` -H '${key}: ${value}'`;
    }
    if (req.postData) curl += ` --data-raw '${req.postData}'`;
    return curl;
  }

  function downloadContent(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  exportFiltered.onclick = () => {
    const selectedOrigin = siteFilter.value;
    const action = selectedOrigin ? "getRequestsByOrigin" : "getAllRequests";
    const payload = selectedOrigin ? { action, origin: selectedOrigin } : { action };

    chrome.runtime.sendMessage(payload, (response) => {
      if (response && response.requests) {
        let content = `Fiddler Export - ${selectedOrigin || 'All Sites'}\n\n`;
        response.requests.forEach((req, i) => {
          let host = 'unknown';
          try {
            host = new URL(req.url).host;
          } catch (e) {}
          content += `--- Request #${i + 1} (${host}) ---\n`;
          content += `${req.method} ${req.url}\n`;
          content += `cURL: ${generateCurl(req)}\n\n`;
        });
        downloadContent(content, `fiddler_export_${Date.now()}.txt`);
      }
    });
  };

  exportAllFull.onclick = () => {
    chrome.runtime.sendMessage({ action: "getAllRequests" }, (response) => {
      if (response && response.requests) {
        const fullData = JSON.stringify(response.requests, null, 2);
        downloadContent(fullData, `fiddler_full_data_${Date.now()}.json`);
      }
    });
  };

  clearAllBtn.onclick = () => {
    if (confirm("Clear all captured data?")) {
      chrome.runtime.sendMessage({ action: "clearAll" }, () => {
        updateFilterOptions();
        updateList();
        detailView.innerHTML = '<div class="glass" style="height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">Select a request to see details</div>';
      });
    }
  };

  siteFilter.onchange = updateList;

  // Initial load
  updateFilterOptions();
  updateList();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "newRequest") {
      updateFilterOptions();
      updateList();
    }
  });
});
