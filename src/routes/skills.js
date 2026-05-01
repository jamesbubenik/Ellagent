'use strict';
const fs     = require('fs');
const path   = require('path');
const router = require('express').Router();
const { getAvailableSkills, loadSkills, getSkill, getSkillSource, saveGeneratedSkill, deleteSkill, setSkillApproval } = require('../services/skillService');
const { complete } = require('../services/llmService');
const { appLog } = require('../utils/logger');

const _LOGS_DIR  = path.resolve(__dirname, '..', '..', 'logs');
const _LOG_FILES = ['app.log', 'app.1.log', 'app.2.log', 'app.3.log', 'app.4.log', 'app.5.log'];

const _SKILL_CHAT_SYSTEM = `You are an expert Node.js developer helping to write and refine skill modules for an AI agent platform.

Skills are CommonJS modules (module.exports = { name, description, requiresApproval, parameters, execute }).

HARD CONSTRAINTS:
- Only built-in Node.js modules allowed (http, https, fs, path, crypto, etc.)
- Forbidden: axios, node-fetch, got, request, or any external npm package
- Forbidden: eval(), new Function(), dynamic require()
- Skills making network calls or writing files MUST have requiresApproval: true
- execute(params) must return { success: boolean, result?: any, error?: string }
- Never JSON.parse() an LLM response — LM Studio returns plain text, not JSON

When making a code change:
1. Return the COMPLETE updated skill code in a single \`\`\`javascript block
2. After the block, briefly explain what changed (1-3 sentences max)

When answering a question without a code change, respond concisely — no code block needed.`;

// GET /api/skills/:name/logs — last N skill-usage log entries for a skill
router.get('/:name/logs', (req, res) => {
  const { name } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const entries = [];
  for (const filename of _LOG_FILES) {
    const filepath = path.join(_LOGS_DIR, filename);
    let raw;
    try { raw = fs.readFileSync(filepath, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.logger === 'skill-usage' && entry.skillName === name) {
          entries.push(entry);
        }
      } catch {}
    }
  }

  // Sort ascending by timestamp then return the last `limit` entries newest-first
  entries.sort((a, b) => (a.ts > b.ts ? 1 : a.ts < b.ts ? -1 : 0));
  res.json({ logs: entries.slice(-limit).reverse() });
});

// GET /api/skills — list all registered skills
router.get('/', (req, res) => {
  res.json({ skills: getAvailableSkills() });
});

// GET /api/skills/:name — full detail including source code
router.get('/:name', async (req, res) => {
  const { name } = req.params;
  const skill = getSkill(name);
  if (!skill) return res.status(404).json({ error: `Skill "${name}" not found` });
  try {
    const { source, type } = await getSkillSource(name);
    res.json({
      skill: {
        name: skill.name,
        description: skill.description || '',
        parameters: skill.parameters || null,
        requiresApproval: !!skill.requiresApproval,
        type,
        source,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills — create a new generated skill
router.post('/', async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ ok: false, error: 'name and code are required' });
  if (getSkill(name)) return res.status(409).json({ ok: false, error: `A skill named "${name}" already exists` });

  const result = await saveGeneratedSkill(name, code);
  if (!result.ok) return res.status(400).json(result);

  appLog.info('skill_created', { skillName: name });
  res.json({ ok: true, skill: { name: result.skill.name, description: result.skill.description, type: 'generated' } });
});

// PUT /api/skills/:name — update an existing generated skill's code
router.put('/:name', async (req, res) => {
  const { name } = req.params;
  const { code } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: 'code is required' });

  const existing = getSkill(name);
  if (!existing) return res.status(404).json({ ok: false, error: `Skill "${name}" not found` });
  if (existing._type === 'pre-built') return res.status(403).json({ ok: false, error: 'Pre-built skills cannot be modified' });

  const result = await saveGeneratedSkill(name, code);
  if (!result.ok) return res.status(400).json(result);

  appLog.info('skill_updated', { skillName: name });
  res.json({ ok: true, skill: { name: result.skill.name, description: result.skill.description, type: 'generated' } });
});

// PATCH /api/skills/:name/approval — toggle requiresApproval for any skill
router.patch('/:name/approval', async (req, res) => {
  const { name } = req.params;
  const { requiresApproval } = req.body;
  if (typeof requiresApproval !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'requiresApproval must be a boolean' });
  }
  try {
    await setSkillApproval(name, requiresApproval);
    appLog.info('skill_approval_set', { skillName: name, requiresApproval });
    res.json({ ok: true, requiresApproval });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /api/skills/:name — delete a generated skill
router.delete('/:name', async (req, res) => {
  const { name } = req.params;
  try {
    await deleteSkill(name);
    appLog.info('skill_deleted', { skillName: name });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/skills/chat — LLM assistant for editing a skill
router.post('/chat', async (req, res) => {
  const { code = '', message, history = [] } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });

  const userContent = code
    ? `Current skill code:\n\`\`\`javascript\n${code}\n\`\`\`\n\n${message}`
    : message;

  // Keep last 6 history items (3 user/assistant pairs) to avoid token bloat
  const trimmedHistory = history.slice(-6);

  const messages = [
    { role: 'system', content: _SKILL_CHAT_SYSTEM },
    ...trimmedHistory,
    { role: 'user', content: userContent },
  ];

  try {
    const response = await complete(messages, { temperature: 0.3, maxTokens: 4096 });
    res.json({ ok: true, response });
  } catch (err) {
    appLog.error('skill_chat_failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/skills/reload — rescan skill directories
router.post('/reload', async (req, res) => {
  try {
    const skills = await loadSkills();
    res.json({ ok: true, count: skills.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
