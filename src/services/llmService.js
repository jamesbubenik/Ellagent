'use strict';
const { getConfig } = require('./configService');
const { appLog } = require('../utils/logger');

function headers(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey || 'lm-studio'}`,
  };
}

/**
 * Non-streaming completion — returns the full assistant message string.
 */
async function complete(messages, options = {}) {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(cfg.apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      let msg = `LLM error ${res.status}`;
      try { msg = JSON.parse(text)?.error?.message || text; } catch { msg = text; }
      throw new Error(msg);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming completion — calls onChunk(text) for each streamed delta.
 * Returns { text, usage } where usage = { prompt_tokens, completion_tokens, total_tokens }
 * or null if the server did not return usage data.
 */
async function stream(messages, options = {}, onChunk, onReasoningChunk) {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  appLog.debug('llm_request', { model: cfg.model, messageCount: messages.length, maxTokens: options.maxTokens ?? 4096, stream: true });

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(cfg.apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      let msg = `LLM error ${res.status}`;
      try { msg = JSON.parse(text)?.error?.message || text; } catch { msg = text; }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let fullReasoning = '';
    let buffer = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices?.[0]?.delta;
          if (delta?.content) {
            full += delta.content;
            if (onChunk) onChunk(delta.content);
          }
          if (delta?.reasoning_content) {
            fullReasoning += delta.reasoning_content;
            if (onReasoningChunk) onReasoningChunk(delta.reasoning_content);
          }
          // Usage arrives in the final chunk (stream_options: { include_usage: true })
          if (obj.usage) usage = obj.usage;
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    appLog.debug('llm_response', { model: cfg.model, responseLen: full.length, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens });
    return { text: full, reasoningText: fullReasoning, usage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the effective context window size.
 * User-configured value is authoritative; falls back to querying /v1/models.
 */
async function getContextLength() {
  const cfg = getConfig();
  if (cfg.contextWindow) return cfg.contextWindow;
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: headers(cfg.apiKey) });
    if (!res.ok) return null;
    const data = await res.json();
    const models = data.data || [];
    const model = models.find(m => m.id === cfg.model)
                || models.find(m => m.id?.includes(cfg.model) || cfg.model?.includes(m.id));
    return model?.context_length ?? model?.max_context_length ?? null;
  } catch {
    return null;
  }
}

/**
 * Check LM Studio connectivity.
 */
async function checkHealth() {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: headers(cfg.apiKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    const models = (data.data || []).map(m => m.id);
    return { ok: true, model: cfg.model, baseUrl: cfg.baseUrl, availableModels: models };
  } catch (err) {
    return { ok: false, error: err.message, baseUrl: cfg.baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unload every model currently loaded in LM Studio.
 * Fetches the loaded model list then fires unload requests sequentially.
 * Best-effort — individual failures are logged but don't stop the rest.
 */
async function unloadAllModels(cfg) {
  const base = cfg.baseUrl.replace(/\/v1$/, '');
  const authHeader = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey || 'lm-studio'}` };

  // Get the list of currently loaded models
  let modelIds = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${cfg.baseUrl}/models`, { headers: authHeader, signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json();
      modelIds = (data.data || []).map(m => m.id).filter(Boolean);
    }
  } catch {
    // LM Studio offline — nothing to unload
    return;
  }

  for (const id of modelIds) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      await fetch(`${base}/api/v1/models/unload`, {
        method: 'POST',
        headers: authHeader,
        signal: controller.signal,
        body: JSON.stringify({ instance_id: id }),
      });
      clearTimeout(timer);
      appLog.info('model_unloaded', { model: id });
    } catch (err) {
      appLog.warn('model_unload_failed', { model: id, error: err.message });
    }
  }
}

/**
 * Ask LM Studio to load a model with the given config.
 * Accepts the full config object (from getConfig()) so callers don't need to
 * repeat the field mapping. Returns { ok, loadTime?, contextLength?, error? }.
 * No hard timeout — large models can take several minutes to load.
 */
async function loadModel(cfg) {
  const base = cfg.baseUrl.replace(/\/v1$/, '');
  const body = { model: cfg.model, echo_load_config: true };
  if (cfg.contextWindow)               body.context_length          = cfg.contextWindow;
  if (cfg.evalBatchSize != null)       body.eval_batch_size         = cfg.evalBatchSize;
  if (cfg.flashAttention != null)      body.flash_attention         = cfg.flashAttention;
  if (cfg.numExperts != null)          body.num_experts             = cfg.numExperts;
  if (cfg.offloadKvCacheToGpu != null) body.offload_kv_cache_to_gpu = cfg.offloadKvCacheToGpu;

  try {
    const r = await fetch(`${base}/api/v1/models/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey || 'lm-studio'}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${text ? ': ' + text.slice(0, 120) : ''}` };
    }
    const data = await r.json().catch(() => ({}));
    return { ok: true, loadTime: data.load_time_seconds, contextLength: data.load_config?.context_length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { complete, stream, checkHealth, getContextLength, loadModel, unloadAllModels };
