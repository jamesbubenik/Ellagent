'use strict';
const https = require('https');
const http  = require('http');

const DEFAULT_MAX_CHARS = 8000;
const HARD_MAX_CHARS    = 20000;
const MAX_REDIRECTS     = 5;
const TIMEOUT_MS        = 15000;
// Rough byte ceiling for download — prevents huge pages from being buffered in full
const MAX_DOWNLOAD_BYTES = HARD_MAX_CHARS * 5;

module.exports = {
  name: 'web-scrape',
  description:
    'Fetch a URL and return its readable text content, stripped of HTML, scripts, and styles. ' +
    'Use after web-search to read the full content of a result page. ' +
    'Optionally focus extraction on a specific section via a tag name, id, or class hint.',
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to fetch (http or https)',
      },
      selector: {
        type: 'string',
        description:
          'Optional section hint: a tag name ("main", "article"), ' +
          'an id ("#content"), or a class (".post-body"). ' +
          'Only that section\'s text is extracted when matched.',
      },
      maxChars: {
        type: 'number',
        description: `Maximum characters to return (default: ${DEFAULT_MAX_CHARS}, max: ${HARD_MAX_CHARS})`,
      },
    },
    required: ['url'],
  },

  execute: async ({ url, selector, maxChars = DEFAULT_MAX_CHARS }) => {
    const limit = Math.min(Number(maxChars) || DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
    try {
      const { body, status, finalUrl, contentType } = await _fetchWithRedirects(url);

      if (status >= 400) {
        return { success: false, error: `HTTP ${status} fetching ${finalUrl}` };
      }

      if (contentType && !/text\//i.test(contentType) && !/application\/(xhtml|xml)/i.test(contentType)) {
        return { success: false, error: `Non-text content type: ${contentType.split(';')[0].trim()}` };
      }

      const { title, text } = _extractText(body, selector);
      const truncated = text.length > limit;
      const excerpt   = truncated ? text.slice(0, limit) : text;

      return {
        success: true,
        result: {
          url: finalUrl,
          title,
          text: excerpt,
          charCount: excerpt.length,
          ...(truncated ? { truncated: true, note: `Content truncated at ${limit} chars` } : {}),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};

// ── HTTP fetch with redirect following ───────────────────────────────────────

function _fetchWithRedirects(startUrl, hopsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => _doRequest(startUrl, hopsLeft, resolve, reject));
}

function _doRequest(url, hopsLeft, resolve, reject) {
  let parsed;
  try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

  const lib = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',  // ask for uncompressed so we can read body directly
    },
  };

  const req = lib.request(options, (res) => {
    const status      = res.statusCode;
    const location    = res.headers['location'];
    const contentType = res.headers['content-type'] || '';

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      res.resume();
      if (hopsLeft <= 0) return reject(new Error('Too many redirects'));
      const next = location.startsWith('http') ? location : new URL(location, url).href;
      return _doRequest(next, hopsLeft - 1, resolve, reject);
    }

    const chunks = [];
    let downloaded = 0;

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (downloaded <= MAX_DOWNLOAD_BYTES) chunks.push(chunk);
    });

    res.on('end', () => {
      resolve({ status, finalUrl: url, contentType, body: Buffer.concat(chunks).toString('utf8') });
    });

    res.on('error', reject);
  });

  req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
  req.on('error', reject);
  req.end();
}

// ── Text extraction ───────────────────────────────────────────────────────────

function _extractText(html, selector) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title      = titleMatch ? _decodeEntities(titleMatch[1]).trim() : '';

  let section = null;

  // 1. Try caller-supplied selector
  if (selector) {
    section = _extractSection(html, selector.trim());
  }

  // 2. Fall back through semantic landmarks
  if (!section) section = _extractTag(html, 'main');
  if (!section) section = _extractTag(html, 'article');
  if (!section) section = _extractTag(html, 'body');
  if (!section) section = html;

  // 3. Strip noise
  section = section
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form|figure|figcaption|picture|svg|canvas|iframe|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // 4. Convert block boundaries to newlines before stripping tags
  section = section
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6]|td|th|tr|section|blockquote|pre|address)[^>]*>/gi, '\n');

  // 5. Strip remaining tags
  section = section.replace(/<[^>]+>/g, ' ');

  // 6. Decode entities and normalise whitespace
  section = _decodeEntities(section)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: section };
}

// Extract content of the first matching tag using a depth counter (handles nesting)
function _extractTag(html, tag) {
  const idx = _indexOfOpenTag(html, tag, 0);
  if (idx === -1) return null;
  const afterOpen = html.indexOf('>', idx) + 1;
  return _sliceUntilClose(html, tag, afterOpen);
}

// Extract a section identified by a tag/id/class selector string
function _extractSection(html, hint) {
  let searchIdx = -1;
  let tagName   = null;

  if (hint.startsWith('#')) {
    const id  = _escRe(hint.slice(1));
    const re  = new RegExp(`<([a-z][a-z0-9]*)[^>]+id=["']${id}["'][^>]*>`, 'i');
    const m   = re.exec(html);
    if (!m) return null;
    tagName   = m[1].toLowerCase();
    searchIdx = m.index + m[0].length;
  } else if (hint.startsWith('.')) {
    const cls = _escRe(hint.slice(1));
    const re  = new RegExp(`<([a-z][a-z0-9]*)[^>]+class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`, 'i');
    const m   = re.exec(html);
    if (!m) return null;
    tagName   = m[1].toLowerCase();
    searchIdx = m.index + m[0].length;
  } else {
    tagName = hint.toLowerCase();
    const idx = _indexOfOpenTag(html, tagName, 0);
    if (idx === -1) return null;
    searchIdx = html.indexOf('>', idx) + 1;
  }

  return _sliceUntilClose(html, tagName, searchIdx);
}

// Find the character index of the next valid opening tag for `tag` at or after `from`
function _indexOfOpenTag(html, tag, from) {
  const needle = '<' + tag;
  let i = from;
  while (true) {
    const pos = html.indexOf(needle, i);
    if (pos === -1) return -1;
    const c = html[pos + needle.length];
    if (c === '>' || c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '/') return pos;
    i = pos + needle.length; // skip false match like <tables>
  }
}

// Slice the content between the already-consumed open tag (starts at `from`) and its matching close
function _sliceUntilClose(html, tag, from) {
  const closeTag = '</' + tag + '>';
  let depth = 1;
  let i     = from;

  while (depth > 0) {
    const nextClose = html.indexOf(closeTag, i);
    if (nextClose === -1) return html.slice(from); // no close tag — return everything

    const nextOpen = _indexOfOpenTag(html, tag, i);

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + tag.length + 1; // advance past the re-entrant open tag
    } else {
      depth--;
      if (depth === 0) return html.slice(from, nextClose);
      i = nextClose + closeTag.length;
    }
  }

  return html.slice(from, i);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g,    (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function _escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
