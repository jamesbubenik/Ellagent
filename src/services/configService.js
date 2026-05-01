'use strict';
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');

const DEFAULTS = {
  baseUrl:             'http://localhost:1234/v1',
  apiKey:              'lm-studio',
  model:               'local-model',
  timeoutMs:           120000,
  contextWindow:       4096,
  maxToolCallDepth:    5,
  logLevel:            'info',
  evalBatchSize:       null,
  flashAttention:      null,
  numExperts:          null,
  offloadKvCacheToGpu: null,
  mcpServers:          [],
};

// In-memory cache — loaded once at startup, updated on save
let _cache = null;

function _load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function getConfig() {
  if (!_cache) _cache = _load();
  return _cache;
}

function saveConfig(updates) {
  const next = { ...getConfig(), ...updates };
  // Validate/normalise
  if (!next.baseUrl || typeof next.baseUrl !== 'string') next.baseUrl = DEFAULTS.baseUrl;
  next.baseUrl = next.baseUrl.replace(/\/+$/, ''); // strip trailing slash
  if (!next.model || typeof next.model !== 'string') next.model = DEFAULTS.model;
  next.timeoutMs        = Number(next.timeoutMs)     || DEFAULTS.timeoutMs;
  next.contextWindow    = Math.max(512, Number(next.contextWindow) || DEFAULTS.contextWindow);
  const mtcd = parseInt(next.maxToolCallDepth, 10);
  next.maxToolCallDepth = mtcd > 0 ? Math.min(mtcd, 50) : DEFAULTS.maxToolCallDepth;
  const validLevels = ['off', 'error', 'info', 'debug'];
  next.logLevel = validLevels.includes(next.logLevel) ? next.logLevel : DEFAULTS.logLevel;

  // Optional model load params — null means "let LM Studio decide"
  const evalBs = parseInt(next.evalBatchSize, 10);
  next.evalBatchSize = evalBs > 0 ? evalBs : null;
  next.flashAttention      = next.flashAttention === true || next.flashAttention === 'true'   ? true
                           : next.flashAttention === false || next.flashAttention === 'false' ? false
                           : null;
  const ne = parseInt(next.numExperts, 10);
  next.numExperts = ne > 0 ? ne : null;
  next.offloadKvCacheToGpu = next.offloadKvCacheToGpu === true || next.offloadKvCacheToGpu === 'true'   ? true
                           : next.offloadKvCacheToGpu === false || next.offloadKvCacheToGpu === 'false' ? false
                           : null;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8');
  _cache = next;
  return next;
}

function getMcpServers() {
  return [...(getConfig().mcpServers || [])];
}

function saveMcpServers(servers) {
  if (!Array.isArray(servers)) throw new Error('mcpServers must be an array');
  const cfg = getConfig();
  const next = { ...cfg, mcpServers: servers };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8');
  _cache = next;
  return next.mcpServers;
}

module.exports = { getConfig, saveConfig, getMcpServers, saveMcpServers, DEFAULTS };
