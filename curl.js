// cURL command generation, ported from Chrome DevTools'
// NetworkLogView.generateCurlCommand (front_end/panels/network/NetworkLogView.ts,
// Copyright The Chromium Authors, BSD-3-Clause) so "Copy as cURL" here produces
// the same command DevTools would, including its quoting rules.
//
// A captured record provides: url, method, headers ({name: value}), postData.

const ALLOWED_SCHEMES = new Set([ 'http:', 'https:', 'ws:', 'wss:', 'data:' ]);

function escapeStringWin(str) {
  // Order matters; see the DevTools source for the cmd.exe / MS CRT rationale.
  const encapsChars = '^"';
  return encapsChars +
      str.replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/[^a-zA-Z0-9\s_\-:=+~'\/.',?;*]/g, '^$&')
          .replace(/%(?=[a-zA-Z0-9_])/g, '%^')
          .replace(/[^ -~\r\n]/g, ' ')
          .replace(/\r?\n|\r/g, '^\n\n') +
      encapsChars;
}

function escapeStringPosix(str) {
  const escapeCharacter = x => '\\u' + x.charCodeAt(0).toString(16).padStart(4, '0');
  if (/[\0-\x1F\x7F-\x9F!]|'/.test(str)) {
    // ANSI-C quoting.
    return '$\'' +
        str.replace(/\\/g, '\\\\')
            .replace(/'/g, '\\\'')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/[\0-\x1F\x7F-\x9F!]/g, escapeCharacter) +
        '\'';
  }
  return '\'' + str + '\'';
}

/**
 * @param {{url:string, method:string, headers?:Object<string,string>, postData?:string}} req
 * @param {'unix'|'win'} platform
 * @returns {string|null} null when the URL scheme cannot be expressed as cURL
 */
export function generateCurl(req, platform = 'unix') {
  let valid = false;
  try { valid = ALLOWED_SCHEMES.has(new URL(req.url).protocol); } catch { valid = false; }
  if (!valid) { return null; }

  const escapeString = platform === 'win' ? escapeStringWin : escapeStringPosix;
  // Derived from the URL and added by cURL itself; Accept-Encoding is dropped to
  // avoid decompression errors (crbug.com/1015321).
  const ignoredHeaders = new Set([ 'accept-encoding', 'host', 'method', 'path', 'scheme', 'version', 'authority', 'protocol' ]);

  let command = [];
  command.push('--url ' + escapeString(req.url).replace(/[[{}\]]/g, '\\$&'));

  let inferredMethod = 'GET';
  const data = [];
  if (typeof req.postData === 'string' && req.postData !== '') {
    data.push('--data-raw ' + escapeString(req.postData));
    ignoredHeaders.add('content-length');
    inferredMethod = 'POST';
  }
  if (req.method !== inferredMethod) {
    command.push('-X ' + escapeString(req.method));
  }

  for (const [ rawName, rawValue ] of Object.entries(req.headers || {})) {
    const name = rawName.replace(/^:/, '');
    if (ignoredHeaders.has(name.toLowerCase())) { continue; }
    const value = String(rawValue);
    if (!value.trim()) {
      command.push('-H ' + escapeString(name + ';'));
    } else if (name.toLowerCase() === 'cookie' && value.includes('=')) {
      command.push('-b ' + escapeString(value));
    } else {
      command.push('-H ' + escapeString(name + ': ' + value));
    }
  }
  command = command.concat(data);
  return 'curl ' + command.join(command.length >= 3 ? (platform === 'win' ? ' ^\n  ' : ' \\\n  ') : ' ');
}
