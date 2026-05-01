'use strict';
const router = require('express').Router();
const { getConfig, saveConfig, getMcpServers, saveMcpServers } = require('../services/configService');
const { checkHealth, loadModel } = require('../services/llmService');
const { clearMetaToolCache } = require('../services/mcpService');
const { appLog } = require('../utils/logger');

// GET /api/config — return current config (api key masked)
router.get('/', (req, res) => {
  const cfg = getConfig();
  res.json({
    baseUrl:             cfg.baseUrl,
    apiKey:              cfg.apiKey ? '••••••••' : '',
    apiKeySet:           !!cfg.apiKey,
    model:               cfg.model,
    timeoutMs:           cfg.timeoutMs,
    contextWindow:       cfg.contextWindow,
    maxToolCallDepth:    cfg.maxToolCallDepth,
    logLevel:            cfg.logLevel,
    evalBatchSize:       cfg.evalBatchSize,
    flashAttention:      cfg.flashAttention,
    numExperts:          cfg.numExperts,
    offloadKvCacheToGpu: cfg.offloadKvCacheToGpu,
  });
});

// GET /api/config/raw-key — return actual key (for pre-filling the input)
router.get('/raw-key', (req, res) => {
  res.json({ apiKey: getConfig().apiKey || '' });
});

// POST /api/config — save new config, reloading the model when load params change
router.post('/', async (req, res) => {
  const { baseUrl, apiKey, model, timeoutMs, contextWindow, maxToolCallDepth, logLevel,
          evalBatchSize, flashAttention, numExperts, offloadKvCacheToGpu } = req.body;
  const old = getConfig();

  let saved;
  try {
    saved = saveConfig({ baseUrl, apiKey, model, timeoutMs, contextWindow, maxToolCallDepth, logLevel,
                         evalBatchSize, flashAttention, numExperts, offloadKvCacheToGpu });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }

  // Reload when any load-affecting param changes
  const loadKeys = ['model', 'contextWindow', 'evalBatchSize', 'flashAttention', 'numExperts', 'offloadKvCacheToGpu'];
  const modelChanged  = saved.model && saved.model !== old.model;
  const shouldReload  = loadKeys.some(k => saved[k] !== old[k]);

  let ejected = false, ejectError = null;

  if (shouldReload) {
    // Eject the current model whenever we're reloading — same model needs to be
    // unloaded and reloaded for the new settings (context length, etc.) to take effect
    if (old.model) {
      const result = await _ejectModel(old.model, saved.baseUrl, saved.apiKey);
      ejected    = result.ok;
      ejectError = result.error || null;
      if (ejected) appLog.info('model_ejected', { model: old.model });
      else         appLog.warn('model_eject_failed', { model: old.model, error: ejectError });
    }

    loadModel(saved).then(r => {
      if (r.ok) appLog.info('model_loaded', { model: saved.model, contextLength: r.contextLength ?? saved.contextWindow, loadTimeSec: r.loadTime });
      else      appLog.warn('model_load_failed', { model: saved.model, error: r.error });
    });
  }

  appLog.info('config_saved', { baseUrl: saved.baseUrl, model: saved.model, logLevel: saved.logLevel, reload: shouldReload });
  res.json({ ok: true, baseUrl: saved.baseUrl, model: saved.model, timeoutMs: saved.timeoutMs,
             contextWindow: saved.contextWindow, ejected, ejectError, loading: shouldReload });
});

/**
 * Ask LM Studio to unload a model instance.
 * Returns { ok, error? }.
 */
async function _ejectModel(modelId, baseUrl, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // LM Studio 0.4.0+ — POST /api/v1/models/unload
    const r = await fetch(`${baseUrl.replace(/\/v1$/, '')}/api/v1/models/unload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || 'lm-studio'}`,
      },
      signal: controller.signal,
      body: JSON.stringify({ instance_id: modelId }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${text ? ': ' + text.slice(0, 120) : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Global MCP Server CRUD ───────────────────────────────────────────────────

// GET /api/config/mcp-servers
router.get('/mcp-servers', (req, res) => {
  res.json({ mcpServers: getMcpServers() });
});

// POST /api/config/mcp-servers — replace entire list
router.post('/mcp-servers', (req, res) => {
  const { mcpServers } = req.body;
  if (!Array.isArray(mcpServers)) {
    return res.status(400).json({ ok: false, error: 'mcpServers must be an array' });
  }
  // Validate each server has at minimum a name
  for (const srv of mcpServers) {
    if (!srv.name || typeof srv.name !== 'string') {
      return res.status(400).json({ ok: false, error: 'Each MCP server must have a name' });
    }
  }
  try {
    const saved = saveMcpServers(mcpServers);
    clearMetaToolCache(); // force schema re-fetch on next session start
    appLog.info('mcp_servers_saved', { count: saved.length });
    res.json({ ok: true, mcpServers: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/config/models — list models available in LM Studio right now
router.get('/models', async (req, res) => {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${cfg.baseUrl}/models`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey || 'lm-studio'}` },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`LM Studio returned ${r.status}`);
    const data = await r.json();
    const models = (data.data || []).map(m => m.id).filter(Boolean);
    res.json({ ok: true, models });
  } catch (err) {
    res.json({ ok: false, models: [], error: err.message });
  } finally {
    clearTimeout(timer);
  }
});

// GET /api/config/test — test the current LM Studio connection
router.get('/test', async (req, res) => {
  try {
    const status = await checkHealth();
    res.json(status);
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

module.exports = router;
