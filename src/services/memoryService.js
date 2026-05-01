'use strict';
const path = require('path');
const fs   = require('fs');
const { readFile, writeFile, appendFile, listDir, ensureDir } = require('../utils/fileUtils');
const { agentDir } = require('./agentService');

const MEMORY_FILE = 'memory.json';

function _memPath(slug) {
  return path.join(agentDir(slug), MEMORY_FILE);
}

function _empty() {
  return { version: 1, entries: [] };
}

/**
 * Load structured memory for an agent.
 * Returns { version, entries: [{id, content, category, created_at, updated_at}] }
 */
function loadMemory(slug) {
  try {
    return JSON.parse(fs.readFileSync(_memPath(slug), 'utf8'));
  } catch {
    return _empty();
  }
}

/**
 * Overwrite the memory file entirely.
 */
function saveMemory(slug, memory) {
  fs.writeFileSync(_memPath(slug), JSON.stringify(memory, null, 2), 'utf8');
}

/**
 * Erase all entries.
 */
function resetMemory(slug) {
  saveMemory(slug, _empty());
}

/**
 * Apply LLM-generated memory operations and persist.
 * ops: [{op:'add', content, category}, {op:'update', id, content}]
 * Returns the updated memory object.
 */
function applyMemoryOps(slug, ops) {
  const memory = loadMemory(slug);
  const now = new Date().toISOString();

  for (const op of ops) {
    if (op.op === 'add' && op.content?.trim()) {
      memory.entries.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        content: op.content.trim(),
        category: _validCategory(op.category),
        created_at: now,
        updated_at: now,
      });
    } else if (op.op === 'update' && op.id && op.content?.trim()) {
      const entry = memory.entries.find(e => e.id === op.id);
      if (entry) {
        entry.content    = op.content.trim();
        entry.updated_at = now;
      }
    }
  }

  saveMemory(slug, memory);
  return memory;
}

const VALID_CATEGORIES = new Set(['user_profile', 'preferences', 'goals', 'context']);
function _validCategory(cat) {
  return VALID_CATEGORIES.has(cat) ? cat : 'context';
}

/**
 * Add a single entry manually.
 */
function addMemoryEntry(slug, { content, category }) {
  return applyMemoryOps(slug, [{ op: 'add', content, category }]);
}

/**
 * Update the content of one entry by id.
 */
function updateMemoryEntry(slug, id, content) {
  return applyMemoryOps(slug, [{ op: 'update', id, content }]);
}

/**
 * Remove one entry by id.
 */
function deleteMemoryEntry(slug, id) {
  const memory = loadMemory(slug);
  memory.entries = memory.entries.filter(e => e.id !== id);
  saveMemory(slug, memory);
  return memory;
}

// ── Session transcript helpers ──────────────────────────────────────────────

async function createSession(slug) {
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionsDir = path.join(agentDir(slug), 'sessions');
  await ensureDir(sessionsDir);
  await writeFile(path.join(sessionsDir, `${sessionId}.md`), `# Session: ${sessionId}\n\n`);
  return sessionId;
}

async function appendToSession(slug, sessionId, role, content) {
  const p = path.join(agentDir(slug), 'sessions', `${sessionId}.md`);
  const label = role === 'user' ? '**User:**' : '**Agent:**';
  await appendFile(p, `${label}\n${content}\n\n---\n\n`);
}

async function getSessionTranscript(slug, sessionId) {
  return readFile(path.join(agentDir(slug), 'sessions', `${sessionId}.md`));
}

async function listSessions(slug) {
  const sessionsDir = path.join(agentDir(slug), 'sessions');
  const files = await listDir(sessionsDir);
  return files
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''))
    .sort()
    .reverse();
}

module.exports = {
  loadMemory,
  saveMemory,
  resetMemory,
  applyMemoryOps,
  addMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  createSession,
  appendToSession,
  getSessionTranscript,
  listSessions,
};
