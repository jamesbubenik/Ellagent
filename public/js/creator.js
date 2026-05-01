'use strict';

// ── Creator State ──
let creatorSessionId      = null;
let currentDraft          = null;
let creatorBusy           = false;
let availableSkills       = [];
let isEditMode            = false;
let editingAgentSlug      = null;   // slug of agent being edited
let lastCreatedSlug       = null;   // for "Open in Operator" after success
let _manuallyEditedFields = new Set(); // fields the user explicitly typed in this session

// ── Boot ──
(async function initCreator() {
  await Promise.all([loadAvailableSkills(), loadGlobalMcpServers()]);
  showCreatorHome();
})();

async function loadAvailableSkills() {
  try {
    const res = await fetch('/api/creator/skills');
    const data = await res.json();
    availableSkills = data.skills || [];
  } catch {
    availableSkills = [];
  }
}

// ───────────────────────────────────────────────
//  STATE MANAGEMENT
// ───────────────────────────────────────────────

function showCreatorHome() {
  document.getElementById('creator-home').style.display = '';
  document.getElementById('creator-workspace').style.display = 'none';
  document.getElementById('creator-success').style.display = 'none';
  isEditMode = false;
  editingAgentSlug = null;
  loadCreatorAgentHistory();
}

function startNewAgent() {
  _resetWorkspace({ editMode: false, editingSlug: null });
}

function startEditAgent(slug, name) {
  _resetWorkspace({ editMode: true, editingSlug: slug, editingName: name });
  // Pre-load the agent's current data into the preview panel
  _loadAgentIntoPreview(slug);
  // Check if a backup exists
  _refreshRestoreButton(slug);
}

function _resetWorkspace({ editMode, editingSlug, editingName }) {
  creatorSessionId      = null;
  currentDraft          = null;
  creatorBusy           = false;
  isEditMode            = editMode;
  editingAgentSlug      = editingSlug || null;
  lastCreatedSlug       = null;
  _manuallyEditedFields = new Set();

  document.getElementById('creator-home').style.display = 'none';
  document.getElementById('creator-workspace').style.display = '';
  document.getElementById('creator-success').style.display = 'none';

  // Edit mode badge
  const badge = document.getElementById('edit-mode-badge');
  if (editMode) {
    badge.textContent = `✏ Editing: ${editingName || editingSlug}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  // Finalize button label
  document.getElementById('finalize-btn').textContent = editMode
    ? '✓ Save Changes'
    : '✓ Finalize & Create Agent';
  document.getElementById('finalize-btn').disabled = true;

  // Restore button — only show in edit mode, availability determined by API
  document.getElementById('restore-btn').style.display = editMode ? '' : 'none';
  document.getElementById('restore-btn').disabled = true;

  // Clear chat
  const msgs = document.getElementById('creator-messages');
  msgs.innerHTML = '';
  if (editMode) {
    appendCreatorSystemMsg(`Loaded agent for editing. Describe what you want to change — or edit the fields directly on the right.`);
  } else {
    appendCreatorSystemMsg(`Describe the agent you want to build — or fill in the fields on the right directly. When you're happy, hit Finalize.`);
  }

  if (!editMode) clearPreviewPanel();

  const input = document.getElementById('creator-input');
  input.value = '';
  input.style.height = 'auto';
  input.focus();
}

async function _loadAgentIntoPreview(slug) {
  try {
    const res = await fetch(`/api/operator/agents/${slug}`);
    const data = await res.json();
    const agent = data.agent;
    if (!agent) return;

    currentDraft = {
      name: agent.name,
      slug: agent.slug,
      description: agent.description || '',
      systemPrompt: agent.systemPrompt || '',
      soul: agent.soul || '',
      requiredSkills: agent.requiredSkills || [],
      generateSkills: [],
      initialMemory: '',
      memoryEnabled: !!agent.memoryEnabled,
      enabledMcpServers: agent.enabledMcpServers || [],
    };
    populatePreviewPanel(currentDraft);
    // Mark slug as user-edited so it doesn't get auto-overwritten
    document.getElementById('prev-slug').dataset.userEdited = '1';
  } catch (err) {
    appendCreatorSystemMsg(`Could not load agent: ${err.message}`);
  }
}

async function _refreshRestoreButton(slug) {
  try {
    const res = await fetch(`/api/creator/backup-status/${slug}`);
    const data = await res.json();
    const btn = document.getElementById('restore-btn');
    btn.disabled = !data.hasBackup;
    if (data.hasBackup) {
      btn.title = 'Restore to the last backup of this agent';
    } else {
      btn.title = 'No backup available yet — one will be created when you save changes';
    }
  } catch {
    document.getElementById('restore-btn').disabled = true;
  }
}

function cancelCreation() {
  if (creatorBusy) return;
  const hasContent = currentDraft ||
    document.getElementById('prev-name').value.trim() ||
    document.getElementById('prev-systemprompt').value.trim();
  if (hasContent && !confirm('Go back? Your unsaved changes will be lost.')) return;
  showCreatorHome();
}

function showSuccessState(manifest, skillsGenerated = [], skillErrors = []) {
  lastCreatedSlug = manifest.slug;

  document.getElementById('creator-home').style.display = 'none';
  document.getElementById('creator-workspace').style.display = 'none';
  document.getElementById('creator-success').style.display = '';

  const titleEl = document.getElementById('success-title');
  titleEl.textContent = isEditMode ? 'Agent Updated!' : 'Agent Created!';

  document.getElementById('success-agent-name').textContent = manifest.name;
  document.getElementById('success-agent-slug').textContent = manifest.slug;

  const parts = [];
  const totalSkills = (manifest.requiredSkills || []).length + (manifest.generatedSkills || []).length;
  if (totalSkills > 0) parts.push(`${totalSkills} skill${totalSkills !== 1 ? 's' : ''}`);
  if (skillsGenerated.length > 0) parts.push(`✓ ${skillsGenerated.length} generated: ${skillsGenerated.join(', ')}`);

  const summaryEl = document.getElementById('success-skill-summary');
  summaryEl.textContent = parts.join(' · ');

  // Show skill errors with details
  const existingErrors = document.getElementById('success-skill-errors');
  if (existingErrors) existingErrors.remove();
  if (skillErrors.length > 0) {
    const errDiv = document.createElement('div');
    errDiv.id = 'success-skill-errors';
    errDiv.style.cssText = 'margin-top:10px; padding:10px 12px; background:var(--danger-bg,rgba(239,68,68,0.1)); border:1px solid var(--danger); border-radius:6px; font-size:12px; color:var(--danger); text-align:left;';
    errDiv.innerHTML = `<strong>Skill generation errors (${skillErrors.length}):</strong><br>` +
      skillErrors.map(e => `• <strong>${escHtml(e.skillName)}</strong>: ${escHtml(e.error)}`).join('<br>');
    summaryEl.after(errDiv);
  }
}

function openCreatedInOperator() {
  if (!lastCreatedSlug) return;
  switchView('operator');
  setTimeout(() => launchAgent(lastCreatedSlug), 120);
}

// ───────────────────────────────────────────────
//  CREATOR HISTORY
// ───────────────────────────────────────────────

async function loadCreatorAgentHistory() {
  const listEl = document.getElementById('creator-agent-list');
  listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px 0;">Loading...</div>';

  try {
    const res = await fetch('/api/operator/agents');
    const data = await res.json();
    const agents = data.agents || [];

    if (agents.length === 0) {
      listEl.innerHTML = `
        <div class="creator-empty-state">
          <div class="creator-empty-icon">🤖</div>
          <div class="creator-empty-text">No agents yet</div>
          <div class="creator-empty-sub">Click "New Agent" to design your first AI agent</div>
        </div>`;
      return;
    }

    listEl.innerHTML = agents.map(agent => {
      const totalSkills = (agent.requiredSkills || []).length + (agent.generatedSkills || []).length;
      const s = escAttr(agent.slug);
      const n = escAttr(agent.name);
      return `
        <div class="creator-agent-card">
          <div class="creator-agent-card-header">
            <div class="agent-card-avatar">${makeAvatar(agent.name)}</div>
            <div class="creator-agent-card-info">
              <div class="creator-agent-card-name">${escHtml(agent.name)}</div>
              <div class="creator-agent-card-slug">${escHtml(agent.slug)}</div>
            </div>
            <div class="creator-agent-card-actions">
              <button class="btn btn-ghost" style="font-size:12px; padding:5px 11px;"
                onclick="startEditAgent(${s}, ${n})">✏ Edit</button>
              <button class="btn btn-ghost" style="font-size:12px; padding:5px 11px;"
                onclick="launchCreatedAgent(${s})">Open →</button>
              <button class="btn-icon-delete"
                onclick="confirmDeleteAgent(${s}, ${n})" title="Delete agent">🗑</button>
            </div>
          </div>
          <div class="creator-agent-card-desc">${escHtml(agent.description || 'No description')}</div>
          <div class="creator-agent-card-meta">
            <span>Created ${formatDate(agent.createdAt)}${agent.updatedAt && agent.updatedAt !== agent.createdAt ? ' · Updated ' + formatDate(agent.updatedAt) : ''}</span>
            <span>${totalSkills} skill${totalSkills !== 1 ? 's' : ''}</span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--danger); font-size:13px;">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

function confirmDeleteAgent(slug, name) {
  showDeleteModal(name, slug, async () => {
    try {
      const res = await fetch(`/api/operator/agents/${slug}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(`"${name}" deleted`, 'success');
        loadCreatorAgentHistory();
        refreshSidebarAgents();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(`Delete failed: ${err.error || res.status}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });
}

function launchCreatedAgent(slug) {
  switchView('operator');
  setTimeout(() => launchAgent(slug), 120);
}

// ───────────────────────────────────────────────
//  CREATOR CHAT
// ───────────────────────────────────────────────

const creatorInputEl = document.getElementById('creator-input');
creatorInputEl.addEventListener('input', () => {
  creatorInputEl.style.height = 'auto';
  creatorInputEl.style.height = Math.min(creatorInputEl.scrollHeight, 140) + 'px';
});

function handleCreatorKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCreatorMessage();
  }
}

async function sendCreatorMessage() {
  const input = document.getElementById('creator-input');
  const message = input.value.trim();
  if (!message || creatorBusy) return;

  input.value = '';
  input.style.height = 'auto';
  creatorBusy = true;
  document.getElementById('creator-send-btn').disabled = true;

  appendCreatorUserMsg(message);
  const typingEl = appendCreatorTyping();

  try {
    const res = await fetch('/api/creator/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: creatorSessionId,
        message,
        editingSlug: isEditMode ? editingAgentSlug : undefined,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantEl = null;
    let fullText = '';
    let typingGone = false;

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

          if (evt.type === 'session') {
            creatorSessionId = evt.sessionId;
          } else if (evt.type === 'chunk') {
            if (!typingGone) { typingEl.remove(); typingGone = true; }
            if (!assistantEl) assistantEl = appendCreatorAssistantMsg('');
            fullText += evt.content;
            updateCreatorBubble(assistantEl, fullText);
          } else if (evt.type === 'draft') {
            mergeIntoDraft(evt.draft);
            populatePreviewPanel(currentDraft);
            updateFinalizeButton();
            _flashPreviewPanel('ok');
          } else if (evt.type === 'draft_error') {
            // Partial-populate with whatever the LLM gave us even if schema failed
            if (evt.rawDraft) {
              mergeIntoDraft(evt.rawDraft);
              populatePreviewPanel(currentDraft);
              updateFinalizeButton();
              _flashPreviewPanel('warn');
            }
            const detail = Array.isArray(evt.errors) ? evt.errors.join('; ') : String(evt.errors || 'unknown');
            appendCreatorSystemMsg(`⚠ Preview partially filled — some fields may need fixing: ${detail}`);
          } else if (evt.type === 'error') {
            if (!typingGone) { typingEl.remove(); typingGone = true; }
            appendCreatorSystemMsg(`Error: ${evt.error}`);
          }
        } catch { /* skip */ }
      }
    }

    if (!typingGone) typingEl.remove();
  } catch (err) {
    typingEl.remove();
    appendCreatorSystemMsg(`Connection error: ${err.message}`);
  } finally {
    creatorBusy = false;
    document.getElementById('creator-send-btn').disabled = false;
    scrollChatToBottom();
  }
}

// Merge LLM draft, protecting only fields the user manually typed during this session.
// In edit mode all fields start pre-populated but NOT marked as manually edited,
// so the LLM's changes always come through unless the user has since typed in that field.
function mergeIntoDraft(llmDraft) {
  if (!currentDraft) {
    currentDraft = Object.assign({}, llmDraft);
    return;
  }
  const f = _manuallyEditedFields;
  if (!f.has('name'))         currentDraft.name         = llmDraft.name         ?? currentDraft.name;
  if (!f.has('description'))  currentDraft.description  = llmDraft.description  ?? currentDraft.description;
  if (!f.has('systemPrompt')) currentDraft.systemPrompt = llmDraft.systemPrompt ?? currentDraft.systemPrompt;
  if (!f.has('soul'))         currentDraft.soul         = llmDraft.soul         ?? currentDraft.soul;
  if (!f.has('slug'))         currentDraft.slug         = llmDraft.slug         ?? currentDraft.slug;
  if (!f.has('initialMemory')) currentDraft.initialMemory = llmDraft.initialMemory ?? currentDraft.initialMemory ?? '';
  currentDraft.requiredSkills = llmDraft.requiredSkills ?? currentDraft.requiredSkills ?? [];
  currentDraft.generateSkills = llmDraft.generateSkills ?? currentDraft.generateSkills ?? [];
}

// ───────────────────────────────────────────────
//  EDITABLE PREVIEW PANEL
// ───────────────────────────────────────────────

function clearPreviewPanel() {
  document.getElementById('prev-name').value = '';
  document.getElementById('prev-name').removeAttribute('data-user-edited');
  document.getElementById('prev-slug').value = '';
  document.getElementById('prev-slug').dataset.userEdited = '';
  document.getElementById('prev-description').value = '';
  document.getElementById('prev-systemprompt').value = '';
  document.getElementById('prev-soul').value = '';
  document.getElementById('prev-initial-memory').value = '';
  document.getElementById('prev-memory-enabled').checked = false;
  renderSkillsSection([], []);
  renderMcpSection([]);
  updateFinalizeButton();
}

function populatePreviewPanel(draft) {
  document.getElementById('prev-name').value           = draft.name || '';
  document.getElementById('prev-slug').value           = draft.slug || '';
  document.getElementById('prev-description').value    = draft.description || '';
  document.getElementById('prev-systemprompt').value   = draft.systemPrompt || '';
  document.getElementById('prev-soul').value           = draft.soul || '';
  document.getElementById('prev-initial-memory').value = draft.initialMemory || '';
  document.getElementById('prev-memory-enabled').checked = !!draft.memoryEnabled;
  renderSkillsSection(draft.requiredSkills || [], draft.generateSkills || []);
  renderMcpSection(draft.enabledMcpServers || []);
  updateFinalizeButton();
}

function _flashPreviewPanel(type = 'ok') {
  const header = document.getElementById('preview-panel-header');
  if (!header) return;

  // Update / clear the "updated" badge
  let badge = document.getElementById('preview-updated-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'preview-updated-badge';
    badge.style.cssText = 'font-size:11px; padding:2px 7px; border-radius:4px; transition:opacity 0.4s;';
    header.appendChild(badge);
  }
  badge.textContent = type === 'ok' ? '✓ Updated' : '⚠ Partially filled';
  badge.style.background = type === 'ok' ? 'rgba(34,197,94,0.15)' : 'rgba(234,179,8,0.15)';
  badge.style.color = type === 'ok' ? 'var(--accent)' : '#ca8a04';
  badge.style.opacity = '1';

  // Flash the panel header
  header.style.transition = 'background 0.15s';
  header.style.background = type === 'ok' ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.08)';
  setTimeout(() => { header.style.background = ''; }, 600);

  // Fade badge out after 4 s
  clearTimeout(_flashPreviewPanel._timer);
  _flashPreviewPanel._timer = setTimeout(() => { badge.style.opacity = '0'; }, 4000);
}
_flashPreviewPanel._timer = null;

function onPreviewFieldChange(fieldName) {
  if (fieldName) _manuallyEditedFields.add(fieldName);
  syncFieldsToCurrentDraft();
  updateFinalizeButton();
}

function onNameInput() {
  _manuallyEditedFields.add('name');
  const name = document.getElementById('prev-name').value;
  const slugEl = document.getElementById('prev-slug');
  if (!_manuallyEditedFields.has('slug')) slugEl.value = slugify(name);
  syncFieldsToCurrentDraft();
  updateFinalizeButton();
}

function onSlugInput() {
  _manuallyEditedFields.add('slug');
  const slugEl = document.getElementById('prev-slug');
  slugEl.dataset.userEdited = '1';
  slugEl.value = slugify(slugEl.value);
  syncFieldsToCurrentDraft();
  updateFinalizeButton();
}

function syncFieldsToCurrentDraft() {
  if (!currentDraft) currentDraft = {};
  currentDraft.name          = document.getElementById('prev-name').value.trim();
  currentDraft.slug          = document.getElementById('prev-slug').value.trim() || slugify(currentDraft.name);
  currentDraft.description   = document.getElementById('prev-description').value.trim();
  currentDraft.systemPrompt  = document.getElementById('prev-systemprompt').value.trim();
  currentDraft.soul          = document.getElementById('prev-soul').value.trim();
  currentDraft.initialMemory = document.getElementById('prev-initial-memory').value.trim();
  currentDraft.memoryEnabled = document.getElementById('prev-memory-enabled').checked;
  // enabledMcpServers are mutated in-place by toggleMcpServer — no DOM read needed here
  if (!currentDraft.enabledMcpServers) currentDraft.enabledMcpServers = [];
}

function updateFinalizeButton() {
  syncFieldsToCurrentDraft();
  const ok = currentDraft && currentDraft.name && currentDraft.slug && currentDraft.systemPrompt;
  document.getElementById('finalize-btn').disabled = !ok;
}

// ── Skills section ──
function renderSkillsSection(requiredSkills, generateSkills) {
  if (!currentDraft) currentDraft = {};
  currentDraft.requiredSkills = requiredSkills;
  currentDraft.generateSkills = generateSkills;

  const container = document.getElementById('prev-skills-container');

  const prebuiltHtml = availableSkills.length > 0
    ? availableSkills.map(s => {
        const active = requiredSkills.includes(s.name);
        return `<span class="skill-chip-toggle ${active ? 'active' : ''}"
          onclick="toggleSkill('${escAttrRaw(s.name)}')"
          title="${escHtml(s.description)}${s.requiresApproval ? ' — requires user approval' : ''}">
          ${escHtml(s.name)}${s.requiresApproval ? ' ⚠' : ''}
        </span>`;
      }).join('')
    : '<span style="color:var(--text-muted); font-size:12px;">No pre-built skills loaded</span>';

  const genHtml = generateSkills.map((gs, i) => `
    <div class="gen-skill-item">
      <input class="preview-input-sm name-field" value="${escHtml(gs.skillName)}"
        oninput="updateGenSkillName(${i}, this.value)" placeholder="skill-name" />
      <input class="preview-input-sm" style="flex:1;" value="${escHtml(gs.skillDescription)}"
        oninput="updateGenSkillDesc(${i}, this.value)" placeholder="What this skill does..." />
      <button class="btn-icon-delete" onclick="removeGenSkill(${i})" title="Remove">×</button>
    </div>`).join('');

  container.innerHTML = `
    <div style="margin-bottom:10px;">
      <div class="preview-label" style="margin-bottom:6px;">Pre-built Skills — click to toggle</div>
      <div class="skill-chips" style="gap:6px;">${prebuiltHtml}</div>
    </div>
    <div>
      <div class="preview-label" style="margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;">
        <span>Custom Generated Skills</span>
        <button class="btn-xs" onclick="addGenSkill()">+ Add</button>
      </div>
      <div id="gen-skills-list">${genHtml || '<div style="color:var(--text-muted); font-size:12px; padding:2px 0;">None — the LLM will suggest, or click + Add</div>'}</div>
    </div>`;
}

function toggleSkill(skillName) {
  if (!currentDraft) currentDraft = { requiredSkills: [], generateSkills: [] };
  if (!currentDraft.requiredSkills) currentDraft.requiredSkills = [];
  const idx = currentDraft.requiredSkills.indexOf(skillName);
  if (idx === -1) currentDraft.requiredSkills.push(skillName);
  else currentDraft.requiredSkills.splice(idx, 1);
  renderSkillsSection(currentDraft.requiredSkills, currentDraft.generateSkills || []);
}

function addGenSkill() {
  if (!currentDraft) currentDraft = { requiredSkills: [], generateSkills: [] };
  if (!currentDraft.generateSkills) currentDraft.generateSkills = [];
  currentDraft.generateSkills.push({ skillName: 'new-skill', skillDescription: '' });
  renderSkillsSection(currentDraft.requiredSkills || [], currentDraft.generateSkills);
}

function removeGenSkill(index) {
  if (!currentDraft?.generateSkills) return;
  currentDraft.generateSkills.splice(index, 1);
  renderSkillsSection(currentDraft.requiredSkills || [], currentDraft.generateSkills);
}

function updateGenSkillName(i, v) { if (currentDraft?.generateSkills) currentDraft.generateSkills[i].skillName = slugify(v) || v; }
function updateGenSkillDesc(i, v) { if (currentDraft?.generateSkills) currentDraft.generateSkills[i].skillDescription = v; }

// ── MCP Servers section (toggle chips for global servers) ─────────────────────

let _globalMcpServers = []; // cached list from /api/config/mcp-servers

async function loadGlobalMcpServers() {
  try {
    const res = await fetch('/api/config/mcp-servers');
    const data = await res.json();
    _globalMcpServers = data.mcpServers || [];
  } catch {
    _globalMcpServers = [];
  }
}

function renderMcpSection(enabledMcpServers) {
  if (!currentDraft) currentDraft = {};
  currentDraft.enabledMcpServers = Array.isArray(enabledMcpServers) ? enabledMcpServers : [];

  const container = document.getElementById('prev-mcp-container');
  if (!container) return;

  if (_globalMcpServers.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:2px 0;">No global MCP servers configured — add them in Settings.</div>';
    return;
  }

  const enabled = new Set(currentDraft.enabledMcpServers);
  container.innerHTML = `<div class="mcp-toggle-chips">${
    _globalMcpServers.map(srv => {
      const on = enabled.has(srv.name);
      const transport = srv.transport || (srv.url ? 'http' : 'stdio');
      return `<button class="mcp-toggle-chip${on ? ' mcp-chip-on' : ''}"
        onclick="toggleMcpServer('${escHtml(srv.name)}')" title="${escHtml(srv.name)} (${transport})">
        <span class="mcp-chip-dot mcp-transport-dot-${transport}"></span>
        ${escHtml(srv.name)}
      </button>`;
    }).join('')
  }</div>`;
}

function toggleMcpServer(name) {
  if (!currentDraft) return;
  if (!currentDraft.enabledMcpServers) currentDraft.enabledMcpServers = [];
  const idx = currentDraft.enabledMcpServers.indexOf(name);
  if (idx === -1) currentDraft.enabledMcpServers.push(name);
  else            currentDraft.enabledMcpServers.splice(idx, 1);
  renderMcpSection(currentDraft.enabledMcpServers);
}

// ───────────────────────────────────────────────
//  FINALIZE / UPDATE
// ───────────────────────────────────────────────

async function finalizeAgent() {
  syncFieldsToCurrentDraft();

  if (!currentDraft?.name || !currentDraft?.slug || !currentDraft?.systemPrompt) {
    showToast('Name, slug, and system prompt are required', 'error');
    return;
  }

  currentDraft.slug = slugify(currentDraft.slug) || slugify(currentDraft.name);
  if (!currentDraft.slug) { showToast('Could not generate a valid slug', 'error'); return; }

  const btn = document.getElementById('finalize-btn');
  btn.disabled = true;

  // Step 1 — run skill builder for any generateSkills entries
  const skillsToGenerate = (currentDraft.generateSkills || []).filter(s => s.skillName && s.skillDescription);
  let builtSkills = [];
  if (skillsToGenerate.length > 0) {
    btn.textContent = '⚙️ Building skills...';
    builtSkills = await _runSkillBuilder(skillsToGenerate);
  }

  // Step 2 — save the agent
  btn.textContent = '⏳ Saving...';
  try {
    let url, method;
    if (isEditMode && editingAgentSlug) {
      await fetch(`/api/creator/backup/${editingAgentSlug}`, { method: 'POST' });
      url = `/api/creator/update/${editingAgentSlug}`;
      method = 'POST';
    } else {
      url = '/api/creator/finalize';
      method = 'POST';
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: creatorSessionId, draft: currentDraft, builtSkills }),
    });

    const data = await res.json();

    if (data.ok) {
      showToast(isEditMode ? `"${data.manifest.name}" updated!` : `"${data.manifest.name}" created!`, 'success');
      refreshSidebarAgents();
      if (isEditMode) await _refreshRestoreButton(editingAgentSlug);
      showSuccessState(data.manifest, data.skillsGenerated || [], data.skillErrors || []);
    } else {
      btn.disabled = false;
      btn.textContent = isEditMode ? '✓ Save Changes' : '✓ Finalize & Create Agent';
      showToast(`Failed: ${data.error}`, 'error');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = isEditMode ? '✓ Save Changes' : '✓ Finalize & Create Agent';
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function _runSkillBuilder(skills) {
  // Show skill builder message in the creator chat
  const wrapper = appendMessage('creator-messages', 'assistant', '', '⚙️');
  const bubble  = wrapper.querySelector('.message-bubble');

  const lines = ['**Skill Builder**\n'];
  const renderLines = () => { bubble.innerHTML = renderMarkdown(lines.join('\n')); scrollChatToBottom(); };

  renderLines();

  try {
    const res = await fetch('/api/creator/build-skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      lines.push(`✗ Skill Builder error: ${err.error || res.status}`);
      renderLines();
      return [];
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let built  = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) {
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.type === 'skill_start') {
            lines.push(`⏳ Building \`${evt.skillName}\`…`);
            renderLines();
          } else if (evt.type === 'skill_retry') {
            const idx = lines.findLastIndex(l => l.includes(`\`${evt.skillName}\``));
            const msg = `🔄 Retrying \`${evt.skillName}\` (attempt ${evt.attempt}/3)…`;
            if (idx !== -1) lines[idx] = msg;
            else lines.push(msg);
            renderLines();
          } else if (evt.type === 'skill_done') {
            const idx = lines.findLastIndex(l => l.includes(`\`${evt.skillName}\``));
            if (idx !== -1) lines[idx] = `✓ \`${evt.skillName}\` created`;
            built.push(evt.skillName);
            renderLines();
          } else if (evt.type === 'skill_error') {
            const idx = lines.findLastIndex(l => l.includes(`\`${evt.skillName}\``));
            if (idx !== -1) lines[idx] = `✗ \`${evt.skillName}\` failed — ${evt.error}`;
            renderLines();
          } else if (evt.type === 'all_done') {
            lines.push(`\n${built.length} of ${skills.length} skill${skills.length !== 1 ? 's' : ''} built successfully.`);
            renderLines();
            return built;
          }
        } catch { /* skip malformed */ }
      }
    }
    return built;
  } catch (err) {
    lines.push(`✗ Skill Builder connection error: ${err.message}`);
    renderLines();
    return [];
  }
}

async function restoreAgent() {
  if (!isEditMode || !editingAgentSlug) return;
  if (!confirm('Restore this agent to its last backup? Current changes will be overwritten.')) return;

  const btn = document.getElementById('restore-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Restoring...';

  try {
    const res = await fetch(`/api/creator/restore/${editingAgentSlug}`, { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      showToast('Restored from backup', 'success');
      // Reload agent into preview
      await _loadAgentIntoPreview(editingAgentSlug);
    } else {
      showToast(`Restore failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.textContent = '↩ Restore Backup';
    await _refreshRestoreButton(editingAgentSlug);
  }
}

// ───────────────────────────────────────────────
//  DOM HELPERS
// ───────────────────────────────────────────────

function appendCreatorUserMsg(text) { appendMessage('creator-messages', 'user', text); }
function appendCreatorAssistantMsg(text) { return appendMessage('creator-messages', 'assistant', text); }
function appendCreatorSystemMsg(text) { appendMessage('creator-messages', 'system', text); }
function appendCreatorTyping() { return appendTypingIndicator('creator-messages'); }
function updateCreatorBubble(wrapperEl, text) {
  const bubble = wrapperEl.querySelector('.message-bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(text);
  scrollChatToBottom();
}
function scrollChatToBottom() { scrollToBottom('creator-messages'); }

// ── Shared helpers (used by operator.js too) ──
function appendMessage(containerId, role, text, avatarText) {
  const container = document.getElementById(containerId);
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role === 'user' ? 'user' : role === 'system' ? 'system-msg' : 'assistant'}`;

  if (role !== 'system') {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? 'You' : (avatarText || 'AI');
    wrapper.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = (role === 'assistant') ? renderMarkdown(text) : escHtml(text);
  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  scrollToBottom(containerId);
  return wrapper;
}

function appendTypingIndicator(containerId) {
  const container = document.getElementById(containerId);
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant';
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'AI';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  scrollToBottom(containerId);
  return wrapper;
}

function scrollToBottom(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.scrollTop = el.scrollHeight;
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    return marked.parse(text || '', { breaks: true, gfm: true });
  }
  return escHtml(text || '').replace(/\n/g, '<br>');
}

function slugify(str) {
  return (str || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// For onclick attributes — wraps in single quotes and escapes single quotes inside the value
function escAttr(val) {
  return `'${String(val || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'`;
}

function escAttrRaw(val) {
  return String(val || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

// ── Expose globals ──
window.appendMessage = appendMessage;
window.appendTypingIndicator = appendTypingIndicator;
window.scrollToBottom = scrollToBottom;
window.renderMarkdown = renderMarkdown;
window.startNewAgent = startNewAgent;
window.startEditAgent = startEditAgent;
window.cancelCreation = cancelCreation;
window.loadCreatorAgentHistory = loadCreatorAgentHistory;
window.openCreatedInOperator = openCreatedInOperator;
window.onNameInput = onNameInput;
window.onSlugInput = onSlugInput;
window.onPreviewFieldChange = onPreviewFieldChange;
window.toggleSkill = toggleSkill;
window.addGenSkill = addGenSkill;
window.removeGenSkill = removeGenSkill;
window.updateGenSkillName = updateGenSkillName;
window.updateGenSkillDesc = updateGenSkillDesc;
window.toggleMcpServer = toggleMcpServer;
window.loadGlobalMcpServers = loadGlobalMcpServers;
window.renderMcpSection = renderMcpSection;
Object.defineProperty(window, 'currentDraft', { get: () => currentDraft, configurable: true });
window.finalizeAgent = finalizeAgent;
window.restoreAgent = restoreAgent;
window.handleCreatorKey = handleCreatorKey;
window.sendCreatorMessage = sendCreatorMessage;
window.confirmDeleteAgent = confirmDeleteAgent;
window.launchCreatedAgent = launchCreatedAgent;
