# Chrome Fiddler

A Manifest V3 Chrome extension that captures a site's network traffic through
the `chrome.debugger` (Chrome DevTools Protocol) API and turns requests into
ready-to-run cURL commands.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.

Requires Chrome 121 or newer.

## Use

- **Popup** → **START CAPTURE** records every tab on the current site (origin).
  Chrome shows its "started debugging this browser" bar while capture is on.
- Each captured request has **Copy as cURL**; **⬇ DL** downloads all of the
  site's requests as cURL commands.
- **↗ Dash** opens the dashboard: filter by site, view request and response
  headers, payload and response body, copy cURL for bash or Windows cmd, or
  export everything as JSON.
- **STOP CAPTURE** detaches and deletes that site's captures. Captures are also
  cleared when the browser starts and every 4 hours.

## What is captured

Captured the same way Chrome DevTools does it:

- The headers **actually sent**, including `Cookie` (from
  `Network.requestWillBeSentExtraInfo`), not just the provisional ones.
- Request bodies, including ones over 64 KB (`Network.getRequestPostData`).
- Every redirect hop as its own entry.
- Response bodies up to 10 MB, read after the response has finished loading.

"Copy as cURL" uses DevTools' own escaping rules, so values containing quotes,
`!`, `$`, backticks or newlines produce a command that runs as captured.

## Limits

- `chrome.debugger.attach` is asynchronous and Chrome does not hold a navigation
  for it. In a tab opened directly onto a captured site, the page's own document
  request and fetches issued in its first moments can precede the attach and go
  unrecorded; later requests in that tab are captured.
- Only one debugger client can own some operations; if DevTools or another
  extension is debugging the same tab, attaching can fail.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Capture network traffic through the DevTools Protocol |
| `tabs` | Find the tabs of the captured site and their URLs |
| `storage` | Remember which sites are being captured |
| `alarms` | Periodic cleanup of stored captures |

Captured data stays in the extension's IndexedDB on your machine.
