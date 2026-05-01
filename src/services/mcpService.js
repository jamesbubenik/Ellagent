'use strict';
const { spawn } = require('child_process');
const https = require('https');
const http  = require('http');
const { appLog } = require('../utils/logger');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS   = 30_000;

// Cache expanded meta-tool schemas per server URL so that subsequent session
// starts for the same HTTP MCP server are instant (TOOL_LIST + N×TOOL_GET only runs once).
const _metaToolCache = new Map(); // url → { tools, virtualToolEntries }

// ── SSE line parser ───────────────────────────────────────────────────────────
// Parses the Server-Sent Events wire format into (type, data) events.

class SseLineParser {
  constructor(onEvent) {
    this._buf  = '';
    this._type = 'message';
    this._data = [];
    this._cb   = onEvent;
  }

  feed(text) {
    this._buf += text;
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).replace(/\r$/, '');
      this._buf  = this._buf.slice(nl + 1);
      this._processLine(line);
    }
  }

  // Call when the stream ends to dispatch any event whose trailing blank line never arrived.
  flush() {
    if (this._data.length > 0) {
      this._cb(this._type, this._data.join('\n'));
      this._type = 'message';
      this._data = [];
    }
  }

  _processLine(line) {
    if (line === '') {
      if (this._data.length > 0) {
        this._cb(this._type, this._data.join('\n'));
        this._type = 'message';
        this._data = [];
      }
    } else if (line.startsWith('event:')) {
      this._type = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      this._data.push(line.slice(5).trimStart());
    }
    // ignore id:, retry:
  }
}

// ── McpClient — stdio transport ───────────────────────────────────────────────

class McpClient {
  constructor(serverConfig) {
    this.config = serverConfig;
    this.name   = serverConfig.name;
    this.tools  = [];
    this._proc  = null;
    this._pending = new Map();
    this._id    = 1;
    this._buf   = '';
  }

  async connect() {
    await this._spawnProcess();
    await this._handshake();
    this.tools = await this._listTools();
  }

  _spawnProcess() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {}, cwd } = this.config;
      if (!command) return reject(new Error(`MCP server "${this.name}" missing command`));

      // shell: true is required on Windows so that .cmd/.bat launchers (npx, uvx, python, etc.)
      // are resolved correctly. Without it, spawn('npx', ...) fails with ENOENT on Windows.
      this._proc = spawn(command, args, {
        env:   { ...process.env, ...env },
        cwd:   cwd || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });

      this._proc.stderr.on('data', data => {
        appLog.debug('mcp_stderr', { server: this.name, text: data.toString().trim().slice(0, 300) });
      });

      this._proc.stdout.on('data', data => {
        this._buf += data.toString();
        let nl;
        while ((nl = this._buf.indexOf('\n')) !== -1) {
          const line = this._buf.slice(0, nl).trim();
          this._buf  = this._buf.slice(nl + 1);
          if (line) this._onLine(line);
        }
      });

      // Reject all pending requests immediately when the process exits unexpectedly,
      // instead of waiting 30 s for each request to time out individually.
      this._proc.on('exit', (code, signal) => {
        if (this._pending.size > 0) {
          this._rejectAll(new Error(`MCP server "${this.name}" exited (code=${code ?? signal})`));
        }
      });

      this._proc.on('error', err => { this._rejectAll(err); reject(err); });
      this._proc.on('spawn', resolve);
    });
  }

  _send(msg) {
    if (!this._proc?.stdin.writable) return;
    try { this._proc.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  _request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id    = this._id++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP timeout: ${method} on "${this.name}"`));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _notify(method, params = {}) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    this._pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }

  _rejectAll(err) {
    for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(err); }
    this._pending.clear();
  }

  async _handshake() {
    await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities:   { tools: {} },
      clientInfo:     { name: 'ai-agent-builder', version: '1.0.0' },
    });
    this._notify('notifications/initialized');
  }

  async _listTools() {
    const result = await this._request('tools/list');
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    const result = await this._request('tools/call', { name, arguments: args });
    return _mcpResultToSkillResult(result);
  }

  disconnect() {
    this._rejectAll(new Error(`MCP client "${this.name}" disconnected`));
    if (this._proc) {
      try { this._proc.stdin.end(); } catch {}
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }
  }
}

// ── McpHttpClient — HTTP and SSE transports ────────────────────────────────────
// transport: 'http'  → streamable HTTP (POST to a single URL, 2025-03-26 spec)
// transport: 'sse'   → HTTP+SSE (GET /sse to open stream, POST /message per request, 2024-11-05 spec)

class McpHttpClient {
  constructor(serverConfig) {
    this.config      = serverConfig;
    this.name        = serverConfig.name;
    this.tools       = [];
    this._transport  = serverConfig.transport || 'http'; // 'http' | 'sse'
    this._id         = 1;
    this._pending    = new Map();
    this._sessionId  = null;
    // SSE-specific
    this._sseReq     = null;
    this._ssePostUrl = null;
  }

  async connect() {
    if (this._transport === 'sse') await this._connectSse();
    await this._handshake();
    const rawTools = await this._listTools();

    // Detect meta-tool pattern (TOOL_LIST + TOOL_CALL).
    // Pre-expand into individual virtual tools so the LLM sees direct tool entries
    // instead of a 3-step discovery workflow it cannot reliably navigate.
    const upperNames = rawTools.map(t => t.name.toUpperCase());
    if (upperNames.includes('TOOL_LIST') && upperNames.includes('TOOL_CALL')) {
      this.tools = await this._expandMetaTools(rawTools);
    } else {
      this.tools = rawTools;
    }
  }

  // ── Meta-tool pre-expansion ────────────────────────────────────────────────
  async _expandMetaTools(rawTools) {
    // Return cached expansion if available — avoids re-running TOOL_LIST + N×TOOL_GET on every session start
    const cacheKey = this.config.url;
    if (cacheKey && _metaToolCache.has(cacheKey)) {
      const cached = _metaToolCache.get(cacheKey);
      this._virtualToolMap = new Map(cached.virtualToolEntries);
      appLog.info('mcp_meta_cache_hit', { server: this.name, toolCount: cached.tools.length });
      return cached.tools;
    }

    const listDef = rawTools.find(t => t.name.toUpperCase() === 'TOOL_LIST');
    const getDef  = rawTools.find(t => t.name.toUpperCase() === 'TOOL_GET');
    const callDef = rawTools.find(t => t.name.toUpperCase() === 'TOOL_CALL');

    // Determine the argument key names from TOOL_CALL's own schema
    const callProps = callDef?.inputSchema?.properties || callDef?.parameters?.properties || {};
    const nameProp  = callProps.name          ? 'name'
                    : callProps.tool_name     ? 'tool_name'
                    : callProps.function      ? 'function'
                    : callProps.function_name ? 'function_name'
                    : 'tool_name'; // common default for Python MCP servers
    const argsProp  = callProps.arguments      ? 'arguments'
                    : callProps.tool_arguments ? 'tool_arguments'
                    : callProps.parameters     ? 'parameters'
                    : callProps.args           ? 'args'
                    : callProps.kwargs         ? 'kwargs'
                    : 'arguments';
    // Some Python MCP servers declare the args field as type:"string" meaning they
    // expect a JSON-serialised string, not an object. Detect this so callTool can stringify.
    const argsIsString = callProps[argsProp]?.type === 'string';
    appLog.debug('mcp_meta_call_schema', { server: this.name, rawSchema: JSON.stringify(callDef?.inputSchema || callDef?.parameters || {}), callProps: Object.keys(callProps), nameProp, argsProp, argsIsString });

    // Step 1: get the list of function names (+descriptions where the list provides them)
    let fnEntries = []; // [{ name, description }] or plain strings
    try {
      const r = await this._request('tools/call', { name: listDef.name, arguments: {} });
      const text = (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      appLog.debug('mcp_meta_list_raw', { server: this.name, textSlice: text.slice(0, 300) });
      fnEntries = _parseMetaToolList(text);
      appLog.info('mcp_meta_list', { server: this.name, count: fnEntries.length, fns: fnEntries.slice(0, 15).map(e => (typeof e === 'string' ? e : e.name)) });
    } catch (err) {
      appLog.warn('mcp_meta_list_failed', { server: this.name, error: err.message });
      return rawTools;
    }

    if (fnEntries.length === 0) {
      appLog.warn('mcp_meta_no_fns', { server: this.name });
      return rawTools;
    }

    // Step 2: fetch schema for each function concurrently via TOOL_GET
    this._virtualToolMap = new Map(); // fnName → { toolCallName, nameProp, argsProp, argsIsString }

    const schemaFetches = fnEntries.map(async entry => {
      const fn             = typeof entry === 'string' ? entry : entry.name;
      const listDesc       = typeof entry === 'string' ? ''   : (entry.description || '');
      let schema           = { type: 'object', properties: {} };
      let description      = listDesc || fn; // use list description as fallback
      if (getDef) {
        try {
          const r = await this._request('tools/call', { name: getDef.name, arguments: { tool_name: fn } });
          const text = (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
          const parsed = _parseMetaToolGet(text, fn);
          schema = parsed.schema;
          // TOOL_GET description wins only if non-trivial (longer than the fn name itself)
          if (parsed.description && parsed.description.length > fn.length) {
            description = parsed.description;
          }
        } catch (err) {
          appLog.debug('mcp_meta_get_failed', { server: this.name, fn, error: err.message });
        }
      }
      this._virtualToolMap.set(fn, { toolCallName: callDef.name, nameProp, argsProp, argsIsString });
      return { name: fn, description, inputSchema: schema };
    });

    const settled = await Promise.allSettled(schemaFetches);
    const virtualTools = settled
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    appLog.info('mcp_meta_expanded', {
      server: this.name,
      virtualCount: virtualTools.length,
      fns: virtualTools.map(t => t.name),
    });

    const result = virtualTools.length > 0 ? virtualTools : rawTools;

    // Populate cache so the next session start is instant
    if (cacheKey && virtualTools.length > 0) {
      _metaToolCache.set(cacheKey, {
        tools:             result,
        virtualToolEntries: [...this._virtualToolMap.entries()],
      });
    }

    return result;
  }

  // ── SSE connection (2024-11-05) ────────────────────────────────────────────
  _connectSse() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.url);
      const lib = url.protocol === 'https:' ? https : http;
      let resolved = false;

      this._sseReq = lib.request({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache', ...this._authHeaders() },
      }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`SSE connect failed HTTP ${res.statusCode} at ${this.config.url}`));
        }

        const parser = new SseLineParser((type, data) => {
          if (type === 'endpoint' && !resolved) {
            this._ssePostUrl = data.startsWith('http') ? data : new URL(data, url.origin).href;
            resolved = true;
            resolve();
          } else if (type === 'message') {
            this._dispatchResponse(data);
          }
        });

        res.on('data',  chunk => parser.feed(chunk.toString()));
        res.on('end',   () => this._rejectAll(new Error(`SSE stream closed for "${this.name}"`)));
        res.on('error', err => { if (!resolved) reject(err); else this._rejectAll(err); });
      });

      this._sseReq.setTimeout(15_000, () => {
        if (!resolved) reject(new Error(`SSE connection timed out for "${this.name}"`));
      });
      this._sseReq.on('error', err => { if (!resolved) reject(err); });
      this._sseReq.end();
    });
  }

  // ── Request / Notify ───────────────────────────────────────────────────────
  _request(method, params = {}) {
    const id   = this._id++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP HTTP timeout: ${method} on "${this.name}"`));
      }, REQUEST_TIMEOUT_MS);

      if (this._transport === 'sse') {
        this._pending.set(id, { resolve, reject, timer });
        this._ssePost(body).catch(err => {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(err);
        });
      } else {
        this._httpPost(body, id, resolve, reject, timer);
      }
    });
  }

  _notify(method, params = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params }); // no id
    const post = this._transport === 'sse' ? this._ssePost(body) : this._httpFireAndForget(body);
    post.catch(() => {});
  }

  // ── Streamable HTTP POST (2025-03-26) ──────────────────────────────────────
  _httpPost(body, id, resolve, reject, timer) {
    const url = new URL(this.config.url);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json, text/event-stream',
        'Content-Length': String(Buffer.byteLength(body)),
        ...(this._sessionId ? { 'Mcp-Session-Id': this._sessionId } : {}),
        ...this._authHeaders(),
      },
    }, (res) => {
      if (res.headers['mcp-session-id']) this._sessionId = res.headers['mcp-session-id'];

      if (res.statusCode !== 200) {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          clearTimeout(timer);
          // Many MCP servers return 4xx/5xx with a valid JSON-RPC error body.
          // Parse it properly so the caller gets the application-level message,
          // not a truncated HTTP dump.
          try {
            const msg = JSON.parse(raw);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              return;
            }
          } catch {}
          reject(new Error(`HTTP ${res.statusCode} from "${this.name}": ${raw.slice(0, 500)}`));
        });
        return;
      }

      const ct = res.headers['content-type'] || '';
      if (ct.includes('text/event-stream')) {
        // Server chose to stream the response via SSE (streaming mode)
        const parser = new SseLineParser((type, data) => {
          if (type === 'message') {
            try {
              const msg = JSON.parse(data);
              if (msg.id === id) {
                clearTimeout(timer);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
              }
            } catch {}
          }
        });
        res.on('data',  chunk => parser.feed(chunk.toString()));
        res.on('end',   () => { parser.flush(); clearTimeout(timer); reject(new Error('SSE response closed without result')); });
        res.on('error', err  => { clearTimeout(timer); reject(err); });
      } else {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const msg = JSON.parse(raw);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          } catch { reject(new Error(`Non-JSON response from "${this.name}": ${raw.slice(0, 200)}`)); }
        });
        res.on('error', err => { clearTimeout(timer); reject(err); });
      }
    });

    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.write(body);
    req.end();
  }

  // Fire-and-forget POST (for streamable HTTP notifications)
  _httpFireAndForget(body) {
    return new Promise(resolve => {
      const url = new URL(this.config.url);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          ...(this._sessionId ? { 'Mcp-Session-Id': this._sessionId } : {}),
          ...this._authHeaders(),
        },
      }, res => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  }

  // POST to SSE-discovered endpoint (response arrives via SSE stream)
  _ssePost(body) {
    if (!this._ssePostUrl) return Promise.reject(new Error('SSE endpoint not established'));
    return new Promise((resolve, reject) => {
      const url = new URL(this._ssePostUrl);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          ...this._authHeaders(),
        },
      }, res => { res.resume(); resolve(); }); // actual response arrives via SSE stream
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Protocol ───────────────────────────────────────────────────────────────
  async _handshake() {
    await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities:   { tools: {} },
      clientInfo:     { name: 'ai-agent-builder', version: '1.0.0' },
    });
    this._notify('notifications/initialized');
  }

  async _listTools() {
    const result = await this._request('tools/list');
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    // If this is a virtual tool (expanded from a meta-tool pattern), redirect to TOOL_CALL
    const virt = this._virtualToolMap?.get(name);
    if (virt) {
      // When the TOOL_CALL schema declares the args field as type:"string", the Python
      // server expects a JSON-serialised string rather than a plain object.
      const argValue = virt.argsIsString ? JSON.stringify(args) : args;
      const callArgs = { [virt.nameProp]: name, [virt.argsProp]: argValue };
      const result = await this._request('tools/call', { name: virt.toolCallName, arguments: callArgs });
      return _mcpResultToSkillResult(result);
    }
    const result = await this._request('tools/call', { name, arguments: args });
    return _mcpResultToSkillResult(result);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  _authHeaders() {
    if (this.config.token) return { Authorization: `Bearer ${this.config.token}` };
    return {};
  }

  _dispatchResponse(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id == null) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    this._pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }

  _rejectAll(err) {
    for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(err); }
    this._pending.clear();
  }

  disconnect() {
    this._rejectAll(new Error(`MCP client "${this.name}" disconnected`));
    if (this._sseReq) { try { this._sseReq.destroy(); } catch {} this._sseReq = null; }
  }
}

// ── Meta-tool parsing helpers ──────────────────────────────────────────────────

/**
 * Parse the TOOL_LIST response into an array of { name, description? } objects.
 * Returns plain strings only when no description is available.
 */
function _parseMetaToolList(text) {
  // Python-style list of dicts: [{'name': 'GLOBAL_QUOTE', 'description': '...'}, ...]
  // Try to extract both name and description in one pass.
  const pyEntryRe = /\{'name'\s*:\s*'([^']+)'(?:[^}]*?'description'\s*:\s*'([^']*)')?[^}]*?\}/g;
  const pyEntries = [...text.matchAll(pyEntryRe)].map(m => ({ name: m[1], description: m[2] || '' }));
  if (pyEntries.length > 0) return pyEntries;

  // Double-quoted JSON objects in a list: [{"name": "...", "description": "..."}, ...]
  const jsonEntryRe = /\{"name"\s*:\s*"([^"]+)"(?:[^}]*?"description"\s*:\s*"([^"]*)")?[^}]*?\}/g;
  const jsonEntries = [...text.matchAll(jsonEntryRe)].map(m => ({ name: m[1], description: m[2] || '' }));
  if (jsonEntries.length > 0) return jsonEntries;

  // Try straight JSON array
  try {
    const p = JSON.parse(text);
    const arr = Array.isArray(p) ? p : (p?.tools || p?.functions || p?.items);
    if (Array.isArray(arr)) {
      if (arr.length > 0 && typeof arr[0] === 'object') {
        return arr.map(e => ({ name: String(e.name || e), description: e.description || '' })).filter(e => e.name);
      }
      return arr.map(String).filter(Boolean);
    }
  } catch {}

  // Comma-separated list of identifiers
  if (text.includes(',')) {
    const parts = text.split(',').map(s => s.trim()).filter(s => /^[A-Za-z][A-Za-z0-9_]*$/.test(s));
    if (parts.length > 0) return parts;
  }

  // Newline-separated ALL_CAPS_UNDERSCORE tokens
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const caps  = lines.filter(l => /^[A-Z][A-Z0-9_]{2,}$/.test(l));
  return caps.length > 0 ? caps : lines;
}

function _pyDictToJson(text) {
  // Best-effort conversion of Python repr → JSON so we can JSON.parse it.
  // Handles: single quotes, True/False/None, trailing commas.
  return text
    .replace(/'/g, '"')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/,\s*([}\]])/g, '$1'); // trailing commas
}

function _parseMetaToolGet(text, fnName) {
  // Try JSON first, then Python-repr conversion
  for (const candidate of [text, _pyDictToJson(text)]) {
    try {
      const p = JSON.parse(candidate);
      if (p && typeof p === 'object') {
        const schema = p.parameters || p.inputSchema || p.schema || {
          type: 'object', properties: p.properties || {}, required: p.required || [],
        };
        return { schema, description: p.description || fnName };
      }
    } catch {}
  }
  // Return minimal schema — description is whatever text we got
  return { schema: { type: 'object', properties: {} }, description: text.slice(0, 300) || fnName };
}

// ── Shared result normaliser ───────────────────────────────────────────────────

function _mcpResultToSkillResult(result) {
  const textContent = (result?.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n')
    .trim();
  if (result?.isError) return { success: false, error: textContent || 'MCP tool returned an error', result: null };
  return { success: true, result: textContent || result };
}

// ── Session-level helpers ──────────────────────────────────────────────────────

function _createClient(cfg) {
  if (cfg.url) return new McpHttpClient(cfg);
  return new McpClient(cfg);
}

/**
 * Connect all MCP servers configured for an agent manifest.
 * Failed connections are logged but do not abort session start.
 *
 * Returns:
 *   clients — Map<serverName, McpClient|McpHttpClient>
 *   tools   — Map<toolName, { client, serverName, def, requiresApproval }>
 *   errors  — Array<{ server, error }> for connections that failed
 */
async function connectAgentMcp(mcpServers = []) {
  const clients = new Map();
  const tools   = new Map();
  const errors  = [];

  for (const cfg of mcpServers) {
    if (!cfg?.name) continue;
    try {
      const client = _createClient(cfg);
      await client.connect();
      clients.set(cfg.name, client);

      for (const tool of client.tools) {
        tools.set(tool.name, {
          client,
          serverName:       cfg.name,
          def:              tool,
          requiresApproval: cfg.requiresApproval !== false,
        });
      }

      appLog.info('mcp_connected', {
        server:    cfg.name,
        transport: cfg.url ? (cfg.transport || 'http') : 'stdio',
        toolCount: client.tools.length,
        tools:     client.tools.map(t => t.name),
      });
    } catch (err) {
      appLog.warn('mcp_connect_failed', { server: cfg.name, error: err.message });
      errors.push({ server: cfg.name, error: err.message });
    }
  }

  return { clients, tools, errors };
}

/**
 * Disconnect all MCP clients held by a session.
 */
function disconnectAgentMcp(clients = new Map()) {
  for (const [name, client] of clients) {
    try { client.disconnect(); } catch {}
    appLog.info('mcp_disconnected', { server: name });
  }
}

function clearMetaToolCache() { _metaToolCache.clear(); }

module.exports = { McpClient, McpHttpClient, connectAgentMcp, disconnectAgentMcp, clearMetaToolCache };
