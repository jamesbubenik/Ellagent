'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs/promises');
const pdfParse = require('pdf-parse/lib/pdf-parse');
const mammoth  = require('mammoth');
const { stream, complete } = require('../services/llmService');
const { getConfig, getMcpServers } = require('../services/configService');
const { listAgents, getAgent, deleteAgent, agentExists, agentDir } = require('../services/agentService');
const { getAgentSkills } = require('../services/skillService');
const { createSession, appendToSession, getSessionTranscript, listSessions,
        loadMemory, resetMemory, applyMemoryOps,
        addMemoryEntry, updateMemoryEntry, deleteMemoryEntry } = require('../services/memoryService');
const { buildOperatorPrompt } = require('../utils/promptBuilder');
const { parseToolCall, executeToolCall, formatToolResult } = require('../services/toolService');
const { writeFile, fileExists } = require('../utils/fileUtils');
const { skillUsageLog, appLog } = require('../utils/logger');
const { connectAgentMcp, disconnectAgentMcp } = require('../services/mcpService');

// In-memory sessions:
// sessionId -> { agentSlug, agentName, history, sessionFileId, pendingTool,
//                agentSkillNames, systemPrompt, approvedSkills, autoApprove }
const operatorSessions = new Map();

function sseWrite(res, event, data) {
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

// GET /api/operator/agents
router.get('/agents', async (req, res) => {
  try {
    const agents = await listAgents();
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/operator/agents/:slug
router.get('/agents/:slug', async (req, res) => {
  try {
    const agent = await getAgent(req.params.slug);
    res.json({ agent });
  } catch (err) {
    res.status(404).json({ error: `Agent "${req.params.slug}" not found: ${err.message}` });
  }
});

// DELETE /api/operator/agents/:slug
router.delete('/agents/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const exists = await agentExists(slug);
    if (!exists) {
      return res.status(404).json({ error: `Agent "${slug}" not found` });
    }
    await deleteAgent(slug);
    appLog.info('agent_deleted', { slug });
    res.json({ ok: true });
  } catch (err) {
    appLog.error('agent_delete_failed', { slug, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator/agents/:slug/start-session
router.post('/agents/:slug/start-session', async (req, res) => {
  const { slug } = req.params;
  try {
    const agent = await getAgent(slug);
    const contextLength = getConfig().contextWindow || null;
    const sessionFileId = await createSession(slug);
    const sessionId = sessionFileId;
    const skills = getAgentSkills(agent);

    // Resolve which MCP servers to connect for this agent.
    // New format: agent.enabledMcpServers is a string[] of names referencing global config.
    // Legacy format: agent.mcpServers is an array of full server config objects stored per-agent.
    let agentMcpServers;
    if (Array.isArray(agent.enabledMcpServers) && agent.enabledMcpServers.length > 0) {
      const allMcpServers = getMcpServers();
      const enabledNames  = new Set(agent.enabledMcpServers);
      agentMcpServers = allMcpServers.filter(s => enabledNames.has(s.name));
    } else if (Array.isArray(agent.mcpServers) && agent.mcpServers.length > 0) {
      agentMcpServers = agent.mcpServers; // legacy per-agent config
    } else {
      agentMcpServers = [];
    }
    const { clients: mcpClients, tools: mcpTools, errors: mcpErrors } = await connectAgentMcp(agentMcpServers);

    const systemPrompt = buildOperatorPrompt(agent, agent.memoryEntries, skills, mcpTools);

    operatorSessions.set(sessionId, {
      agentSlug: slug,
      agentName: agent.name,
      agentManifest: agent,
      history: [],
      sessionFileId,
      pendingTool: null,
      agentSkillNames: skills.map(s => s.name),
      systemPrompt,
      approvedSkills: new Set(),
      autoApprove: false,
      memoryEnabled: !!agent.memoryEnabled,
      disabledSkills: new Set(),
      contextLength,
      promptTokens: 0,
      completionTokens: 0,
      mcpClients,  // Map<serverName, McpClient>
      mcpTools,    // Map<toolName, { client, serverName, def, requiresApproval }>
    });

    const skillList = skills.map(s => ({
      name: s.name,
      description: s.description || '',
      requiresApproval: !!s.requiresApproval,
    }));

    const mcpToolList = [...mcpTools.entries()].map(([name, { serverName, def, requiresApproval }]) => ({
      name,
      serverName,
      description: def.description || '',
      requiresApproval,
      source: 'mcp',
    }));

    appLog.info('session_started', { sessionId, agentSlug: slug, agentName: agent.name, skillCount: skills.length, mcpToolCount: mcpTools.size, mcpErrors: mcpErrors.length });
    res.json({ ok: true, sessionId, agentName: agent.name, memoryEnabled: !!agent.memoryEnabled, skills: skillList, mcpTools: mcpToolList, mcpErrors, contextLength });
  } catch (err) {
    appLog.error('session_start_failed', { agentSlug: slug, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator/agents/:slug/message
router.post('/agents/:slug/message', async (req, res) => {
  const { slug } = req.params;
  const { sessionId, message, attachments = [] } = req.body;

  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing sessionId. Start a session first.' });
  }
  if (!message && !attachments.length) return res.status(400).json({ error: 'message or attachments required' });

  const session = operatorSessions.get(sessionId);
  if (session.agentSlug !== slug) return res.status(400).json({ error: 'Session/agent mismatch' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userContent = _buildUserContent(message || '', attachments);
  const userText    = _contentToText(userContent);
  session.history.push({ role: 'user', content: userContent });
  await appendToSession(slug, session.sessionFileId, 'user', userText);

  await runAgentTurn(session, res, slug);
  res.end();
});

/**
 * Run one full agent turn, handling tool calls recursively (max depth 5).
 * Tool approval logic:
 *   - If session.autoApprove is true → always execute without asking
 *   - If skill was already approved this session (approvedSkills Set) → execute without asking
 *   - Otherwise → pause and ask user via approval_required SSE event
 */
async function runAgentTurn(session, res, slug, depth = 0) {
  const maxDepth = getConfig().maxToolCallDepth ?? 5;
  if (depth > maxDepth) {
    // Safety net — should rarely trigger since isLastTurn handles the graceful wrap-up
    sseWrite(res, 'error', { error: 'Maximum tool call depth reached' });
    return;
  }

  const isLastTurn = depth === maxDepth;

  appLog.debug('llm_turn_start', { sessionId: session.sessionFileId, agentSlug: session.agentSlug, depth, isLastTurn });

  const messages = [
    { role: 'system', content: session.systemPrompt },
    ...session.history,
  ];

  if (isLastTurn) {
    appLog.info('tool_depth_limit_reached', { sessionId: session.sessionFileId, agentSlug: session.agentSlug, maxDepth });
    // Inject a transient wrap-up instruction — not added to session.history so it won't
    // appear in the transcript or persist across turns.
    messages.push({
      role: 'user',
      content: '[SYSTEM: You have reached the maximum number of tool calls for this response. Do not call any more tools. Summarize what you have found and accomplished so far, and give your best final answer now.]',
    });
  }

  try {
    const { text: fullResponse, reasoningText, usage } = await stream(
      messages,
      { temperature: 0.7 },
      chunk => sseWrite(res, 'chunk', { content: chunk }),
      chunk => sseWrite(res, 'reasoning_chunk', { content: chunk }),
    );

    // Emit token usage only when LM Studio returns real data.
    // prompt_tokens is the authoritative measure of how much context is consumed —
    // it already includes system prompt + full conversation history for this request.
    // Avoid character-based estimates; they are inaccurate and misleading.
    if (usage) {
      const promptToks     = usage.prompt_tokens     ?? session.promptTokens ?? 0;
      const completionToks = usage.completion_tokens ?? 0;
      const reasoningToks  = usage.completion_tokens_details?.reasoning_tokens ?? 0;

      session.promptTokens     = promptToks;
      session.completionTokens = (session.completionTokens ?? 0) + completionToks;

      sseWrite(res, 'usage', {
        promptTokens:     promptToks,
        completionTokens: completionToks,
        reasoningTokens:  reasoningToks,
        totalTokens:      usage.total_tokens ?? (promptToks + completionToks),
        contextLength:    session.contextLength,
      });
    }

    const toolCall = parseToolCall(fullResponse);
    appLog.debug('llm_turn_complete', { sessionId: session.sessionFileId, agentSlug: session.agentSlug, depth, responseLen: fullResponse.length, hadToolCall: !!toolCall });

    if (toolCall && !isLastTurn) {
      const { getSkill } = require('../services/skillService');
      const skill = getSkill(toolCall.skillName);

      // ── MCP tool path ────────────────────────────────────────────────────────
      // Try exact match first, then case-insensitive — small LLMs often generate
      // lowercase variants of SCREAMING_SNAKE_CASE MCP tool names (e.g. "tool_call" vs "TOOL_CALL").
      let mcpEntry = !skill ? session.mcpTools?.get(toolCall.skillName) : null;
      if (!mcpEntry && !skill && session.mcpTools) {
        const lower = toolCall.skillName.toLowerCase();
        for (const [key, val] of session.mcpTools) {
          if (key.toLowerCase() === lower) { mcpEntry = val; break; }
        }
      }

      if (!skill && !mcpEntry) {
        const errMsg = `Tool "${toolCall.skillName}" is not available.`;
        session.history.push({ role: 'assistant', content: fullResponse });
        session.history.push({ role: 'user', content: `<tool_result skill="${toolCall.skillName}" success="false">Error: ${errMsg}</tool_result>` });
        sseWrite(res, 'tool_error', { skillName: toolCall.skillName, error: errMsg });
        await runAgentTurn(session, res, slug, depth + 1);
        return;
      }

      if (session.disabledSkills.has(toolCall.skillName)) {
        const errMsg = `Tool "${toolCall.skillName}" has been disabled for this session.`;
        skillUsageLog.blocked(session.sessionFileId, slug, toolCall.skillName, 'disabled_by_user');
        session.history.push({ role: 'assistant', content: fullResponse });
        session.history.push({ role: 'user', content: `<tool_result skill="${toolCall.skillName}" success="false">Error: ${errMsg}</tool_result>` });
        sseWrite(res, 'tool_error', { skillName: toolCall.skillName, error: errMsg });
        await runAgentTurn(session, res, slug, depth + 1);
        return;
      }

      if (mcpEntry) {
        // ── MCP execution ──────────────────────────────────────────────────
        const needsMcpApproval = mcpEntry.requiresApproval &&
          !session.autoApprove &&
          !session.approvedSkills.has(toolCall.skillName);

        if (needsMcpApproval) {
          session.pendingTool = { toolCall, fullResponse, depth, isMcp: true, mcpEntry };
          skillUsageLog.approvalRequired(session.sessionFileId, slug, toolCall.skillName);
          sseWrite(res, 'approval_required', {
            skillName:        toolCall.skillName,
            params:           toolCall.params,
            description:      mcpEntry.def.description || `MCP tool from ${mcpEntry.serverName}`,
            requiresApproval: true,
            source:           'mcp',
            serverName:       mcpEntry.serverName,
          });
          sseWrite(res, 'paused', {});
          return;
        }

        skillUsageLog.callStart(session.sessionFileId, slug, toolCall.skillName, toolCall.params);
        sseWrite(res, 'tool_executing', { skillName: toolCall.skillName, params: toolCall.params, source: 'mcp' });
        const t0mcp = Date.now();
        let mcpResult;
        try {
          mcpResult = await mcpEntry.client.callTool(toolCall.skillName, toolCall.params);
        } catch (err) {
          mcpResult = { success: false, error: err.message };
        }
        skillUsageLog.callResult(session.sessionFileId, slug, toolCall.skillName, !!mcpResult?.success, mcpResult, mcpResult?.error, Date.now() - t0mcp);
        sseWrite(res, 'tool_result', { skillName: toolCall.skillName, result: mcpResult });

        session.history.push({ role: 'assistant', content: fullResponse });
        session.history.push({ role: 'user', content: formatToolResult(toolCall.skillName, mcpResult) });
        await runAgentTurn(session, res, slug, depth + 1);
        return;
      }

      // ── Skill execution ────────────────────────────────────────────────────
      const needsApproval = skill.requiresApproval &&
        !session.autoApprove &&
        !session.approvedSkills.has(toolCall.skillName);

      if (needsApproval) {
        session.pendingTool = { toolCall, fullResponse, depth };
        skillUsageLog.approvalRequired(session.sessionFileId, slug, toolCall.skillName);
        sseWrite(res, 'approval_required', {
          skillName: toolCall.skillName,
          params: toolCall.params,
          description: skill.description,
          requiresApproval: true,
        });
        sseWrite(res, 'paused', {});
        return;
      }

      // Auto-execute (either no approval needed, already approved, or auto-approve on)
      skillUsageLog.callStart(session.sessionFileId, slug, toolCall.skillName, toolCall.params);
      sseWrite(res, 'tool_executing', { skillName: toolCall.skillName, params: toolCall.params });
      const t0 = Date.now();
      const result = await executeToolCall(toolCall.skillName, toolCall.params, session.agentSkillNames);
      skillUsageLog.callResult(session.sessionFileId, slug, toolCall.skillName, !!result?.success, result, result?.error, Date.now() - t0);
      sseWrite(res, 'tool_result', { skillName: toolCall.skillName, result });

      session.history.push({ role: 'assistant', content: fullResponse });
      session.history.push({ role: 'user', content: formatToolResult(toolCall.skillName, result) });
      await runAgentTurn(session, res, slug, depth + 1);
    } else {
      // No tool call, OR the model ignored the wrap-up instruction and emitted one anyway.
      // In the latter case, strip the <tool_call> block so it doesn't appear in the transcript.
      const finalText = (toolCall && isLastTurn)
        ? fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
        : fullResponse;

      session.history.push({ role: 'assistant', content: finalText });
      await appendToSession(slug, session.sessionFileId, 'agent', finalText);
      // Send done FIRST — user sees the response complete immediately.
      // Memory analysis runs after; memory_update SSE arrives a moment later.
      sseWrite(res, 'done', {});
      if (session.memoryEnabled) await _analyzeAndUpdateMemory(session, slug, res);
    }
  } catch (err) {
    sseWrite(res, 'error', { error: err.message });
  }
}

// POST /api/operator/agents/:slug/approve-tool
router.post('/agents/:slug/approve-tool', async (req, res) => {
  const { sessionId, approved, rememberForSession } = req.body;
  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  const session = operatorSessions.get(sessionId);
  const pending = session.pendingTool;
  if (!pending) return res.status(400).json({ error: 'No pending tool call' });

  session.pendingTool = null;

  skillUsageLog.approvalResponse(session.sessionFileId, req.params.slug, pending.toolCall.skillName, approved);

  if (!approved) {
    skillUsageLog.callResult(session.sessionFileId, req.params.slug, pending.toolCall.skillName, false, null, 'User denied tool execution', 0);
    session.history.push({ role: 'assistant', content: pending.fullResponse });
    session.history.push({ role: 'user', content: `<tool_result skill="${pending.toolCall.skillName}" success="false">User denied this tool execution.</tool_result>` });
    return res.json({ ok: true, approved: false });
  }

  // Remember approval for this session so the skill won't prompt again
  if (rememberForSession !== false) {
    session.approvedSkills.add(pending.toolCall.skillName);
  }

  skillUsageLog.callStart(session.sessionFileId, req.params.slug, pending.toolCall.skillName, pending.toolCall.params);
  const t0 = Date.now();

  let result;
  try {
    if (pending.isMcp && pending.mcpEntry) {
      result = await pending.mcpEntry.client.callTool(pending.toolCall.skillName, pending.toolCall.params);
    } else {
      result = await executeToolCall(pending.toolCall.skillName, pending.toolCall.params, session.agentSkillNames);
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }

  skillUsageLog.callResult(session.sessionFileId, req.params.slug, pending.toolCall.skillName, !!result?.success, result, result?.error, Date.now() - t0);
  session.history.push({ role: 'assistant', content: pending.fullResponse });
  session.history.push({ role: 'user', content: formatToolResult(pending.toolCall.skillName, result) });

  res.json({ ok: true, approved: true, result, skillName: pending.toolCall.skillName });
});

// POST /api/operator/agents/:slug/continue — stream agent response after tool approval
router.post('/agents/:slug/continue', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  const session = operatorSessions.get(sessionId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  await runAgentTurn(session, res, req.params.slug, 0);
  res.end();
});

// POST /api/operator/agents/:slug/reset-memory — wipe long-term memory
router.post('/agents/:slug/reset-memory', async (req, res) => {
  const { slug } = req.params;
  const { sessionId } = req.body;
  try {
    if (!(await agentExists(slug))) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    resetMemory(slug);

    // Rebuild running session's system prompt immediately with empty entries
    if (sessionId && operatorSessions.has(sessionId)) {
      const session = operatorSessions.get(sessionId);
      if (session.agentSlug === slug && session.agentManifest) {
        session.systemPrompt = buildOperatorPrompt(
          session.agentManifest,
          [],
          getAgentSkills(session.agentManifest),
          session.mcpTools,
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/operator/agents/:slug/set-memory
router.post('/agents/:slug/set-memory', (req, res) => {
  const { sessionId, memoryEnabled } = req.body;
  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }
  const session = operatorSessions.get(sessionId);
  session.memoryEnabled = !!memoryEnabled;
  res.json({ ok: true, memoryEnabled: session.memoryEnabled });
});

// POST /api/operator/agents/:slug/toggle-skill
router.post('/agents/:slug/toggle-skill', (req, res) => {
  const { sessionId, skillName, enabled } = req.body;
  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }
  const session = operatorSessions.get(sessionId);
  if (enabled) {
    session.disabledSkills.delete(skillName);
  } else {
    session.disabledSkills.add(skillName);
  }
  res.json({ ok: true, skillName, enabled: !session.disabledSkills.has(skillName) });
});

// POST /api/operator/agents/:slug/set-auto-approve
router.post('/agents/:slug/set-auto-approve', (req, res) => {
  const { sessionId, autoApprove } = req.body;
  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }
  const session = operatorSessions.get(sessionId);
  session.autoApprove = !!autoApprove;
  res.json({ ok: true, autoApprove: session.autoApprove });
});

// POST /api/operator/agents/:slug/end-session
router.post('/agents/:slug/end-session', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !operatorSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  const session = operatorSessions.get(sessionId);
  if (session?.mcpClients?.size) {
    disconnectAgentMcp(session.mcpClients);
  }
  operatorSessions.delete(sessionId);
  res.json({ ok: true });
});

// GET /api/operator/agents/:slug/sessions
router.get('/agents/:slug/sessions', async (req, res) => {
  try {
    const sessions = await listSessions(req.params.slug);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/operator/agents/:slug/sessions/:sessionId
router.get('/agents/:slug/sessions/:sessionId', async (req, res) => {
  try {
    const transcript = await getSessionTranscript(req.params.slug, req.params.sessionId);
    res.json({ transcript });
  } catch (err) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// DELETE /api/operator/agents/:slug/sessions/:sessionId
router.delete('/agents/:slug/sessions/:sessionId', async (req, res) => {
  const { slug, sessionId } = req.params;
  const { clearMemory } = req.query;

  try {
    const sessPath = path.join(agentDir(slug), 'sessions', `${sessionId}.md`);
    if (await fileExists(sessPath)) {
      await fs.unlink(sessPath);
    }

    if (clearMemory === 'true') {
      resetMemory(slug);
    }

    appLog.info('session_deleted', { sessionId, agentSlug: slug, memoryCleared: clearMemory === 'true' });
    res.json({ ok: true, memoryCleared: clearMemory === 'true' });
  } catch (err) {
    appLog.error('session_delete_failed', { sessionId, agentSlug: slug, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator/parse-file — extract text from PDF or DOCX (base64 input)
router.post('/parse-file', async (req, res) => {
  const { name, mimeType, dataBase64 } = req.body;
  if (!dataBase64 || !name) return res.status(400).json({ error: 'name and dataBase64 required' });

  const buf = Buffer.from(dataBase64, 'base64');
  const ext = name.split('.').pop().toLowerCase();

  try {
    let text = '';
    if (ext === 'pdf') {
      const result = await pdfParse(buf);
      text = result.text;
    } else if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value;
    } else {
      return res.status(400).json({ error: `Unsupported file type: .${ext}` });
    }

    res.json({ ok: true, text: text.trim() });
  } catch (err) {
    res.status(422).json({ error: `Could not parse "${name}": ${err.message}` });
  }
});

// ── Attachment helpers ────────────────────────────────────────────────────────

function _buildUserContent(message, attachments) {
  const images    = attachments.filter(a => a.dataUrl);
  const textFiles = attachments.filter(a => a.content !== undefined);

  let text = message;
  for (const f of textFiles) {
    text += `\n\n<file name="${f.name}">\n${f.content}\n</file>`;
  }

  if (images.length === 0) return text;

  const parts = [{ type: 'text', text }];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  return parts;
}

function _contentToText(content) {
  if (typeof content === 'string') return content;
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const imgs = content.filter(b => b.type === 'image_url').length;
  return text + (imgs > 0 ? `\n[${imgs} image${imgs > 1 ? 's' : ''} attached]` : '');
}

// ── Memory CRUD endpoints ─────────────────────────────────────────────────────

function _rebuildSessionPromptFromEntries(slug, sessionId, entries) {
  if (!sessionId || !operatorSessions.has(sessionId)) return;
  const session = operatorSessions.get(sessionId);
  if (session.agentSlug !== slug || !session.agentManifest) return;
  session.systemPrompt = buildOperatorPrompt(
    session.agentManifest,
    entries,
    getAgentSkills(session.agentManifest),
    session.mcpTools,
  );
}

// GET /api/operator/agents/:slug/memory
router.get('/agents/:slug/memory', (req, res) => {
  try {
    const memory = loadMemory(req.params.slug);
    res.json({ entries: memory.entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator/agents/:slug/memory — add entry
router.post('/agents/:slug/memory', (req, res) => {
  const { slug } = req.params;
  const { content, category, sessionId } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  try {
    const updated = addMemoryEntry(slug, { content, category: category || 'context' });
    _rebuildSessionPromptFromEntries(slug, sessionId, updated.entries);
    res.json({ ok: true, entries: updated.entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/operator/agents/:slug/memory/:id — update entry content
router.put('/agents/:slug/memory/:id', (req, res) => {
  const { slug, id } = req.params;
  const { content, sessionId } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  try {
    const updated = updateMemoryEntry(slug, id, content);
    _rebuildSessionPromptFromEntries(slug, sessionId, updated.entries);
    res.json({ ok: true, entries: updated.entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/operator/agents/:slug/memory/:id — remove entry
router.delete('/agents/:slug/memory/:id', (req, res) => {
  const { slug, id } = req.params;
  const { sessionId } = req.query;
  try {
    const updated = deleteMemoryEntry(slug, id);
    _rebuildSessionPromptFromEntries(slug, sessionId, updated.entries);
    res.json({ ok: true, entries: updated.entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Per-turn memory analysis ──────────────────────────────────────────────────
// Runs after every completed agent turn (after 'done' is already sent).
// Uses structured JSON memory with LLM-driven add/update operations.
// Emits a `memory_update` SSE event when entries change.

async function _analyzeAndUpdateMemory(session, slug, res) {
  try {
    // Extract the last genuine user message (skip tool call/result noise)
    const realMessages = session.history.filter(m => {
      if (m.role !== 'user' && m.role !== 'assistant') return false;
      const text = _contentToText(m.content);
      if (text.startsWith('<tool_result')) return false;
      if (/^\s*<tool_call>/.test(text)) return false;
      return true;
    });

    if (realMessages.length < 2) return;

    const userMsg = realMessages.slice(-2).find(m => m.role === 'user');
    if (!userMsg) return;
    const userText = _contentToText(userMsg.content).slice(0, 2000);

    const { entries } = loadMemory(slug);

    // Present existing entries to the LLM so it can decide add vs update vs none
    const existingStr = entries.length > 0
      ? entries.map(e => `[${e.id}] (${e.category}) ${e.content}`).join('\n')
      : '(none)';

    const result = await complete(
      [
        {
          role: 'system',
          content: `You manage long-term memory for an AI assistant.

Given the user's message and existing memories, output a JSON array of operations.
Each operation must be one of:
- {"op":"add","content":"...","category":"..."} — a new fact not already captured
- {"op":"update","id":"...","content":"..."} — corrected or updated version of an existing entry
- {"op":"none"} — nothing new to store

Categories:
- user_profile — name, role, company, location, background
- preferences  — communication style, working preferences, tool choices
- goals        — active objectives, ongoing projects, problems to solve
- context      — technical background, domain knowledge, project constraints

Rules:
- Only capture facts the user explicitly stated
- Write each fact in third person: "User prefers...", "User's name is..."
- If the fact updates or corrects an existing memory, use "update" with its id
- CASCADE RULE: When a fact changes (e.g. a name, employer, location), scan every existing entry for references to the old value and include an "update" operation for each one that still uses the outdated value — even if the user did not explicitly mention those entries
- If all stated facts are already captured accurately, output [{"op":"none"}]
- Output ONLY the JSON array — no explanation, no markdown fences

Existing memories:
${existingStr}`,
        },
        { role: 'user', content: userText },
      ],
      { temperature: 0.1, maxTokens: 512 }
    );

    // Pull the JSON array out (model may wrap it in backticks)
    const match = result?.match(/\[[\s\S]*?\]/);
    if (!match) return;

    let ops;
    try { ops = JSON.parse(match[0]); } catch { return; }

    const activeOps = ops.filter(o => o.op !== 'none');
    if (activeOps.length === 0) return;

    const updated = applyMemoryOps(slug, activeOps);

    // Rebuild session system prompt so the agent knows immediately next turn
    if (session.agentManifest) {
      session.systemPrompt = buildOperatorPrompt(
        session.agentManifest,
        updated.entries,
        getAgentSkills(session.agentManifest),
        session.mcpTools,
      );
    }

    sseWrite(res, 'memory_update', { count: updated.entries.length });

  } catch { /* best-effort — never block the conversation */ }
}

module.exports = router;
