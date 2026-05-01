'use strict';
const path = require('path');
const fs = require('fs/promises');
const { readJSON, writeJSON, writeFile, readFile, fileExists, listDir, removeDir, ensureDir, copyFile } = require('../utils/fileUtils');

// Resolve relative to this module's location — never depends on env var timing
const _DEFAULT_AGENTS = path.resolve(__dirname, '..', '..', 'agents');
const AGENTS_DIR = () => process.env.AGENTS_DIR ? path.resolve(process.env.AGENTS_DIR) : _DEFAULT_AGENTS;

function agentDir(slug) {
  return path.join(AGENTS_DIR(), slug);
}

async function listAgents() {
  const dir = AGENTS_DIR();
  const entries = await listDir(dir);
  const agents = [];
  for (const entry of entries) {
    const manifestPath = path.join(dir, entry, 'manifest.json');
    if (await fileExists(manifestPath)) {
      try {
        const manifest = await readJSON(manifestPath);
        agents.push(manifest);
      } catch { /* skip corrupt */ }
    }
  }
  return agents.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

async function getAgent(slug) {
  const dir = agentDir(slug);
  const manifest = await readJSON(path.join(dir, 'manifest.json'));
  manifest.systemPrompt = await readFile(path.join(dir, 'system-prompt.md')).catch(() => '');
  manifest.soul = await readFile(path.join(dir, 'soul.md')).catch(() => '');
  try {
    const raw = await readFile(path.join(dir, 'memory.json'));
    manifest.memoryEntries = JSON.parse(raw).entries || [];
  } catch {
    manifest.memoryEntries = [];
  }
  return manifest;
}

async function createAgent(agentDef) {
  const slug = agentDef.slug;
  const dir = agentDir(slug);
  await ensureDir(dir);
  await ensureDir(path.join(dir, 'sessions'));

  const manifest = {
    name: agentDef.name,
    slug,
    description: agentDef.description || '',
    requiredSkills: agentDef.requiredSkills || [],
    generatedSkills: (agentDef.generateSkills || []).map(s => s.skillName),
    enabledMcpServers: agentDef.enabledMcpServers || [],
    memoryEnabled: !!agentDef.memoryEnabled,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await writeJSON(path.join(dir, 'manifest.json'), manifest);
  await writeFile(path.join(dir, 'system-prompt.md'), agentDef.systemPrompt || '');
  await writeFile(path.join(dir, 'soul.md'), agentDef.soul || '');

  const initialMemory = agentDef.initialMemory?.trim()
    ? `# Long-Term Memory\n\n${agentDef.initialMemory.trim()}\n`
    : '# Long-Term Memory\n\n';
  await writeFile(path.join(dir, 'memory-long-term.md'), initialMemory);

  return manifest;
}

/**
 * Overwrite an existing agent's files. Called when editing an existing agent.
 * Does NOT create a backup — callers should call backupAgent first.
 */
async function updateAgent(slug, agentDef) {
  const dir = agentDir(slug);

  // Read existing manifest to preserve fields not in agentDef
  let existing = {};
  try { existing = await readJSON(path.join(dir, 'manifest.json')); } catch {}

  const manifest = {
    ...existing,
    name: agentDef.name || existing.name,
    slug,
    description: agentDef.description !== undefined ? agentDef.description : existing.description,
    requiredSkills: agentDef.requiredSkills || existing.requiredSkills || [],
    generatedSkills: agentDef.generateSkills
      ? (agentDef.generateSkills || []).map(s => s.skillName)
      : existing.generatedSkills || [],
    enabledMcpServers: agentDef.enabledMcpServers !== undefined ? (agentDef.enabledMcpServers || []) : (existing.enabledMcpServers || []),
    memoryEnabled: agentDef.memoryEnabled !== undefined ? !!agentDef.memoryEnabled : !!existing.memoryEnabled,
    updatedAt: new Date().toISOString(),
  };

  await writeJSON(path.join(dir, 'manifest.json'), manifest);
  if (agentDef.systemPrompt !== undefined) {
    await writeFile(path.join(dir, 'system-prompt.md'), agentDef.systemPrompt);
  }
  if (agentDef.soul !== undefined) {
    await writeFile(path.join(dir, 'soul.md'), agentDef.soul);
  }

  return manifest;
}

/**
 * Create a backup of all agent core files (manifest, system-prompt, soul).
 */
async function backupAgent(slug) {
  const dir = agentDir(slug);
  const files = ['manifest.json', 'system-prompt.md', 'soul.md'];
  const backed = [];
  for (const file of files) {
    const src = path.join(dir, file);
    const dest = path.join(dir, `${file}.bak`);
    if (await fileExists(src)) {
      await copyFile(src, dest);
      backed.push(file);
    }
  }
  // Write backup metadata
  await writeJSON(path.join(dir, 'backup-meta.json'), {
    createdAt: new Date().toISOString(),
    files: backed,
  });
  return backed;
}

/**
 * Restore from the most recent backup.
 * Returns the list of restored files, or null if no backup exists.
 */
async function restoreAgent(slug) {
  const dir = agentDir(slug);
  const metaPath = path.join(dir, 'backup-meta.json');
  if (!(await fileExists(metaPath))) return null;

  const meta = await readJSON(metaPath);
  const restored = [];
  for (const file of meta.files || []) {
    const bak = path.join(dir, `${file}.bak`);
    const dest = path.join(dir, file);
    if (await fileExists(bak)) {
      await copyFile(bak, dest);
      restored.push(file);
    }
  }
  return restored;
}

async function hasBackup(slug) {
  return fileExists(path.join(agentDir(slug), 'backup-meta.json'));
}

async function deleteAgent(slug) {
  await removeDir(agentDir(slug));
}

async function agentExists(slug) {
  return fileExists(path.join(agentDir(slug), 'manifest.json'));
}

module.exports = {
  listAgents, getAgent, createAgent, updateAgent,
  backupAgent, restoreAgent, hasBackup,
  deleteAgent, agentExists, agentDir, AGENTS_DIR,
};
