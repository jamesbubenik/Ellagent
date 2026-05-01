'use strict';

// ── Operator State ──
let currentAgentSlug  = null;
let currentAgentName  = null;
let currentSessionId  = null;
let operatorBusy      = false;
let pendingApprovalSlug = null;
let autoApproveActive = false;
let memoryActive      = false;
let sessionSkills     = [];   // [{ name, description, requiresApproval, enabled }]
let pendingAttachments = []; // [{ name, mimeType, content?, dataUrl?, size }]
let sessionContextLength = null; // model max context window in tokens

// ── Auto-resize textarea ──
const operatorInput = document.getElementById('operator-input');
operatorInput.addEventListener('input', () => {
  operatorInput.style.height = 'auto';
  operatorInput.style.height = Math.min(operatorInput.scrollHeight, 140) + 'px';
});

function handleOperatorKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendOperatorMessage();
  }
}

// ───────────────────────────────────────────────
//  AGENT GRID
// ───────────────────────────────────────────────

async function loadAgents() {
  const grid = document.getElementById('agent-grid');
  grid.innerHTML = '<div style="color:var(--text-muted); padding:20px; font-size:13px;">Loading agents...</div>';

  try {
    const res = await fetch('/api/operator/agents');
    const data = await res.json();
    const agents = data.agents || [];

    if (agents.length === 0) {
      grid.innerHTML = `
        <div class="agent-grid-empty">
          <div class="agent-grid-empty-icon">🤖</div>
          <div>No agents yet — create one in the Creator tab</div>
        </div>`;
      return;
    }

    grid.innerHTML = agents.map(agent => {
      const totalSkills = (agent.requiredSkills || []).length + (agent.generatedSkills || []).length;
      const s = agent.slug.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const n = (agent.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `
        <div class="agent-card" onclick="launchAgent('${s}')">
          <button class="agent-card-delete" title="Delete agent"
            onclick="event.stopPropagation(); confirmDeleteOperatorAgent('${s}', '${n}')">🗑</button>
          <div class="agent-card-header">
            <div class="agent-card-avatar">${makeAvatar(agent.name)}</div>
            <div>
              <div class="agent-card-name">${escOp(agent.name)}</div>
              <div style="font-size:11px; color:var(--text-muted);">${escOp(agent.slug)}</div>
            </div>
          </div>
          <div class="agent-card-desc">${escOp(agent.description || 'No description')}</div>
          <div class="agent-card-meta">
            <span>${formatDate(agent.createdAt)}</span>
            <span class="skill-badge">${totalSkills} skill${totalSkills !== 1 ? 's' : ''}</span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--danger); padding:20px; font-size:13px;">Failed to load agents: ${escOp(err.message)}</div>`;
  }
}

function confirmDeleteOperatorAgent(slug, name) {
  showDeleteModal(name, slug, async () => {
    try {
      const res = await fetch(`/api/operator/agents/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(`"${name}" deleted`, 'success');
        loadAgents();
        refreshSidebarAgents();
        if (typeof loadCreatorAgentHistory === 'function') loadCreatorAgentHistory();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(`Delete failed: ${err.error || res.status}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });
}

// ───────────────────────────────────────────────
//  SESSION MANAGEMENT
// ───────────────────────────────────────────────

async function launchAgent(slug) {
  // Show loading overlay while MCP servers connect (can be slow on first launch)
  const overlay   = document.getElementById('session-loading-overlay');
  const nameLabel = document.getElementById('session-loading-agent-name');
  if (nameLabel) nameLabel.textContent = slug.replace(/-/g, ' ');
  if (overlay) overlay.classList.add('active');

  let res;
  try {
    res = await fetch(`/api/operator/agents/${encodeURIComponent(slug)}/start-session`, { method: 'POST' });
  } finally {
    if (overlay) overlay.classList.remove('active');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`Failed to start session: ${err.error || res.status}`, 'error');
    return;
  }

  const data = await res.json();
  currentAgentSlug     = slug;
  currentAgentName     = data.agentName;
  currentSessionId     = data.sessionId;
  operatorBusy         = false;
  autoApproveActive    = false;
  sessionContextLength = data.contextLength || null;
  _resetTokenDisplay();

  // Switch to chat UI
  document.getElementById('agent-grid-container').style.display = 'none';
  document.getElementById('operator-chat-container').classList.add('active');
  document.getElementById('op-agent-name').textContent = data.agentName;
  document.getElementById('operator-send-btn').disabled = false;

  // Reset toggles — memory inherits agent-level default
  memoryActive = !!data.memoryEnabled;
  _updateMemoryToggleBtn(memoryActive);
  const btn = document.getElementById('auto-approve-btn');
  btn.classList.remove('active');

  // Populate tools panel
  sessionSkills = (data.skills || []).map(s => ({ ...s, enabled: true }));
  _renderToolsPanel();

  const messages = document.getElementById('operator-messages');
  messages.innerHTML = '';
  appendMessage('operator-messages', 'system', `Session started with ${data.agentName}`);

  // Warn about MCP servers that failed to connect
  if (data.mcpErrors && data.mcpErrors.length > 0) {
    for (const { server, error } of data.mcpErrors) {
      appendMessage('operator-messages', 'system',
        `⚠ MCP server "${server}" failed to connect: ${error}`);
    }
  }
  // Confirm which MCP tools are live
  if (data.mcpTools && data.mcpTools.length > 0) {
    const names = data.mcpTools.map(t => t.name).join(', ');
    appendMessage('operator-messages', 'system', `MCP tools available: ${names}`);
  }

  loadSessionsList(slug);
  document.getElementById('operator-input').focus();
}

function exitChat() {
  currentAgentSlug     = null;
  currentAgentName     = null;
  currentSessionId     = null;
  operatorBusy         = false;
  autoApproveActive    = false;
  sessionContextLength = null;
  _resetTokenDisplay();

  document.getElementById('agent-grid-container').style.display = '';
  document.getElementById('operator-chat-container').classList.remove('active');
  document.getElementById('sessions-panel').classList.remove('open');
  document.getElementById('tools-panel').classList.remove('open');
  document.getElementById('memory-panel').classList.remove('open');
  sessionSkills = [];
  pendingAttachments = [];
  _renderAttachments();
  loadAgents();
}

// ───────────────────────────────────────────────
//  AUTO-APPROVE TOGGLE
// ───────────────────────────────────────────────

function _updateMemoryToggleBtn(active) {
  const btn   = document.getElementById('memory-toggle-btn');
  const label = document.getElementById('memory-toggle-label');
  btn.classList.toggle('active', active);
  if (label) label.textContent = active ? 'Memory Enabled' : 'Memory Disabled';
}

async function toggleMemory() {
  if (!currentSessionId) return;
  memoryActive = !memoryActive;
  _updateMemoryToggleBtn(memoryActive);

  try {
    await fetch(`/api/operator/agents/${currentAgentSlug}/set-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, memoryEnabled: memoryActive }),
    });
    showToast(memoryActive ? 'Memory Enabled — key facts will be remembered' : 'Memory Disabled', 'info');
  } catch (err) {
    showToast(`Memory toggle failed: ${err.message}`, 'error');
    memoryActive = !memoryActive;
    _updateMemoryToggleBtn(memoryActive);
  }
}

async function resetMemory() {
  if (!currentAgentSlug) return;
  if (!confirm('Permanently erase all long-term memory for this agent?\n\nThis cannot be undone.')) return;

  try {
    const res = await fetch(`/api/operator/agents/${currentAgentSlug}/reset-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Reset failed');
    const badge = document.getElementById('memory-badge');
    if (badge) { badge.classList.remove('active'); badge.title = ''; }
    _renderMemoryEntries([]);
    showToast('Long-term memory cleared', 'success');
  } catch (err) {
    showToast(`Reset failed: ${err.message}`, 'error');
  }
}

async function toggleAutoApprove() {
  if (!currentSessionId) return;
  autoApproveActive = !autoApproveActive;

  const btn = document.getElementById('auto-approve-btn');
  btn.classList.toggle('active', autoApproveActive);

  try {
    await fetch(`/api/operator/agents/${currentAgentSlug}/set-auto-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, autoApprove: autoApproveActive }),
    });
    showToast(autoApproveActive ? 'Auto-approve ON — all tools will run without asking' : 'Auto-approve OFF', 'info');
  } catch (err) {
    showToast(`Auto-approve toggle failed: ${err.message}`, 'error');
    autoApproveActive = !autoApproveActive;
    btn.classList.toggle('active', autoApproveActive);
  }
}

// ───────────────────────────────────────────────
//  MESSAGING + STREAMING
// ───────────────────────────────────────────────

let _stream = { wrapperEl: null, reasoningEl: null, assistantEl: null, fullText: '', reasoningText: '', typingEl: null };

function sendOperatorMessage() {
  const input = document.getElementById('operator-input');
  const message = input.value.trim();
  if ((!message && !pendingAttachments.length) || operatorBusy || !currentSessionId) return;
  input.value = '';
  input.style.height = 'auto';

  const attachments = pendingAttachments.slice();
  pendingAttachments = [];
  _renderAttachments();

  _appendUserBubble(message, attachments);
  _startStream(`/api/operator/agents/${currentAgentSlug}/message`, {
    sessionId: currentSessionId, message, attachments,
  });
}

function _startStream(url, body) {
  _stream = { wrapperEl: null, reasoningEl: null, assistantEl: null, fullText: '', reasoningText: '', typingEl: null };
  operatorBusy = true;
  document.getElementById('operator-send-btn').disabled = true;
  _stream.typingEl = _appendThinkingBubble();
  _doStream(url, body);
}

function _appendThinkingBubble() {
  const messages = document.getElementById('operator-messages');
  const wrapper  = document.createElement('div');
  wrapper.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className   = 'message-avatar';
  avatar.textContent = makeAvatar(currentAgentName);

  const row = document.createElement('div');
  row.className = 'status-pills-row';

  const pill = document.createElement('span');
  pill.className = 'status-pill';
  pill.innerHTML = '<span class="thinking-spinner"></span>Generating\u2026';

  row.appendChild(pill);
  wrapper.appendChild(avatar);
  wrapper.appendChild(row);
  messages.appendChild(wrapper);
  scrollToBottom('operator-messages');
  return wrapper;
}

// Creates (or returns) the shared message wrapper for this turn.
// Structure: .message.assistant > [.message-avatar, .message-content > [.reasoning-block?, .message-bubble?]]
function _getOrCreateWrapper() {
  if (_stream.wrapperEl) return _stream.wrapperEl;
  const messages = document.getElementById('operator-messages');
  const wrapper  = document.createElement('div');
  wrapper.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className   = 'message-avatar';
  avatar.textContent = makeAvatar(currentAgentName);
  wrapper.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'message-content';
  wrapper.appendChild(content);

  const statusRow = _stream.typingEl;
  if (statusRow && statusRow.parentNode === messages) {
    messages.insertBefore(wrapper, statusRow);
  } else {
    messages.appendChild(wrapper);
  }
  _stream.wrapperEl = wrapper;
  scrollToBottom('operator-messages');
  return wrapper;
}

// Creates the collapsible reasoning block inside .message-content.
function _createReasoningEl() {
  const wrapper  = _getOrCreateWrapper();
  const content  = wrapper.querySelector('.message-content');
  const block    = document.createElement('div');
  block.className = 'reasoning-block';
  block.innerHTML =
    '<div class="reasoning-header">' +
      '<svg class="reasoning-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>' +
      '<span class="reasoning-label">Thinking…</span>' +
    '</div>' +
    '<div class="reasoning-body"><div class="reasoning-text"></div></div>';
  block.querySelector('.reasoning-header').addEventListener('click', () => block.classList.toggle('collapsed'));
  // Insert before the bubble if it already exists in content, else append
  const bubble = content.querySelector('.message-bubble');
  if (bubble) content.insertBefore(block, bubble);
  else content.appendChild(block);
  _stream.reasoningEl = block;
  return block;
}

// Creates (or wires up) the assistant text bubble inside .message-content.
// Returns the outer wrapper (kept for compat with _updateOpBubble which queries .message-bubble within it).
function _createAssistantEl() {
  const wrapper = _getOrCreateWrapper();
  const content = wrapper.querySelector('.message-content');
  if (!content.querySelector('.message-bubble')) {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    content.appendChild(bubble);
  }
  scrollToBottom('operator-messages');
  return wrapper;
}

async function _doStream(url, body) {
  const typingEl = _stream.typingEl;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (typingEl) typingEl.remove();
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      appendMessage('operator-messages', 'system', `Error: ${errData.error}`);
      _finishStream();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          _processEvent(evt);
        } catch (e) { console.error('[operator SSE]', e, line); }
      }
    }
  } catch (err) {
    if (typingEl) typingEl.remove();
    appendMessage('operator-messages', 'system', `Connection error: ${err.message}`);
    _finishStream();
  }
}

function _processEvent(evt) {
  if (evt.type === 'reasoning_chunk') {
    if (!_stream.reasoningEl) _createReasoningEl();
    _stream.reasoningText += evt.content;
    _stream.reasoningEl.querySelector('.reasoning-text').textContent = _stream.reasoningText;
    scrollToBottom('operator-messages');

  } else if (evt.type === 'chunk') {
    if (!_stream.assistantEl) {
      _stream.assistantEl = _createAssistantEl();
    }
    _stream.fullText += evt.content;
    _updateOpBubble(_stream.assistantEl, _stream.fullText);

  } else if (evt.type === 'tool_executing') {
    appendToolCard({ skillName: evt.skillName, params: evt.params, status: 'executing' });

  } else if (evt.type === 'tool_result') {
    updateLastToolCard(evt.skillName, evt.result);

  } else if (evt.type === 'tool_error') {
    appendToolCard({ skillName: evt.skillName, status: 'error', error: evt.error });

  } else if (evt.type === 'approval_required') {
    appendToolCard({ skillName: evt.skillName, params: evt.params, status: 'pending', description: evt.description });
    showApprovalModal(evt);

  } else if (evt.type === 'paused') {
    // Stream paused waiting for tool approval — don't re-enable send button yet

  } else if (evt.type === 'usage') {
    _updateTokenDisplay(evt);

  } else if (evt.type === 'memory_update') {
    _showMemoryUpdate(evt.count);

  } else if (evt.type === 'error') {
    appendMessage('operator-messages', 'system', `Error: ${evt.error}`);
    _finishStream();

  } else if (evt.type === 'done') {
    _finishStream();
  }
}

function _finishStream() {
  // Remove the status row (Generating… + any tool pills)
  if (_stream.typingEl) {
    _stream.typingEl.remove();
    _stream.typingEl = null;
  }
  // Collapse reasoning block and update label now that thinking is complete
  if (_stream.reasoningEl) {
    _stream.reasoningEl.classList.add('collapsed');
    const label = _stream.reasoningEl.querySelector('.reasoning-label');
    if (label) label.textContent = 'Reasoning';
  }
  // Remove wrapper if it's invisible (pure tool-call) AND has no reasoning to show
  if (_stream.assistantEl && _stream.assistantEl.style.display === 'none' && !_stream.reasoningEl) {
    _stream.assistantEl.remove();
  } else if (_stream.wrapperEl && _stream.wrapperEl.style.display === 'none' && _stream.reasoningEl) {
    _stream.wrapperEl.style.display = '';
  }
  operatorBusy = false;
  document.getElementById('operator-send-btn').disabled = false;
  document.getElementById('operator-input').focus();
}

function _fmtTokens(n) {
  if (n == null) return '?';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function _resetTokenDisplay() {
  const el = document.getElementById('token-usage-display');
  if (el) el.style.display = 'none';
}

function _updateTokenDisplay(usage) {
  const el   = document.getElementById('token-usage-display');
  const fill = document.getElementById('token-bar-fill');
  const text = document.getElementById('token-usage-text');
  if (!el) return;

  // prompt_tokens is the authoritative context-usage figure from LM Studio:
  // it counts every token sent in the request (system prompt + full history + new message).
  const used  = usage.promptTokens ?? 0;
  const total = usage.contextLength ?? sessionContextLength;

  el.style.display = 'flex';

  const reasoningToks   = usage.reasoningTokens || 0;
  const reasoningSuffix = reasoningToks > 0 ? ` · ${_fmtTokens(reasoningToks)} reasoning` : '';

  if (total) {
    const pct = Math.min((used / total) * 100, 100);
    fill.style.width = `${pct}%`;
    fill.className = 'token-bar-fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
    text.textContent = `${_fmtTokens(used)} / ${_fmtTokens(total)}${reasoningSuffix}`;
    el.title = `Context: ${used.toLocaleString()} / ${total.toLocaleString()} tokens used (${pct.toFixed(1)}%)${reasoningToks ? `\nReasoning: ${reasoningToks.toLocaleString()} tokens` : ''}`;
  } else {
    fill.style.width = '0%';
    fill.className = 'token-bar-fill';
    text.textContent = `${_fmtTokens(used)} tokens${reasoningSuffix}`;
    el.title = `Context: ${used.toLocaleString()} tokens used`;
  }
}

function _showMemoryUpdate(count) {
  const badge = document.getElementById('memory-badge');
  if (badge) {
    badge.title = `${count} fact${count !== 1 ? 's' : ''} in long-term memory`;
    badge.classList.add('active');
    clearTimeout(badge._flashTimer);
    badge._flashTimer = setTimeout(() => badge.classList.remove('active'), 3000);
  }
  showToast(`Memory updated — ${count} fact${count !== 1 ? 's' : ''} stored`, 'info');
  // Refresh panel if it's open so the user sees the new entries immediately
  if (document.getElementById('memory-panel').classList.contains('open')) {
    _fetchAndRenderMemory();
  }
}

// ───────────────────────────────────────────────
//  TOOL CARDS
// ───────────────────────────────────────────────

function _humanizeSkillName(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function _describeToolUse(skillName, params) {
  if (!params || Object.keys(params).length === 0) return '';
  switch (skillName) {
    case 'file-read':
      return params.path ? `Reading ${params.path}` : 'Reading a file';
    case 'file-write':
      return params.path ? `Writing to ${params.path}` : 'Writing a file';
    case 'web-search':
      return params.query ? `Searching for "${params.query}"` : 'Searching the web';
    case 'shell-exec':
      return params.command ? `Running: ${params.command}` : 'Running a command';
    case 'http-request': {
      const method = (params.method || 'GET').toUpperCase();
      let host = params.url || 'an API';
      try { host = new URL(params.url).hostname; } catch {}
      return `${method} → ${host}`;
    }
    default: {
      const firstVal = Object.values(params)[0];
      return firstVal ? String(firstVal).slice(0, 80) : '';
    }
  }
}

function _summarizeResult(skillName, result) {
  if (!result) return '';
  if (!result.success) return result.error ? `Error: ${result.error}` : 'Failed';
  const r = result.result;
  if (r == null) return 'Done';
  if (typeof r === 'string') {
    const trimmed = r.trim();
    return trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed || 'Done';
  }
  if (typeof r === 'object' && !Array.isArray(r)) {
    const entries = Object.entries(r).slice(0, 2).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`);
    return entries.join(' · ') || 'Done';
  }
  if (Array.isArray(r)) return `${r.length} result${r.length !== 1 ? 's' : ''}`;
  return String(r).slice(0, 120);
}

// ── Status pills — appear inside the status row next to "Generating…" ──

function appendToolCard({ skillName, params, status, error, description }) {
  const label       = _humanizeSkillName(skillName);
  const purposeText = description || _describeToolUse(skillName, params);
  const executing   = status === 'executing' || status === 'pending';

  const pill = document.createElement('span');
  pill.className   = `status-pill${executing ? ' status-pill-active' : status === 'error' ? ' status-pill-error' : ' status-pill-done'}`;
  pill.dataset.skill = skillName;

  if (executing) {
    pill.innerHTML = `<span class="thinking-spinner"></span>${escOp(label)}${purposeText ? ` \u2014 ${escOp(purposeText)}` : ''}`;
  } else {
    const icon   = status === 'error' ? '✗' : '✓';
    const detail = error ? `Error: ${error}` : purposeText;
    pill.innerHTML = `<span class="status-pill-icon">${icon}</span>${escOp(label)}${detail ? ` \u2014 ${escOp(detail)}` : ''}`;
  }

  // Add into the status row that's still visible during processing
  const statusRow = _stream.typingEl;
  if (statusRow) {
    const row = statusRow.querySelector('.status-pills-row');
    if (row) { row.appendChild(pill); scrollToBottom('operator-messages'); return pill; }
  }

  // Fallback: append directly to messages if status row is gone
  const messages = document.getElementById('operator-messages');
  messages.appendChild(pill);
  scrollToBottom('operator-messages');
  return pill;
}

function updateLastToolCard(skillName, result) {
  const all  = document.querySelectorAll(`.status-pill[data-skill="${CSS.escape(skillName)}"]`);
  const pill = all[all.length - 1];
  if (!pill) return;

  const success = result?.success !== false;
  pill.className = `status-pill ${success ? 'status-pill-done' : 'status-pill-error'}`;

  const label   = _humanizeSkillName(skillName);
  const summary = _summarizeResult(skillName, result);
  const icon    = success ? '✓' : '✗';
  pill.innerHTML = `<span class="status-pill-icon">${icon}</span>${escOp(label)}${summary ? ` \u2014 ${escOp(summary)}` : ''}`;
}

// ───────────────────────────────────────────────
//  TOOL APPROVAL MODAL
// ───────────────────────────────────────────────

function showApprovalModal(evt) {
  pendingApprovalSlug = currentAgentSlug;
  const label   = _humanizeSkillName(evt.skillName);
  const purpose = _describeToolUse(evt.skillName, evt.params);
  document.getElementById('approval-desc').textContent =
    `The agent wants to use ${label}.${evt.description ? ' ' + evt.description : ''}`;
  document.getElementById('approval-detail').textContent =
    purpose || evt.skillName;
  document.getElementById('approval-modal').classList.add('open');
}

async function respondToApproval(approved) {
  document.getElementById('approval-modal').classList.remove('open');

  const res = await fetch(`/api/operator/agents/${currentAgentSlug}/approve-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // rememberForSession: true → this skill won't ask again this session
    body: JSON.stringify({ sessionId: currentSessionId, approved, rememberForSession: true }),
  });

  const data = await res.json();

  if (!approved) {
    appendMessage('operator-messages', 'system', 'Tool execution denied.');
    _startStream(`/api/operator/agents/${currentAgentSlug}/continue`, { sessionId: currentSessionId });
    return;
  }

  if (data.result) updateLastToolCard(data.skillName || pendingApprovalSlug, data.result);

  // Show "approved for session" notice
  appendMessage('operator-messages', 'system', `"${data.skillName}" approved — won't ask again this session.`);

  _startStream(`/api/operator/agents/${currentAgentSlug}/continue`, { sessionId: currentSessionId });
  pendingApprovalSlug = null;
}

// ───────────────────────────────────────────────
//  SESSION END
// ───────────────────────────────────────────────


// ───────────────────────────────────────────────
//  TOOLS PANEL
// ───────────────────────────────────────────────

function toggleToolsPanel() {
  document.getElementById('tools-panel').classList.toggle('open');
}

function _renderToolsPanel() {
  const list = document.getElementById('tools-panel-list');
  if (!sessionSkills.length) {
    list.innerHTML = '<div style="padding:12px 14px; font-size:12px; color:var(--text-muted);">No tools assigned to this agent</div>';
    return;
  }
  list.innerHTML = sessionSkills.map(s => `
    <div class="tool-item${s.enabled ? '' : ' tool-item-disabled'}" id="tool-item-${escOp(s.name)}">
      <div class="tool-item-info">
        <div class="tool-item-name">${escOp(_humanizeSkillName(s.name))}</div>
        ${s.description ? `<div class="tool-item-desc">${escOp(s.description)}</div>` : ''}
        ${s.requiresApproval ? '<span class="tool-item-badge">Requires approval</span>' : ''}
      </div>
      <label class="toggle-switch" title="${s.enabled ? 'Disable' : 'Enable'} this tool for the session">
        <input type="checkbox" ${s.enabled ? 'checked' : ''}
          onchange="toggleSessionSkill('${escAttrRaw(s.name)}', this.checked)">
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </div>`).join('');
}

async function toggleSessionSkill(skillName, enabled) {
  const skill = sessionSkills.find(s => s.name === skillName);
  if (!skill || !currentSessionId) return;

  try {
    await fetch(`/api/operator/agents/${currentAgentSlug}/toggle-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, skillName, enabled }),
    });
    skill.enabled = enabled;
    _renderToolsPanel();
    showToast(`${_humanizeSkillName(skillName)} ${enabled ? 'enabled' : 'disabled'}`, 'info');
  } catch (err) {
    showToast(`Failed to toggle tool: ${err.message}`, 'error');
    skill.enabled = !enabled;
    _renderToolsPanel();
  }
}

// ───────────────────────────────────────────────
//  MEMORY PANEL
// ───────────────────────────────────────────────

const _MEM_CATEGORY_LABELS = {
  user_profile: 'User Profile',
  preferences:  'Preferences',
  goals:        'Goals',
  context:      'Context',
};
const _MEM_CATEGORY_ORDER = ['user_profile', 'preferences', 'goals', 'context'];

function toggleMemoryPanel() {
  const panel = document.getElementById('memory-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open') && currentAgentSlug) {
    _fetchAndRenderMemory();
  }
}

async function _fetchAndRenderMemory() {
  if (!currentAgentSlug) return;
  const body = document.getElementById('memory-panel-body');
  body.innerHTML = '<div style="padding:14px; font-size:12px; color:var(--text-muted);">Loading…</div>';
  try {
    const res  = await fetch(`/api/operator/agents/${encodeURIComponent(currentAgentSlug)}/memory`);
    const data = await res.json();
    _renderMemoryEntries(data.entries || []);
  } catch (err) {
    body.innerHTML = `<div style="padding:14px; font-size:12px; color:var(--danger);">Failed: ${escOp(err.message)}</div>`;
  }
}

function _renderMemoryEntries(entries) {
  const body = document.getElementById('memory-panel-body');
  if (!entries.length) {
    body.innerHTML = '<div style="padding:14px; font-size:12px; color:var(--text-muted);">No memories stored yet.</div>';
    return;
  }

  const groups = {};
  for (const e of entries) {
    const cat = e.category || 'context';
    (groups[cat] = groups[cat] || []).push(e);
  }

  let html = '';
  for (const cat of _MEM_CATEGORY_ORDER) {
    if (!groups[cat]) continue;
    html += `<div class="memory-category-label">${escOp(_MEM_CATEGORY_LABELS[cat] || cat)}</div>`;
    for (const entry of groups[cat]) {
      html += `
        <div class="memory-entry" id="mem-entry-${escOp(entry.id)}">
          <div class="memory-entry-content">${escOp(entry.content)}</div>
          <div class="memory-entry-actions">
            <button class="memory-entry-btn" onclick="startEditMemory('${escAttrRaw(entry.id)}')" title="Edit">✎</button>
            <button class="memory-entry-btn danger" onclick="deleteMemoryEntryById('${escAttrRaw(entry.id)}')" title="Delete">🗑</button>
          </div>
        </div>`;
    }
  }
  body.innerHTML = html;
}

function startEditMemory(id) {
  const entryEl    = document.getElementById(`mem-entry-${id}`);
  if (!entryEl) return;
  const contentEl  = entryEl.querySelector('.memory-entry-content');
  const actionsEl  = entryEl.querySelector('.memory-entry-actions');
  const origText   = contentEl.textContent;

  contentEl.style.display = 'none';
  actionsEl.style.display = 'none';

  const editRow = document.createElement('div');
  editRow.className = 'memory-entry-edit-row';

  const ta = document.createElement('textarea');
  ta.className = 'memory-entry-edit-textarea';
  ta.rows = 3;
  ta.value = origText;

  const btnRow = document.createElement('div');
  btnRow.className = 'memory-entry-edit-actions';
  btnRow.innerHTML = `
    <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px;" onclick="cancelEditMemory('${escAttrRaw(id)}')">Cancel</button>
    <button class="btn btn-accent" style="font-size:11px;padding:3px 8px;" onclick="saveEditMemory('${escAttrRaw(id)}')">Save</button>`;

  editRow.appendChild(ta);
  editRow.appendChild(btnRow);
  entryEl.appendChild(editRow);
  ta.focus();
}

function cancelEditMemory(id) {
  const entryEl = document.getElementById(`mem-entry-${id}`);
  if (!entryEl) return;
  entryEl.querySelector('.memory-entry-content').style.display = '';
  entryEl.querySelector('.memory-entry-actions').style.display = '';
  const editRow = entryEl.querySelector('.memory-entry-edit-row');
  if (editRow) editRow.remove();
}

async function saveEditMemory(id) {
  const entryEl = document.getElementById(`mem-entry-${id}`);
  if (!entryEl) return;
  const content = entryEl.querySelector('.memory-entry-edit-textarea').value.trim();
  if (!content) return;

  try {
    const res  = await fetch(
      `/api/operator/agents/${encodeURIComponent(currentAgentSlug)}/memory/${encodeURIComponent(id)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sessionId: currentSessionId }) },
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Update failed');
    _renderMemoryEntries(data.entries);
    showToast('Memory entry updated', 'success');
  } catch (err) {
    showToast(`Update failed: ${err.message}`, 'error');
  }
}

async function deleteMemoryEntryById(id) {
  if (!currentAgentSlug) return;
  if (!confirm('Delete this memory entry?')) return;
  try {
    const sid = currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : '';
    const res  = await fetch(
      `/api/operator/agents/${encodeURIComponent(currentAgentSlug)}/memory/${encodeURIComponent(id)}${sid}`,
      { method: 'DELETE' },
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Delete failed');
    _renderMemoryEntries(data.entries);
    showToast('Memory entry deleted', 'success');
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

async function submitAddMemoryEntry() {
  const content  = document.getElementById('memory-add-content').value.trim();
  const category = document.getElementById('memory-add-category').value;
  if (!content || !currentAgentSlug) return;

  try {
    const res  = await fetch(
      `/api/operator/agents/${encodeURIComponent(currentAgentSlug)}/memory`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, category, sessionId: currentSessionId }) },
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Add failed');
    document.getElementById('memory-add-content').value = '';
    _renderMemoryEntries(data.entries);
    showToast('Memory entry added', 'success');
  } catch (err) {
    showToast(`Add failed: ${err.message}`, 'error');
  }
}

// ───────────────────────────────────────────────
//  SESSION HISTORY PANEL
// ───────────────────────────────────────────────

function toggleSessionsPanel() {
  document.getElementById('sessions-panel').classList.toggle('open');
}

async function loadSessionsList(slug) {
  const list = document.getElementById('sessions-list');
  try {
    const res = await fetch(`/api/operator/agents/${encodeURIComponent(slug)}/sessions`);
    const data = await res.json();
    const sessions = data.sessions || [];
    if (sessions.length === 0) {
      list.innerHTML = '<div style="padding:12px 14px; font-size:12px; color:var(--text-muted);">No past sessions</div>';
      return;
    }
    list.innerHTML = sessions.map(s => `
      <div class="session-item">
        <span class="session-item-label" onclick="viewSession('${escAttrRaw(slug)}', '${escAttrRaw(s)}')" title="${escOp(s)}">
          ${formatSessionId(s)}
        </span>
        <button class="session-item-delete" onclick="deleteSession('${escAttrRaw(slug)}', '${escAttrRaw(s)}')" title="Delete session">🗑</button>
      </div>`).join('');
  } catch {
    list.innerHTML = '<div style="padding:12px 14px; font-size:12px; color:var(--text-muted);">Failed to load</div>';
  }
}

async function viewSession(slug, sessionId) {
  try {
    const res = await fetch(`/api/operator/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    const messages = document.getElementById('operator-messages');
    messages.innerHTML = `
      <div class="message system-msg">
        <div class="message-bubble">📜 Transcript: ${formatSessionId(sessionId)}</div>
      </div>
      <div class="transcript-viewer">
        <pre class="transcript-content">${escOp(data.transcript || '')}</pre>
      </div>`;
    scrollToBottom('operator-messages');
  } catch (err) {
    showToast(`Could not load session: ${err.message}`, 'error');
  }
}

async function deleteSession(slug, sessionId) {
  const choice = await _sessionDeleteChoice(sessionId);
  if (choice === null) return; // user cancelled

  try {
    const url = `/api/operator/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}${choice ? '?clearMemory=true' : ''}`;
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      showToast(data.memoryCleared ? 'Session deleted + memory cleared' : 'Session deleted', 'success');
      loadSessionsList(slug);
    } else {
      showToast(`Delete failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function _sessionDeleteChoice(sessionId) {
  return new Promise(resolve => {
    // Use a simple confirm dialog chain
    if (!confirm(`Delete session "${formatSessionId(sessionId)}"?`)) {
      resolve(null);
      return;
    }
    const clearMem = confirm('Also clear ALL long-term memory for this agent?\n\nClick OK to clear memory, Cancel to keep it.');
    resolve(clearMem);
  });
}

// ───────────────────────────────────────────────
//  FILE ATTACHMENTS + DRAG-DROP
// ───────────────────────────────────────────────

const _TEXT_EXTS = new Set([
  'txt','md','json','js','ts','jsx','tsx','py','css','html','xml','yaml','yml',
  'csv','log','sh','sql','env','toml','ini','cfg','conf','rs','go','java','rb',
  'php','c','cpp','h','hpp','cs','swift','kt','r','scala','vue','svelte',
]);
const _IMG_EXTS  = new Set(['jpg','jpeg','png','gif','webp','bmp','svg','tiff','ico']);
const _DOC_EXTS  = new Set(['pdf','docx']);

function _isImageFile(file) {
  if (file.type.startsWith('image/')) return true;
  return _IMG_EXTS.has(file.name.split('.').pop().toLowerCase());
}

function _isTextFile(file) {
  if (_TEXT_EXTS.has(file.name.split('.').pop().toLowerCase())) return true;
  if (file.type && (file.type.startsWith('text/') || file.type === 'application/json')) return true;
  return false;
}

function _isDocFile(file) {
  return _DOC_EXTS.has(file.name.split('.').pop().toLowerCase());
}

function _readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      // data URL: "data:<mime>;base64,<data>" — strip the prefix
      const base64 = e.target.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function _readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (_isImageFile(file)) {
      reader.onload = e => resolve({ name: file.name, mimeType: file.type || 'image/png', dataUrl: e.target.result, size: file.size });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    } else {
      reader.onload = e => resolve({ name: file.name, mimeType: file.type || 'text/plain', content: e.target.result, size: file.size });
      reader.onerror = reject;
      reader.readAsText(file);
    }
  });
}

async function _parseDocFile(file) {
  const dataBase64 = await _readFileAsBase64(file);
  const res = await fetch('/api/operator/parse-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mimeType: file.type, dataBase64 }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Parse failed');
  return { name: file.name, mimeType: 'text/plain', content: data.text, size: file.size };
}

async function _addFiles(fileList) {
  const MAX_BYTES = 20 * 1024 * 1024;
  for (const file of fileList) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!_isImageFile(file) && !_isTextFile(file) && !_isDocFile(file)) {
      showToast(`Unsupported file type: .${ext}`, 'error'); continue;
    }
    if (file.size > MAX_BYTES) {
      showToast(`${file.name} is too large (max 20 MB)`, 'error'); continue;
    }
    if (pendingAttachments.some(a => a.name === file.name)) continue;
    try {
      let att;
      if (_isDocFile(file)) {
        showToast(`Extracting text from ${file.name}…`, 'info');
        att = await _parseDocFile(file);
      } else {
        att = await _readFile(file);
      }
      pendingAttachments.push(att);
    } catch (err) {
      showToast(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }
  _renderAttachments();
}

function _renderAttachments() {
  const bar = document.getElementById('chat-attachments');
  if (!pendingAttachments.length) {
    bar.classList.remove('has-items');
    bar.innerHTML = '';
    return;
  }
  bar.classList.add('has-items');
  bar.innerHTML = pendingAttachments.map((a, i) => `
    <div class="attachment-chip">
      ${a.dataUrl
        ? `<img class="attachment-thumb" src="${a.dataUrl}" alt="${escOp(a.name)}">`
        : `<span class="attachment-file-icon">${a.name.endsWith('.pdf') ? '📕' : a.name.endsWith('.docx') ? '📘' : '📄'}</span>`}
      <span class="attachment-name" title="${escOp(a.name)}">${escOp(a.name)}</span>
      <button class="attachment-remove" onclick="removeAttachment(${i})" title="Remove">×</button>
    </div>`).join('');
}

function removeAttachment(index) {
  pendingAttachments.splice(index, 1);
  _renderAttachments();
}

function _appendUserBubble(message, attachments) {
  const messages = document.getElementById('operator-messages');
  const wrapper  = document.createElement('div');
  wrapper.className = 'message user';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'You';
  wrapper.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (message) bubble.innerHTML = escOp(message).replace(/\n/g, '<br>');

  if (attachments.length) {
    const row = document.createElement('div');
    row.className = 'msg-attachments';
    for (const a of attachments) {
      if (a.dataUrl) {
        const img = document.createElement('img');
        img.className = 'msg-attachment-img';
        img.src = a.dataUrl;
        img.alt = a.name;
        row.appendChild(img);
      } else {
        const chip = document.createElement('span');
        chip.className = 'msg-file-chip';
        chip.textContent = `📄 ${a.name}`;
        row.appendChild(chip);
      }
    }
    bubble.appendChild(row);
  }

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  scrollToBottom('operator-messages');
}

async function onFilePicked(event) {
  const files = event.target.files;
  if (files.length) await _addFiles(files);
  event.target.value = '';
}

// Drag-drop wiring — called once on page load
let _dragCounter = 0;

function _initDragDrop() {
  const chatEl = document.getElementById('operator-messages').closest('.op-main-chat');
  const overlay = document.getElementById('drag-overlay');

  chatEl.addEventListener('dragenter', e => {
    if (!currentSessionId || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    _dragCounter++;
    overlay.classList.add('active');
  });

  chatEl.addEventListener('dragleave', () => {
    _dragCounter--;
    if (_dragCounter <= 0) { _dragCounter = 0; overlay.classList.remove('active'); }
  });

  chatEl.addEventListener('dragover', e => {
    if (!currentSessionId) return;
    e.preventDefault();
  });

  chatEl.addEventListener('drop', async e => {
    e.preventDefault();
    _dragCounter = 0;
    overlay.classList.remove('active');
    if (!currentSessionId) return;
    const files = e.dataTransfer.files;
    if (files.length) await _addFiles(files);
  });
}

// ───────────────────────────────────────────────
//  HELPERS
// ───────────────────────────────────────────────

function _stripToolCalls(text) {
  // Remove complete <tool_call>...</tool_call> blocks
  let s = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  // Remove a partial block that's still streaming (opening tag present, closing tag not yet)
  s = s.replace(/\s*<tool_call>[\s\S]*$/, '');
  return s.trim();
}

function _updateOpBubble(wrapperEl, text) {
  const bubble = wrapperEl.querySelector('.message-bubble');
  if (!bubble) return;
  const display = _stripToolCalls(text);
  if (display) {
    bubble.innerHTML = renderMarkdown(display);
    wrapperEl.style.display = '';
  } else {
    // Pure tool-call response with no surrounding prose — hide the empty bubble
    wrapperEl.style.display = 'none';
  }
  scrollToBottom('operator-messages');
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function formatSessionId(id) {
  // Convert ISO-like timestamp back to readable form
  return id.replace(/T/, ' ').replace(/-(\d{2})-(\d{2})-(\d{3})Z?$/, '.$1:$2.$3').slice(0, 19);
}

function escOp(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escAttrRaw(val) {
  return String(val || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

// ── Expose globals ──
window.loadAgents = loadAgents;
window.launchAgent = launchAgent;
window.exitChat = exitChat;
window.toggleSessionsPanel = toggleSessionsPanel;
window.respondToApproval = respondToApproval;

window.onFilePicked = onFilePicked;
window.removeAttachment = removeAttachment;
window.toggleToolsPanel = toggleToolsPanel;
window.toggleSessionSkill = toggleSessionSkill;
window.toggleMemory = toggleMemory;
window.resetMemory = resetMemory;
window.toggleAutoApprove = toggleAutoApprove;
window.toggleMemoryPanel = toggleMemoryPanel;
window.submitAddMemoryEntry = submitAddMemoryEntry;
window.startEditMemory = startEditMemory;
window.cancelEditMemory = cancelEditMemory;
window.saveEditMemory = saveEditMemory;
window.deleteMemoryEntryById = deleteMemoryEntryById;
window.confirmDeleteOperatorAgent = confirmDeleteOperatorAgent;
window.deleteSession = deleteSession;
window.viewSession = viewSession;

_initDragDrop();
