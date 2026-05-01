'use strict';
const { getSkill } = require('./skillService');

/**
 * Parse a potential tool call from an LLM response string.
 * Handles the variations local LLMs commonly produce:
 *   - <tool_call>{...}</tool_call>            (canonical)
 *   - <tool_call>\n```json\n{...}\n```        (LLM wrapped in fence)
 *   - skill/skill_name/tool instead of "skill" key
 *   - params/arguments/input instead of "params" key
 * Returns { skillName, params } or null if no tool call found.
 */
function parseToolCall(responseText) {
  // 1. Extract the raw content between <tool_call> tags (case-insensitive)
  const tagMatch = /<tool_call>([\s\S]*?)<\/tool_call>/i.exec(responseText);
  let jsonCandidate = tagMatch ? tagMatch[1].trim() : null;

  // 2. If no tags, see if the whole response looks like a bare JSON tool call
  if (!jsonCandidate) {
    const bare = responseText.trim();
    if (bare.startsWith('{') && bare.endsWith('}')) {
      jsonCandidate = bare;
    }
  }

  if (!jsonCandidate) return null;

  // 3. Strip any markdown code fences the LLM may have added inside the block
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(jsonCandidate);
  if (fenceMatch) jsonCandidate = fenceMatch[1].trim();

  // 4. Parse JSON
  let obj;
  try {
    obj = JSON.parse(jsonCandidate);
  } catch {
    // Try to find the first {...} block if there is surrounding text
    const embedded = /(\{[\s\S]*\})/.exec(jsonCandidate);
    if (!embedded) return null;
    try { obj = JSON.parse(embedded[1]); } catch { return null; }
  }

  if (!obj || typeof obj !== 'object') return null;

  // 5. Normalise key names — LLMs sometimes use skill_name, tool, tool_name, name
  const skillName =
    obj.skill      || obj.skill_name  ||
    obj.tool       || obj.tool_name   ||
    obj.name       || obj.function    || null;
  if (!skillName || typeof skillName !== 'string') return null;

  // 6. Normalise params key — LLMs sometimes use arguments, input, inputs, parameters
  const params =
    obj.params     || obj.parameters  ||
    obj.arguments  || obj.input       ||
    obj.inputs     || {};

  return { skillName: skillName.trim(), params: params || {} };
}

/**
 * Execute a tool call on behalf of an agent.
 * Verifies the skill exists and is registered to the agent.
 *
 * @param {string} skillName
 * @param {object} params
 * @param {string[]} agentSkillNames - skill names registered to this agent
 * @returns {{ success, result, error? }}
 */
async function executeToolCall(skillName, params, agentSkillNames) {
  if (!agentSkillNames.includes(skillName)) {
    return { success: false, error: `Skill "${skillName}" is not registered for this agent` };
  }

  const skill = getSkill(skillName);
  if (!skill) {
    return { success: false, error: `Skill "${skillName}" not found in registry` };
  }

  try {
    const result = await skill.execute(params);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Format a tool result for injection back into the LLM conversation.
 */
function formatToolResult(skillName, result) {
  if (result.success) {
    return `<tool_result skill="${skillName}" success="true">${JSON.stringify(result.result, null, 2)}</tool_result>`;
  } else {
    return `<tool_result skill="${skillName}" success="false">Error: ${result.error}</tool_result>`;
  }
}

module.exports = { parseToolCall, executeToolCall, formatToolResult };
