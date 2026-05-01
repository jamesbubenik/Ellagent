'use strict';

// ── Settings view ──

// ── Global MCP Server state ──
let _settingsMcpServers = [];

async function loadSettingsView() {
  setSettingsStatus('', '');

  try {
    const [cfgRes, keyRes, mcpRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/config/raw-key'),
      fetch('/api/config/mcp-servers'),
    ]);
    const cfg     = await cfgRes.json();
    const keyData = await keyRes.json();
    const mcpData = await mcpRes.json();
    _settingsMcpServers = mcpData.mcpServers || [];
    _renderSettingsMcpList();

    document.getElementById('cfg-base-url').value        = cfg.baseUrl   || '';
    document.getElementById('cfg-api-key').value         = keyData.apiKey || '';
    document.getElementById('cfg-timeout').value         = Math.round((cfg.timeoutMs || 120000) / 1000);
    document.getElementById('cfg-context-window').value  = cfg.contextWindow || 4096;
    document.getElementById('cfg-max-tool-depth').value  = cfg.maxToolCallDepth != null ? cfg.maxToolCallDepth : 5;
    document.getElementById('cfg-log-level').value       = cfg.logLevel || 'info';
    document.getElementById('cfg-eval-batch-size').value = cfg.evalBatchSize != null ? cfg.evalBatchSize : '';
    document.getElementById('cfg-flash-attention').value = cfg.flashAttention != null ? String(cfg.flashAttention) : '';
    document.getElementById('cfg-num-experts').value     = cfg.numExperts != null ? cfg.numExperts : '';
    document.getElementById('cfg-offload-kv-cache').value = cfg.offloadKvCacheToGpu != null ? String(cfg.offloadKvCacheToGpu) : '';

    // Populate model dropdown — best-effort; doesn't block form
    await refreshModelList(cfg.model);
  } catch (err) {
    setSettingsStatus(`Failed to load config: ${err.message}`, 'error');
  }
}

/**
 * Fetch available models from LM Studio and repopulate the select.
 * @param {string} [preselect] — model ID to pre-select (defaults to the saved config value)
 */
async function refreshModelList(preselect) {
  const select  = document.getElementById('cfg-model');
  const btn     = document.getElementById('cfg-model-refresh');

  // Remember whatever is currently selected so we can restore it
  const currentValue = preselect !== undefined ? preselect : (select.value || '');

  select.disabled = true;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  // Placeholder while loading
  select.innerHTML = '<option value="">Loading models…</option>';

  try {
    const res  = await fetch('/api/config/models');
    const data = await res.json();

    if (data.ok && data.models.length > 0) {
      // Build options — ensure the saved/current model is always present even if not loaded
      const models = [...data.models];
      if (currentValue && !models.includes(currentValue)) {
        models.unshift(currentValue); // keep it selectable even if LM Studio didn't list it
      }

      select.innerHTML = models
        .map(m => `<option value="${escSettingsHtml(m)}"${m === currentValue ? ' selected' : ''}>${escSettingsHtml(m)}</option>`)
        .join('');
    } else {
      // LM Studio offline or returned no models — show the saved model as a fallback option
      select.innerHTML = currentValue
        ? `<option value="${escSettingsHtml(currentValue)}" selected>${escSettingsHtml(currentValue)}</option>
           <option value="" disabled>— LM Studio offline, cannot refresh —</option>`
        : '<option value="" disabled>— could not reach LM Studio —</option>';

      if (!data.ok) {
        setSettingsStatus(`Could not load models: ${data.error || 'LM Studio unreachable'}`, 'error');
      }
    }
  } catch (err) {
    select.innerHTML = currentValue
      ? `<option value="${escSettingsHtml(currentValue)}" selected>${escSettingsHtml(currentValue)}</option>`
      : '<option value="" disabled>— error loading models —</option>';
    setSettingsStatus(`Model list error: ${err.message}`, 'error');
  } finally {
    select.disabled = false;
    if (btn) { btn.disabled = false; btn.textContent = '⟳'; }
  }
}

async function saveSettings() {
  const saveBtn = document.getElementById('settings-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  setSettingsStatus('', '');

  const baseUrl       = document.getElementById('cfg-base-url').value.trim();
  const apiKey        = document.getElementById('cfg-api-key').value.trim();
  const model         = document.getElementById('cfg-model').value.trim();
  const timeoutMs        = Math.round((parseFloat(document.getElementById('cfg-timeout').value) || 120) * 1000);
  const contextWindow    = Math.max(512, parseInt(document.getElementById('cfg-context-window').value, 10) || 4096);
  const maxToolCallDepth = Math.max(1, parseInt(document.getElementById('cfg-max-tool-depth').value, 10) || 5);
  const logLevel         = document.getElementById('cfg-log-level').value || 'info';

  const _evalRaw = document.getElementById('cfg-eval-batch-size').value.trim();
  const evalBatchSize = _evalRaw ? parseInt(_evalRaw, 10) : null;
  const _faRaw = document.getElementById('cfg-flash-attention').value;
  const flashAttention = _faRaw === 'true' ? true : _faRaw === 'false' ? false : null;
  const _neRaw = document.getElementById('cfg-num-experts').value.trim();
  const numExperts = _neRaw ? parseInt(_neRaw, 10) : null;
  const _kvRaw = document.getElementById('cfg-offload-kv-cache').value;
  const offloadKvCacheToGpu = _kvRaw === 'true' ? true : _kvRaw === 'false' ? false : null;

  if (!baseUrl) {
    setSettingsStatus('LM Studio URL is required.', 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
    return;
  }

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, model, timeoutMs, contextWindow, maxToolCallDepth, logLevel,
                             evalBatchSize, flashAttention, numExperts, offloadKvCacheToGpu }),
    });
    const data = await res.json();
    if (data.ok) {
      const parts = ['✓ Settings saved.'];
      if (data.ejected)    parts.push('Previous model ejected.');
      if (data.loading)    parts.push(`Loading "${data.model}" in the background — the connection indicator will update when ready.`);
      if (data.ejectError) parts.push(`(Eject note: ${data.ejectError})`);
      setSettingsStatus(parts.join(' '), data.ejectError ? 'warn' : 'success');
      showToast('LM Studio settings saved', 'success');
      checkHealth();
    } else {
      setSettingsStatus(`Save failed: ${data.error}`, 'error');
    }
  } catch (err) {
    setSettingsStatus(`Error: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
}

async function testConnection() {
  const testBtn = document.getElementById('settings-test-btn');
  testBtn.disabled = true;
  testBtn.textContent = 'Testing…';
  setSettingsStatus('', '');

  try {
    const res  = await fetch('/api/config/test');
    const data = await res.json();
    if (data.ok) {
      setSettingsStatus(`✓ Connected — ${data.availableModels?.length || 0} model(s) available`, 'success');
      // Refresh the dropdown with whatever is now loaded
      await refreshModelList(document.getElementById('cfg-model').value);
    } else {
      setSettingsStatus(`✗ Connection failed: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    setSettingsStatus(`✗ Request error: ${err.message}`, 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
  }
}

function setSettingsStatus(msg, type) {
  const el = document.getElementById('settings-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'settings-status' + (type ? ` settings-status-${type}` : '');
}

function escSettingsHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── MCP Server management ────────────────────────────────────────────────────

function _renderSettingsMcpList() {
  const container = document.getElementById('settings-mcp-list');
  if (!container) return;
  if (_settingsMcpServers.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">No MCP servers configured.</div>';
    return;
  }
  container.innerHTML = _settingsMcpServers.map((srv, i) => _renderSettingsMcpCard(srv, i)).join('');
}

function _renderSettingsMcpCard(srv, i) {
  const transport = srv.transport || (srv.url ? 'http' : 'stdio');
  const isHttp = transport === 'http' || transport === 'sse';
  return `
<div class="mcp-server-card" data-mcp-index="${i}">
  <div class="mcp-server-card-header">
    <input class="mcp-name-input" type="text" placeholder="Server name (unique ID)"
      value="${escSettingsHtml(srv.name || '')}"
      oninput="updateSettingsMcp(${i},'name',this.value)" />
    <span class="mcp-transport-badge mcp-transport-${transport}">${transport}</span>
    <button class="btn-icon-delete" onclick="removeSettingsMcpServer(${i})" title="Remove">×</button>
  </div>
  <div class="mcp-server-card-body">
    <div class="mcp-field-row">
      <label class="mcp-field-label">Transport</label>
      <select class="mcp-field-select" onchange="updateSettingsMcpTransport(${i},this.value)">
        <option value="stdio"${transport==='stdio'?' selected':''}>stdio — local process</option>
        <option value="http"${transport==='http'?' selected':''}>HTTP — streamable</option>
        <option value="sse"${transport==='sse'?' selected':''}>SSE — event stream</option>
      </select>
    </div>
    ${isHttp ? `
    <div class="mcp-field-row">
      <label class="mcp-field-label">URL</label>
      <input class="mcp-field-input" type="text" placeholder="https://..."
        value="${escSettingsHtml(srv.url || '')}"
        oninput="updateSettingsMcp(${i},'url',this.value)" />
    </div>
    <div class="mcp-field-row">
      <label class="mcp-field-label">Token</label>
      <div class="mcp-token-wrap">
        <input class="mcp-field-input mcp-token-input" type="password" placeholder="Bearer token (optional)"
          autocomplete="off"
          value="${escSettingsHtml(srv.token || '')}"
          oninput="updateSettingsMcp(${i},'token',this.value)" />
        <button class="mcp-token-eye" type="button" title="Show / hide token"
          onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password';this.textContent=this.previousElementSibling.type==='password'?'👁':'🙈'">👁</button>
      </div>
    </div>` : `
    <div class="mcp-field-row">
      <label class="mcp-field-label">Command</label>
      <input class="mcp-field-input" type="text" placeholder="node, python, npx …"
        value="${escSettingsHtml(srv.command || '')}"
        oninput="updateSettingsMcp(${i},'command',this.value)" />
    </div>
    <div class="mcp-field-row">
      <label class="mcp-field-label">Args</label>
      <input class="mcp-field-input" type="text" placeholder="./server.js --flag"
        value="${escSettingsHtml((srv.args || []).join(' '))}"
        oninput="updateSettingsMcpArgs(${i},this.value)" />
    </div>
    <div class="mcp-field-row">
      <label class="mcp-field-label">Working Dir</label>
      <input class="mcp-field-input" type="text" placeholder="Optional — absolute path"
        value="${escSettingsHtml(srv.cwd || '')}"
        oninput="updateSettingsMcp(${i},'cwd',this.value)" />
    </div>
    <div class="mcp-field-row">
      <label class="mcp-field-label">Env</label>
      <textarea class="mcp-field-textarea" rows="2" placeholder="KEY=VALUE (one per line)"
        oninput="updateSettingsMcpEnv(${i},this.value)">${escSettingsHtml(Object.entries(srv.env||{}).map(([k,v])=>`${k}=${v}`).join('\n'))}</textarea>
    </div>`}
  </div>
</div>`;
}

function addSettingsMcpServer() {
  _settingsMcpServers.push({ name: '', transport: 'stdio', command: '', args: [], env: {} });
  _renderSettingsMcpList();
  _saveSettingsMcpServers();
}

function removeSettingsMcpServer(i) {
  _settingsMcpServers.splice(i, 1);
  _renderSettingsMcpList();
  _saveSettingsMcpServers();
}

function updateSettingsMcp(i, field, value) {
  _settingsMcpServers[i][field] = value;
  _saveSettingsMcpServers();
}

function updateSettingsMcpTransport(i, value) {
  const srv = _settingsMcpServers[i];
  srv.transport = value;
  if (value === 'stdio') { delete srv.url; delete srv.token; }
  else                   { delete srv.command; delete srv.args; delete srv.env; }
  _renderSettingsMcpList();
  _saveSettingsMcpServers();
}

function updateSettingsMcpArgs(i, value) {
  _settingsMcpServers[i].args = value.trim() ? value.trim().split(/\s+/) : [];
  _saveSettingsMcpServers();
}

function updateSettingsMcpEnv(i, value) {
  const env = {};
  for (const line of value.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) env[k] = v;
    }
  }
  _settingsMcpServers[i].env = env;
  _saveSettingsMcpServers();
}

async function _saveSettingsMcpServers() {
  // Only persist servers that have a name — skip incomplete cards mid-edit
  const toSave = _settingsMcpServers.filter(s => s.name && s.name.trim());
  try {
    const res = await fetch('/api/config/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: toSave }),
    });
    const data = await res.json();
    if (!data.ok) console.warn('Failed to save MCP servers:', data.error);
  } catch (err) {
    console.warn('MCP save error:', err.message);
  }
}

