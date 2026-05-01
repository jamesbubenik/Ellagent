'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let _skills      = [];   // [{name, description, type, requiresApproval}]
let _selected    = null; // full skill object with source
let _mode        = null; // null | 'view' | 'edit' | 'new'
let _chatHistory = [];   // [{role, content}] — resets on each edit/new session

// ── Entry point ───────────────────────────────────────────────────────────────

async function loadSkillsView() {
  _selected    = null;
  _mode        = null;
  _chatHistory = [];
  await _fetchList();
  _renderList();
  _showHome();
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function _fetchList() {
  try {
    const res  = await fetch('/api/skills');
    const data = await res.json();
    _skills = (data.skills || []).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'pre-built' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    _skills = [];
  }
}

// ── State transitions ─────────────────────────────────────────────────────────

function _showHome() {
  document.getElementById('skills-home').style.display      = '';
  document.getElementById('skills-workspace').style.display = 'none';
}

function _showWorkspace() {
  document.getElementById('skills-home').style.display      = 'none';
  document.getElementById('skills-workspace').style.display = '';
}

function skillBack() {
  _selected = null;
  _mode     = null;
  _showHome();
}

// ── Card list (home state) ────────────────────────────────────────────────────

function _renderList() {
  const body = document.getElementById('skills-list-body');
  body.innerHTML = '';

  if (_skills.length === 0) {
    body.innerHTML = `
      <div class="creator-empty-state">
        <div class="creator-empty-icon">⚡</div>
        <div class="creator-empty-text">No skills loaded</div>
        <div class="creator-empty-sub">Click "+ New Skill" to create your first skill</div>
      </div>`;
    return;
  }

  const preBuilt  = _skills.filter(s => s.type === 'pre-built');
  const generated = _skills.filter(s => s.type === 'generated');
  let html = '';

  if (preBuilt.length) {
    html += `<div class="skills-group-label">Pre-built</div>`;
    html += preBuilt.map(_renderSkillCard).join('');
  }
  if (generated.length) {
    html += `<div class="skills-group-label${preBuilt.length ? ' skills-group-label-gap' : ''}">Generated</div>`;
    html += generated.map(_renderSkillCard).join('');
  }

  body.innerHTML = html;
}

function _renderSkillCard(s) {
  return `
    <div class="skill-card" onclick="_selectSkill('${_esc(s.name)}')">
      <div class="skill-card-header">
        <div class="skill-card-name">${_esc(s.name)}</div>
        <div class="skill-card-badges">
          <span class="skill-type-badge skill-type-${s.type}">${s.type === 'pre-built' ? 'pre-built' : 'generated'}</span>
          ${s.requiresApproval ? '<span class="skill-approval-badge">approval</span>' : ''}
        </div>
      </div>
      ${s.description ? `<div class="skill-card-desc">${_esc(s.description)}</div>` : ''}
    </div>`;
}

// ── View mode ─────────────────────────────────────────────────────────────────

async function _selectSkill(name) {
  try {
    const res  = await fetch(`/api/skills/${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to load skill', 'error'); return; }
    _selected    = data.skill;
    _mode        = 'view';
    _chatHistory = [];
    _renderView();
  } catch (err) {
    showToast('Failed to load skill: ' + err.message, 'error');
  }
}

function _renderView() {
  _showWorkspace();
  const isGenerated = _selected.type === 'generated';
  const approved    = !!_selected.requiresApproval;

  document.getElementById('skills-detail-content').innerHTML = `
    <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;padding-right:14px;flex-shrink:0;">
      <span>${_esc(_selected.name)}</span>
      <div style="display:flex;gap:8px;align-items:center;">
        ${isGenerated
          ? `<button class="btn btn-ghost btn-sm" onclick="skillEdit()">Edit</button>
             <button class="btn btn-danger btn-sm" onclick="skillDelete()">Delete</button>`
          : `<span class="skill-readonly-label">pre-built · read-only</span>`}
        <button class="btn btn-ghost btn-sm" onclick="skillBack()">← Back</button>
      </div>
    </div>

    <div class="skill-detail-scroll">
      <div class="skill-detail-badges">
        <span class="skill-type-badge skill-type-${_selected.type}">${_selected.type === 'pre-built' ? 'pre-built' : 'generated'}</span>
      </div>

      <div class="skill-approval-row">
        <span class="skill-approval-row-label">Requires Approval</span>
        <button class="skill-approval-toggle ${approved ? 'on' : ''}"
                onclick="skillToggleApproval()"
                title="Toggle approval requirement">
          <span class="skill-approval-toggle-thumb"></span>
          <span class="skill-approval-toggle-text">${approved ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      ${_selected.description ? `<p class="skill-detail-desc">${_esc(_selected.description)}</p>` : ''}

      <div class="skill-section-label">Source</div>
      <pre class="skill-code-block">${_esc(_selected.source)}</pre>

      <div class="skill-logs-header">
        <div class="skill-section-label" style="margin-bottom:0;">Usage Logs</div>
        <button class="btn btn-ghost btn-sm" onclick="_loadSkillLogs()">Refresh</button>
      </div>
      <div id="skill-logs-body" class="skill-logs-body">
        <div class="skill-logs-loading">Loading…</div>
      </div>
    </div>`;

  _loadSkillLogs();
}

async function _loadSkillLogs() {
  const body = document.getElementById('skill-logs-body');
  if (!body) return;
  body.innerHTML = '<div class="skill-logs-loading">Loading…</div>';
  try {
    const res  = await fetch(`/api/skills/${encodeURIComponent(_selected.name)}/logs`);
    const data = await res.json();
    if (!res.ok) { body.innerHTML = `<div class="skill-log-entry skill-log-error">Error: ${_esc(data.error)}</div>`; return; }
    const logs = data.logs || [];
    if (logs.length === 0) {
      body.innerHTML = '<div class="skill-logs-empty">No usage logs yet for this skill.</div>';
      return;
    }
    body.innerHTML = logs.map(_renderLogEntry).join('');
  } catch (err) {
    body.innerHTML = `<div class="skill-log-entry skill-log-error">Failed to load logs: ${_esc(err.message)}</div>`;
  }
}

function _renderLogEntry(entry) {
  const ts      = new Date(entry.ts).toLocaleString();
  const event   = entry.event || '';
  const session = entry.sessionId ? `<span class="skill-log-session" title="${_esc(entry.sessionId)}">${_esc(entry.sessionId.slice(0, 8))}…</span>` : '';
  const agent   = entry.agentSlug ? `<span class="skill-log-agent">${_esc(entry.agentSlug)}</span>` : '';

  let levelClass = 'skill-log-info';
  let detail     = '';

  if (event === 'call_result') {
    levelClass = entry.success ? 'skill-log-success' : 'skill-log-error';
    const dur  = entry.durationMs != null ? ` · ${entry.durationMs}ms` : '';
    if (!entry.success && entry.error) {
      detail = `<div class="skill-log-detail skill-log-detail-error">${_esc(String(entry.error))}</div>`;
    } else if (entry.result) {
      detail = `<div class="skill-log-detail">${_esc(String(entry.result))}</div>`;
    }
    return `<div class="skill-log-entry ${levelClass}">
      <div class="skill-log-meta">
        <span class="skill-log-ts">${ts}</span>
        <span class="skill-log-event">${_esc(event)}</span>
        ${agent}${session}
        <span class="skill-log-status">${entry.success ? '✓' : '✗'}${dur}</span>
      </div>
      ${detail}
    </div>`;
  }

  if (event === 'call_blocked') {
    levelClass = 'skill-log-warn';
    if (entry.reason) detail = `<div class="skill-log-detail">${_esc(entry.reason)}</div>`;
  } else if (event === 'approval_required' || event === 'approval_response') {
    levelClass = entry.approved === false ? 'skill-log-warn' : 'skill-log-info';
    if (event === 'approval_response') {
      detail = `<div class="skill-log-detail">${entry.approved ? 'Approved' : 'Denied'}</div>`;
    }
  } else if (event === 'call_start' && entry.params) {
    try {
      const p = typeof entry.params === 'string' ? entry.params : JSON.stringify(entry.params);
      detail = `<div class="skill-log-detail">${_esc(p)}</div>`;
    } catch {}
  }

  return `<div class="skill-log-entry ${levelClass}">
    <div class="skill-log-meta">
      <span class="skill-log-ts">${ts}</span>
      <span class="skill-log-event">${_esc(event)}</span>
      ${agent}${session}
    </div>
    ${detail}
  </div>`;
}

// ── Edit / New mode ───────────────────────────────────────────────────────────

function _renderEditor({ nameEditable, initialName, initialCode, saveLabel, onSave }) {
  _showWorkspace();
  _chatHistory = [];

  const panelTitle = nameEditable ? 'New Skill' : _esc(initialName);
  const nameField  = nameEditable
    ? `<input class="skill-name-input" id="skill-name-input" type="text"
         placeholder="my-skill-name" value="${_esc(initialName)}"
         spellcheck="false" autocomplete="off" />`
    : `<div class="skill-detail-name">${_esc(initialName)}</div>`;

  document.getElementById('skills-detail-content').innerHTML = `
    <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;padding-right:14px;flex-shrink:0;">
      <span>${panelTitle}</span>
      <button class="btn btn-ghost btn-sm" onclick="_cancelEditor()">← Back</button>
    </div>

    <div class="skill-editor-layout">

      <!-- Left: code editor -->
      <div class="skill-editor-left">
        <div class="skill-detail-header">
          <div class="skill-detail-title-row">${nameField}</div>
        </div>
        <div class="skill-section-label">Source</div>
        <textarea class="skill-code-textarea" id="skill-code-editor"
                  spellcheck="false">${_esc(initialCode)}</textarea>
        <div id="skill-editor-error" class="skill-error-msg" style="display:none;"></div>
        <div class="skill-editor-actions">
          <button class="btn btn-accent btn-sm" onclick="_saveSkill()">
            <span id="skill-save-label">${_esc(saveLabel)}</span>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="_cancelEditor()">Cancel</button>
        </div>
      </div>

      <!-- Right: skill assistant chat -->
      <div class="skill-chat-panel">
        <div class="skill-chat-panel-header">
          <div class="skill-chat-panel-title">Skill Assistant</div>
          <div class="skill-chat-panel-hint">Describe changes and the AI will suggest updated code</div>
        </div>
        <div class="skill-chat-messages" id="skill-chat-messages">
          <div class="skill-chat-welcome">
            Ask me to add features, fix bugs, or explain what the skill does.
            When I suggest code changes I'll give you an <strong>Apply</strong> button.
          </div>
        </div>
        <div class="skill-chat-input-row">
          <textarea class="skill-chat-input" id="skill-chat-input"
                    placeholder="e.g. add retry on failure, add input validation…"
                    rows="2"></textarea>
          <div class="skill-chat-input-actions">
            <button class="btn btn-accent btn-sm" id="skill-chat-send" onclick="_sendSkillChat()">Send</button>
          </div>
        </div>
      </div>

    </div>`;

  window._skillSaveCallback = onSave;

  document.getElementById('skill-chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendSkillChat(); }
  });

  setTimeout(() => {
    const el = document.getElementById('skill-name-input') || document.getElementById('skill-code-editor');
    if (el) el.focus();
  }, 0);
}

// ── Actions ───────────────────────────────────────────────────────────────────

function skillNew() {
  _selected = null;
  _mode     = 'new';
  _renderEditor({
    nameEditable: true,
    initialName:  '',
    initialCode:  _newSkillTemplate(),
    saveLabel:    'Create Skill',
    onSave:       _doCreate,
  });
}

function skillEdit() {
  if (!_selected) return;
  _mode = 'edit';
  _renderEditor({
    nameEditable: false,
    initialName:  _selected.name,
    initialCode:  _selected.source,
    saveLabel:    'Save Changes',
    onSave:       _doUpdate,
  });
}

async function skillDelete() {
  if (!_selected) return;
  if (!confirm(`Delete skill "${_selected.name}"?\nThis cannot be undone.`)) return;
  try {
    const res  = await fetch(`/api/skills/${encodeURIComponent(_selected.name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Delete failed', 'error'); return; }
    showToast(`Skill "${_selected.name}" deleted`, 'success');
    await _fetchList();
    _renderList();
    skillBack();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function skillToggleApproval() {
  if (!_selected) return;
  const newValue = !_selected.requiresApproval;

  try {
    const res  = await fetch(`/api/skills/${encodeURIComponent(_selected.name)}/approval`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requiresApproval: newValue }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not update approval', 'error'); return; }
    showToast(`Requires approval ${newValue ? 'enabled' : 'disabled'}`, 'success');
    await _fetchList();
    _renderList();
    await _selectSkill(_selected.name);
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function _cancelEditor() {
  if (_selected && _mode === 'edit') {
    _mode = 'view';
    _renderView();
  } else {
    skillBack();
  }
}

async function _saveSkill() {
  if (window._skillSaveCallback) await window._skillSaveCallback();
}

async function _doCreate() {
  const nameEl = document.getElementById('skill-name-input');
  const codeEl = document.getElementById('skill-code-editor');
  const name   = nameEl ? nameEl.value.trim() : '';
  const code   = codeEl ? codeEl.value : '';

  if (!name) { _showEditorError('Skill name is required'); return; }
  if (!/^[a-z0-9-]+$/.test(name)) { _showEditorError('Name must be lowercase letters, numbers, and hyphens only'); return; }

  _setEditorBusy(true);
  try {
    const res  = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    const data = await res.json();
    if (!res.ok) { _showEditorError(data.error || 'Create failed'); return; }
    showToast(`Skill "${name}" created`, 'success');
    await _fetchList();
    _renderList();
    await _selectSkill(name);
  } catch (err) {
    _showEditorError('Create failed: ' + err.message);
  } finally {
    _setEditorBusy(false);
  }
}

async function _doUpdate() {
  const codeEl = document.getElementById('skill-code-editor');
  const code   = codeEl ? codeEl.value : '';
  _setEditorBusy(true);
  try {
    const res  = await fetch(`/api/skills/${encodeURIComponent(_selected.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) { _showEditorError(data.error || 'Save failed'); return; }
    showToast(`Skill "${_selected.name}" updated`, 'success');
    await _fetchList();
    _renderList();
    await _selectSkill(_selected.name);
  } catch (err) {
    _showEditorError('Save failed: ' + err.message);
  } finally {
    _setEditorBusy(false);
  }
}

// ── Skill chat ────────────────────────────────────────────────────────────────

async function _sendSkillChat() {
  const inputEl = document.getElementById('skill-chat-input');
  const sendBtn = document.getElementById('skill-chat-send');
  const message = inputEl ? inputEl.value.trim() : '';
  if (!message) return;

  const code = (document.getElementById('skill-code-editor') || {}).value || _selected?.source || '';

  inputEl.value = '';
  inputEl.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  _appendChatMessage('user', message);
  _chatHistory.push({ role: 'user', content: message });

  const thinking = _appendChatThinking();

  try {
    const res  = await fetch('/api/skills/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, message, history: _chatHistory.slice(-6) }),
    });
    const data = await res.json();
    thinking.remove();

    if (!res.ok) {
      _appendChatMessage('error', data.error || 'Request failed');
      return;
    }

    _chatHistory.push({ role: 'assistant', content: data.response });
    _appendChatAssistant(data.response);
  } catch (err) {
    thinking.remove();
    _appendChatMessage('error', err.message);
  } finally {
    if (inputEl) inputEl.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (inputEl) inputEl.focus();
  }
}

function _appendChatMessage(role, text) {
  const box = document.getElementById('skill-chat-messages');
  if (!box) return null;
  const el = document.createElement('div');
  el.className = `skill-chat-msg skill-chat-msg-${role}`;
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function _appendChatThinking() {
  const box = document.getElementById('skill-chat-messages');
  const el  = document.createElement('div');
  el.className = 'skill-chat-msg skill-chat-msg-thinking';
  el.innerHTML = '<span class="skill-chat-dots"><span></span><span></span><span></span></span>';
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function _appendChatAssistant(text) {
  const box = document.getElementById('skill-chat-messages');
  if (!box) return;

  const codeMatch = /```(?:javascript|js)?\s*([\s\S]*?)```/.exec(text);
  const el = document.createElement('div');
  el.className = 'skill-chat-msg skill-chat-msg-assistant';

  if (codeMatch) {
    const code        = codeMatch[1].trim();
    const beforeBlock = text.slice(0, codeMatch.index).trim();
    const afterBlock  = text.slice(codeMatch.index + codeMatch[0].length).trim();

    let html = '';
    if (beforeBlock) html += `<div class="skill-chat-text">${_escNl(beforeBlock)}</div>`;
    html += `<div class="skill-chat-action-card">
      <span class="skill-chat-action-card-label">✓ Code change ready</span>
      <button class="btn btn-sm skill-chat-apply">Apply →</button>
    </div>`;
    if (afterBlock) html += `<div class="skill-chat-text" style="margin-top:6px;">${_escNl(afterBlock)}</div>`;
    el.innerHTML = html;

    el.querySelector('.skill-chat-apply').onclick = () => {
      const textarea = document.getElementById('skill-code-editor');
      if (textarea) {
        textarea.value = code;
        const errEl = document.getElementById('skill-editor-error');
        if (errEl) errEl.style.display = 'none';
        showToast('Code applied — review and save when ready', 'success');
      }
    };
  } else {
    el.innerHTML = `<div class="skill-chat-text">${_escNl(text)}</div>`;
  }

  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// ── Editor helpers ────────────────────────────────────────────────────────────

function _showEditorError(msg) {
  const el = document.getElementById('skill-editor-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}

function _setEditorBusy(busy) {
  const btn = document.querySelector('#skill-save-label');
  if (!btn) return;
  const saveBtn = btn.closest('button');
  if (saveBtn) saveBtn.disabled = busy;
  btn.textContent = busy ? 'Saving…' : (window._skillSaveCallback === _doCreate ? 'Create Skill' : 'Save Changes');
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _escNl(str) {
  return _esc(str).replace(/\n/g, '<br>');
}

function _newSkillTemplate() {
  return `'use strict';

module.exports = {
  name: 'my-skill',
  description: 'Describe what this skill does.',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Input parameter',
      },
    },
    required: ['input'],
  },

  execute: async ({ input }) => {
    // Your skill code here
    return { success: true, result: { output: input } };
  },
};`;
}
