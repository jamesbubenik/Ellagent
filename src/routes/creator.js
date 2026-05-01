'use strict';
const router = require('express').Router();

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const { stream, complete } = require('../services/llmService');
const { getAvailableSkills, saveGeneratedSkill, validateSkillCode } = require('../services/skillService');
const { createAgent, updateAgent, backupAgent, restoreAgent, hasBackup, agentExists, getAgent } = require('../services/agentService');
const { buildCreatorPrompt, buildSkillGenerationPrompt, buildSkillCorrectionPrompt, buildSkillBuilderSystemPrompt } = require('../utils/promptBuilder');
const { skillBuildLog, appLog } = require('../utils/logger');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true });

// sessions: sessionId -> { history, draft, editingSlug | null }
const sessions = new Map();

const AGENT_SCHEMA = {
  type: 'object',
  required: ['name', 'slug', 'systemPrompt'],
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
    description: { type: 'string' },
    systemPrompt: { type: 'string', minLength: 1 },
    soul: { type: 'string' },
    requiredSkills: { type: 'array', items: { type: 'string' } },
    generateSkills: {
      type: 'array',
      items: {
        type: 'object',
        required: ['skillName', 'skillDescription'],
        properties: {
          skillName: { type: 'string', pattern: '^[a-z0-9-]+$' },
          skillDescription: { type: 'string' },
        },
      },
    },
    initialMemory: { type: 'string' },
  },
};

const validate = ajv.compile(AGENT_SCHEMA);

function extractJSON(text) {
  // 1. Try explicit ```json fence
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  // 2. Try first {...} block in the text
  const bare = /(\{[\s\S]*\})/.exec(text);
  if (bare) {
    try { return JSON.parse(bare[1].trim()); } catch { /* fall through */ }
  }
  return null;
}

/**
 * Normalise an LLM draft to prevent trivially-fixable AJV failures:
 * - Slugify the slug field
 * - Convert null/missing arrays to []
 * - Trim all string fields
 */
function sanitizeDraft(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  const out = { ...draft };
  if (out.slug) {
    out.slug = String(out.slug).toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
  }
  if (!Array.isArray(out.requiredSkills)) out.requiredSkills = [];
  if (!Array.isArray(out.generateSkills))  out.generateSkills = [];
  ['name', 'description', 'systemPrompt', 'soul', 'initialMemory'].forEach(k => {
    if (out[k] != null) out[k] = String(out[k]).trim();
    else if (out[k] === null) out[k] = '';
  });
  return out;
}

function stripCodeFences(text) {
  // Extract code from any JS fence in the response (LLMs often add prose before/after the block)
  const fenced = /```(?:js|javascript|typescript|ts)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

function sseWrite(res, event, data) {
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

/**
 * Build the system prompt for an edit session, including the current agent state.
 */
function buildEditPrompt(currentAgent, availableSkills) {
  const base = buildCreatorPrompt(availableSkills);
  return `${base}

## EDIT MODE — You are modifying an EXISTING agent

Current agent state:
\`\`\`json
${JSON.stringify({
  name: currentAgent.name,
  slug: currentAgent.slug,
  description: currentAgent.description,
  systemPrompt: currentAgent.systemPrompt,
  soul: currentAgent.soul,
  requiredSkills: currentAgent.requiredSkills,
  generatedSkills: currentAgent.generatedSkills,
}, null, 2)}
\`\`\`

The user will describe what they want to change. Produce an updated JSON spec in a \`\`\`json block that represents the FULL updated agent (not just the changes). Keep the same slug unless the user explicitly asks to change it.`;
}

// POST /api/creator/message
router.post('/message', async (req, res) => {
  const { sessionId, message, editingSlug } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const id = sessionId || genId();
  if (!sessions.has(id)) {
    sessions.set(id, { history: [], draft: null, editingSlug: editingSlug || null });
  }
  const session = sessions.get(id);

  // If this is a new edit session and editingSlug differs from stored, reset history
  if (editingSlug && session.editingSlug !== editingSlug) {
    session.history = [];
    session.draft = null;
    session.editingSlug = editingSlug;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseWrite(res, 'session', { sessionId: id });
  session.history.push({ role: 'user', content: message });

  // Build appropriate system prompt
  let systemPrompt;
  if (session.editingSlug) {
    try {
      const currentAgent = await getAgent(session.editingSlug);
      systemPrompt = buildEditPrompt(currentAgent, getAvailableSkills());
    } catch {
      systemPrompt = buildCreatorPrompt(getAvailableSkills());
    }
  } else {
    systemPrompt = buildCreatorPrompt(getAvailableSkills());
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history,
  ];

  try {
    let fullResponse = '';
    await stream(messages, { temperature: 0.7 }, chunk => {
      fullResponse += chunk;
      sseWrite(res, 'chunk', { content: chunk });
    });

    session.history.push({ role: 'assistant', content: fullResponse });

    const rawDraft = extractJSON(fullResponse);
    if (rawDraft) {
      const draft = sanitizeDraft(rawDraft);
      const valid = validate(draft);
      if (valid) {
        session.draft = draft;
        sseWrite(res, 'draft', { draft });
      } else {
        const errorMessages = (validate.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message}`);
        appLog.warn('draft_validation_failed', { errors: errorMessages });
        sseWrite(res, 'draft_error', { errors: errorMessages, rawDraft: draft });
      }
    }

    sseWrite(res, 'done', {});
  } catch (err) {
    sseWrite(res, 'error', { error: err.message });
  }

  res.end();
});

const MAX_SKILL_ATTEMPTS = 3;

/**
 * Generate a skill with automatic retry on validation or load failure.
 * Feeds the exact error back to the LLM so it can self-correct.
 *
 * @param {string} skillName
 * @param {string} skillDescription
 * @param {{ sseRes?: object, onRetry?: (attempt, error) => void }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
async function _buildSkillWithRetry(skillName, skillDescription, { sseRes = null, onRetry = null } = {}) {
  const systemPrompt = buildSkillBuilderSystemPrompt();
  let previousCode   = null;
  let previousError  = null;

  for (let attempt = 1; attempt <= MAX_SKILL_ATTEMPTS; attempt++) {
    if (attempt > 1 && onRetry) onRetry(attempt, previousError);

    try {
      const allSkills  = getAvailableSkills();
      const userPrompt = buildSkillGenerationPrompt(skillName, skillDescription, allSkills);

      // Build the message history: on retry, include the bad code + error as context
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ];
      if (attempt > 1 && previousCode) {
        messages.push({ role: 'assistant', content: previousCode });
        messages.push({ role: 'user',      content: buildSkillCorrectionPrompt(previousError, previousCode) });
      }

      skillBuildLog.promptBuilt(skillName, systemPrompt.length, userPrompt.length);

      let rawCode = '';
      if (attempt === 1 && sseRes) {
        // First attempt: stream so the SSE consumer can show progress
        await stream(messages, { temperature: 0.2, maxTokens: 8192 }, chunk => { rawCode += chunk; });
      } else {
        // Retry: complete() is simpler; no need to stream a correction pass
        rawCode = await complete(messages, { temperature: 0.2, maxTokens: 8192 });
      }

      const code = stripCodeFences(rawCode);
      skillBuildLog.llmResponse(skillName, rawCode, code);

      // Static validation (syntax, forbidden patterns, structure)
      const validation = validateSkillCode(code);
      if (!validation.valid) {
        skillBuildLog.validationFail(skillName, `[attempt ${attempt}] static: ${validation.error}`);
        previousCode  = code;
        previousError = validation.error;
        continue;
      }

      // Write to disk + require() load check
      const saveResult = await saveGeneratedSkill(skillName, code);
      if (!saveResult.ok) {
        skillBuildLog.validationFail(skillName, `[attempt ${attempt}] load: ${saveResult.error}`);
        previousCode  = code;
        previousError = saveResult.error;
        continue;
      }

      skillBuildLog.buildSuccess(skillName);
      return { ok: true };

    } catch (err) {
      skillBuildLog.buildFail(skillName, err);
      previousCode  = previousCode || '';
      previousError = err.message;
    }
  }

  return { ok: false, error: `Failed after ${MAX_SKILL_ATTEMPTS} attempts. Last error: ${previousError}` };
}

// POST /api/creator/build-skills — Skill Builder master agent (streaming)
router.post('/build-skills', async (req, res) => {
  const { skills } = req.body;
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: 'skills array required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const built  = [];
  const errors = [];

  for (const { skillName, skillDescription } of skills) {
    sseWrite(res, 'skill_start', { skillName });
    skillBuildLog.buildStart(skillName, skillDescription);

    const result = await _buildSkillWithRetry(skillName, skillDescription, {
      sseRes:  res,
      onRetry: (attempt, error) => {
        sseWrite(res, 'skill_retry', { skillName, attempt, error });
      },
    });

    if (result.ok) {
      built.push(skillName);
      sseWrite(res, 'skill_done', { skillName });
    } else {
      errors.push({ skillName, error: result.error });
      sseWrite(res, 'skill_error', { skillName, error: result.error });
    }
  }

  sseWrite(res, 'all_done', { built, errors });
  res.end();
});

// POST /api/creator/finalize — create a new agent
// POST /api/creator/update/:slug — update an existing agent
async function handleFinalize(req, res, isUpdate = false) {
  const slug = isUpdate ? req.params.slug : null;
  const { sessionId, draft: draftOverride, builtSkills = [] } = req.body;

  let draft = draftOverride || null;
  if (!draft && sessionId && sessions.has(sessionId)) {
    draft = sessions.get(sessionId).draft || null;
  }

  if (!draft) {
    return res.status(400).json({ error: 'No agent draft provided.' });
  }
  if (!draft.name || !draft.slug || !draft.systemPrompt) {
    return res.status(400).json({ error: 'Draft must include name, slug, and systemPrompt.' });
  }

  // Skills were already generated by the build-skills endpoint; just record results.
  const alreadyBuilt = new Set(builtSkills);
  const results = { skillsGenerated: [...builtSkills], skillErrors: [] };

  // Fallback: generate any skills not already built (e.g. direct API calls without build-skills)
  const remaining = (draft.generateSkills || []).filter(s => !alreadyBuilt.has(s.skillName));
  if (remaining.length > 0) {
    for (const { skillName, skillDescription } of remaining) {
      skillBuildLog.buildStart(skillName, skillDescription);
      const result = await _buildSkillWithRetry(skillName, skillDescription);
      if (result.ok) {
        results.skillsGenerated.push(skillName);
      } else {
        results.skillErrors.push({ skillName, error: result.error });
      }
    }
  }

  const successfulNames = new Set(results.skillsGenerated);
  const patchedDraft = {
    ...draft,
    generateSkills: (draft.generateSkills || []).filter(s => successfulNames.has(s.skillName)),
  };

  try {
    let manifest;
    if (isUpdate) {
      manifest = await updateAgent(slug, patchedDraft);
    } else {
      manifest = await createAgent(patchedDraft);
    }
    if (sessionId) sessions.delete(sessionId);
    res.json({ ok: true, manifest, ...results });
  } catch (err) {
    appLog.error('finalize_failed', { error: err.message, stack: err.stack });
    res.status(500).json({ ok: false, error: err.message, ...results });
  }
}

router.post('/finalize', (req, res) => handleFinalize(req, res, false));
router.post('/update/:slug', (req, res) => handleFinalize(req, res, true));

// POST /api/creator/backup/:slug — snapshot current agent files
router.post('/backup/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    if (!(await agentExists(slug))) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const files = await backupAgent(slug);
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/creator/restore/:slug — restore from backup
router.post('/restore/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const restored = await restoreAgent(slug);
    if (restored === null) {
      return res.status(404).json({ error: 'No backup found for this agent' });
    }
    res.json({ ok: true, restored });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/creator/backup-status/:slug
router.get('/backup-status/:slug', async (req, res) => {
  try {
    const exists = await hasBackup(req.params.slug);
    res.json({ hasBackup: exists });
  } catch {
    res.json({ hasBackup: false });
  }
});

// GET /api/creator/skills
router.get('/skills', (req, res) => {
  res.json({ skills: getAvailableSkills() });
});

// DELETE /api/creator/session/:id
router.delete('/session/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
