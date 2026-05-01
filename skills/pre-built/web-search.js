'use strict';
const https = require('https');

/**
 * Web Search — DuckDuckGo HTML search with Instant Answer fallback.
 *
 * Rate-limit handling: a module-level gate enforces a minimum gap between
 * consecutive DDG HTML requests. If DDG still returns HTTP 202 (bot-detection),
 * the skill waits and retries once before falling back to the Instant Answer API.
 *
 * Configure SEARCH_API_URL + SEARCH_API_KEY in .env to use any
 * OpenAI-compatible search endpoint instead (e.g. a self-hosted SearXNG).
 */

// ── Rate limiter ─────────────────────────────────────────────────────────────
// Module-level state persists across calls within the same process.

let _lastDdgCallAt = 0;
const DDG_MIN_INTERVAL_MS = 1500; // minimum ms between DDG HTML requests

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _ddgThrottle() {
  const elapsed = Date.now() - _lastDdgCallAt;
  if (elapsed < DDG_MIN_INTERVAL_MS) {
    // Wait out the remainder plus a small random jitter to avoid predictable patterns
    await _sleep(DDG_MIN_INTERVAL_MS - elapsed + Math.floor(Math.random() * 400));
  }
  _lastDdgCallAt = Date.now();
}

module.exports = {
  name: 'web-search',
  description:
    'Search the web using DuckDuckGo and return relevant results. ' +
    'Returns titles, snippets and URLs. Works best with plain natural-language queries; ' +
    'quoted exact-match searches may be rate-limited by DuckDuckGo.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (plain natural language works best)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5, max: 10)',
      },
    },
    required: ['query'],
  },
  requiresApproval: false,

  execute: async ({ query, maxResults = 5 }) => {
    const limit = Math.min(Number(maxResults) || 5, 10);

    // Optional: custom search endpoint (e.g. SearXNG instance)
    if (process.env.SEARCH_API_URL) {
      return _customSearch(query, limit);
    }

    return _ddgSearch(query, limit);
  },
};

// ── Shared HTTPS helper ─────────────────────────────────────────────────────

function _httpsRequest({ hostname, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function _decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ── DuckDuckGo ──────────────────────────────────────────────────────────────

async function _ddgSearch(query, limit) {
  const postBody = `q=${encodeURIComponent(query)}&b=&kl=`;
  const ddgHtmlHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': String(Buffer.byteLength(postBody)),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Step 1: HTML search — broadest coverage including commercial/product queries
  try {
    // Throttle: enforce minimum gap between DDG requests
    await _ddgThrottle();

    let { status, body } = await _httpsRequest({
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: ddgHtmlHeaders,
      body: postBody,
    });

    // On 202 (rate-limited), wait and retry once before giving up on HTML search
    if (status === 202) {
      const retryDelay = 2500 + Math.floor(Math.random() * 1000);
      await _sleep(retryDelay);
      _lastDdgCallAt = Date.now();
      ({ status, body } = await _httpsRequest({
        hostname: 'html.duckduckgo.com',
        path: '/html/',
        method: 'POST',
        headers: ddgHtmlHeaders,
        body: postBody,
      }));
    }

    if (status === 200 && body.includes('result__a')) {
      const results = _parseHtmlResults(body, limit);
      if (results.length > 0) {
        return { success: true, result: { query, results, count: results.length, source: 'duckduckgo' } };
      }
    }

    // Still rate-limited after retry — fall through to Instant Answer API
  } catch (htmlErr) {
    // HTML fetch failed — fall through to Instant Answer API
  }

  // Step 2: Instant Answer API fallback (good for facts, definitions, Wikipedia)
  try {
    const { status, body } = await _httpsRequest({
      hostname: 'api.duckduckgo.com',
      path: `/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      headers: { 'User-Agent': 'AI-Agent-Builder/1.0' },
    });

    if (status === 200) {
      const data = JSON.parse(body);
      const results = [];

      if (data.AbstractText) {
        results.push({
          title: data.Heading || query,
          snippet: _decodeHtmlEntities(data.AbstractText),
          url: data.AbstractURL,
        });
      }
      for (const topic of (data.RelatedTopics || [])) {
        if (results.length >= limit) break;
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: _decodeHtmlEntities(topic.Text.split(' - ')[0] || ''),
            snippet: _decodeHtmlEntities(topic.Text),
            url: topic.FirstURL,
          });
        }
      }

      return {
        success: true,
        result: { query, results: results.slice(0, limit), count: Math.min(results.length, limit), source: 'duckduckgo' },
      };
    }
  } catch (apiErr) {
    return { success: false, error: `DuckDuckGo search failed: ${apiErr.message}` };
  }

  return { success: true, result: { query, results: [], count: 0, source: 'duckduckgo' } };
}

function _parseHtmlResults(html, limit) {
  const results = [];
  // Match result blocks: title anchor then snippet anchor
  const blockRe = /<a\s[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = blockRe.exec(html)) !== null && results.length < limit) {
    let url = match[1];
    // Decode DDG's redirect wrapper (?uddg=<encoded-url>)
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    // Skip DDG-internal navigation links
    if (!url.startsWith('http')) continue;

    const title   = _decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim());
    const snippet = _decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '').trim());
    if (!title && !snippet) continue;

    results.push({ title, snippet, url });
  }
  return results;
}

// ── Optional custom search endpoint ────────────────────────────────────────

async function _customSearch(query, limit) {
  try {
    const url = new URL(process.env.SEARCH_API_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    const headers = { 'User-Agent': 'AI-Agent-Builder/1.0', 'Accept': 'application/json' };
    if (process.env.SEARCH_API_KEY) headers['Authorization'] = `Bearer ${process.env.SEARCH_API_KEY}`;

    const { status, body } = await _httpsRequest({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers,
    });

    if (status !== 200) return { success: false, error: `Search API returned HTTP ${status}` };

    const data = JSON.parse(body);
    // SearXNG-compatible response shape
    const raw = data.results || data.web?.results || [];
    const results = raw.slice(0, limit).map(r => ({
      title:   _decodeHtmlEntities(r.title || ''),
      snippet: _decodeHtmlEntities(r.content || r.description || r.snippet || ''),
      url:     r.url || r.link || '',
    }));
    return { success: true, result: { query, results, count: results.length, source: url.hostname } };
  } catch (err) {
    return { success: false, error: `Custom search error: ${err.message}` };
  }
}
