'use strict';
const path = require('path');
const fs   = require('fs/promises');
const vm   = require('vm');
const { listDir, writeFile, fileExists } = require('../utils/fileUtils');
const { appLog } = require('../utils/logger');

// __dirname here is always src/services — resolve skills relative to it
const _DEFAULT_SKILLS  = path.resolve(__dirname, '..', '..', 'skills');
const _OVERRIDES_PATH  = path.resolve(__dirname, '..', '..', 'data', 'skill-overrides.json');
const SKILLS_DIR = () => process.env.SKILLS_DIR ? path.resolve(process.env.SKILLS_DIR) : _DEFAULT_SKILLS;

// In-memory skill registry: name -> skill module
const registry = new Map();

async function _loadOverrides() {
  try {
    const raw = await fs.readFile(_OVERRIDES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function _saveOverrides(overrides) {
  try { await fs.mkdir(path.dirname(_OVERRIDES_PATH), { recursive: true }); } catch {}
  await fs.writeFile(_OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf-8');
}

/**
 * Load all skills from pre-built and generated directories.
 */
async function loadSkills() {
  registry.clear();
  const overrides = await _loadOverrides();
  const dirs = [
    { dir: path.join(SKILLS_DIR(), 'pre-built'), type: 'pre-built' },
    { dir: path.join(SKILLS_DIR(), 'generated'), type: 'generated' },
  ];

  for (const { dir, type } of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const file of entries) {
      if (!file.endsWith('.js')) continue;
      const fullPath = path.join(dir, file);
      try {
        // Clear require cache so hot-reloading works
        delete require.cache[require.resolve(fullPath)];
        const skill = require(fullPath);
        if (skill && skill.name && typeof skill.execute === 'function') {
          const override = overrides[skill.name];
          const entry = { ...skill, _type: type, _fileName: file.replace(/\.js$/, '') };
          if (override && 'requiresApproval' in override) {
            entry.requiresApproval = override.requiresApproval;
          }
          registry.set(skill.name, entry);
        }
      } catch (err) {
        appLog.warn('skill_load_failed', { file, error: err.message });
      }
    }
  }

  appLog.info('skills_registered', { skills: [...registry.keys()] });
  return [...registry.values()];
}

function getSkill(name) {
  return registry.get(name) || null;
}

function getAvailableSkills() {
  return [...registry.values()].map(s => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
    requiresApproval: !!s.requiresApproval,
    type: s._type || 'generated',
  }));
}

/**
 * Return only the skills that are registered for a specific agent.
 */
function getAgentSkills(manifest) {
  const names = [...(manifest.requiredSkills || []), ...(manifest.generatedSkills || [])];
  return names.map(n => registry.get(n)).filter(Boolean);
}

// Packages not installed in this project that LLMs commonly hallucinate
const _FORBIDDEN_MODULES = [
  'axios', 'node-fetch', 'got', 'superagent', 'request', 'needle',
  'undici', 'cross-fetch', 'isomorphic-fetch',
];

// Hallucinated injection patterns — these are NOT real APIs in this platform
const _HALLUCINATED_APIS = [
  /params\s*\.\s*httpRequest\s*\(/,
  /params\s*\.\s*request\s*\(/,
  /params\s*\.\s*fetch\s*\(/,
  /params\s*\.\s*http\s*\./,
  /params\s*\.\s*https\s*\./,
  /context\s*\.\s*httpRequest\s*\(/,
  /this\s*\.\s*httpRequest\s*\(/,
];

/**
 * Validate that generated skill code does not contain dangerous or broken patterns.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateSkillCode(code) {
  // 1. Syntax check — catches malformed code before any file is written
  try {
    new vm.Script(code, { filename: 'skill-validate.js' });
  } catch (e) {
    return { valid: false, error: `Syntax error: ${e.message}` };
  }

  // 2. Hard security rules
  if (/\beval\s*\(/.test(code))         return { valid: false, error: 'eval() is not allowed' };
  if (/new\s+Function\s*\(/.test(code)) return { valid: false, error: 'new Function() is not allowed' };

  // 3a. Detect the JSON.parse-on-LLM-response antipattern.
  // This fires when code calls JSON.parse() on what appears to be an LM Studio
  // response variable (choices[0].message.content), which is always a plain string.
  const hasLlmResponseCapture = /parsed\.choices\s*\?\.\s*\[0\]|choices\?\.\[0\]\?\.message/i.test(code);
  const hasJsonParseOnResponse = /JSON\s*\.\s*parse\s*\(\s*(?:parsed\.choices|response|text|content|aiResponse|llmResponse|llmText|result)\b/i.test(code);
  if (hasLlmResponseCapture && hasJsonParseOnResponse) {
    return {
      valid: false,
      error: 'JSON.parse() called directly on an LLM response string. ' +
             'LM Studio returns plain text, not JSON. Return the text as-is, ' +
             'or extract JSON with a regex: text.match(/\\{[\\s\\S]*\\}/)?.[0] wrapped in try/catch.',
    };
  }

  // 3. Hallucinated injection APIs that don't exist in this platform
  for (const pattern of _HALLUCINATED_APIS) {
    if (pattern.test(code)) {
      return {
        valid: false,
        error: `Hallucinated API detected (${pattern.source.slice(0, 40)}…). ` +
               `Use require('http') / require('https') for network requests, ` +
               `and require('../../src/services/configService').getConfig() for LM Studio config.`,
      };
    }
  }

  // 4. Forbidden external packages (not installed)
  for (const pkg of _FORBIDDEN_MODULES) {
    const re = new RegExp(`require\\s*\\(\\s*['"\`]${pkg}['"\`]\\s*\\)`);
    if (re.test(code)) {
      return {
        valid: false,
        error: `"${pkg}" is not installed. Use require('http') / require('https') instead.`,
      };
    }
  }

  // 5. Dynamic require (variable argument — injection risk)
  const requirePattern = /require\s*\(\s*([^'"`)]+)\s*\)/g;
  let match;
  while ((match = requirePattern.exec(code)) !== null) {
    const arg = match[1].trim();
    if (!arg.startsWith("'") && !arg.startsWith('"') && !arg.startsWith('`')) {
      return { valid: false, error: `Dynamic require() detected: require(${arg}) — only literal string paths are allowed` };
    }
  }

  // 6. requiresApproval enforcement
  const hasNetworkCall = /\bfetch\s*\(|\bhttp\b|\bhttps\b/.test(code);
  if (hasNetworkCall && !/requiresApproval\s*:\s*true/.test(code)) {
    return { valid: false, error: 'Skills making network calls must set requiresApproval: true' };
  }

  const hasFsWrite = /\bfs\b.*\b(writeFile|appendFile|mkdir|rm|unlink)/.test(code);
  if (hasFsWrite && !/requiresApproval\s*:\s*true/.test(code)) {
    return { valid: false, error: 'Skills that write to the filesystem must set requiresApproval: true' };
  }

  // 7. Structural check — must export name and execute
  if (!/module\.exports\s*=/.test(code)) {
    return { valid: false, error: 'Skill must use module.exports = { ... }' };
  }
  if (!/\bexecute\s*:/.test(code)) {
    return { valid: false, error: 'Skill module.exports must include an execute function' };
  }

  return { valid: true };
}

/**
 * Save a generated skill module to disk after validation. Reloads the registry.
 */
async function saveGeneratedSkill(skillName, code) {
  const validation = validateSkillCode(code);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const skillPath = path.join(SKILLS_DIR(), 'generated', `${skillName}.js`);
  await writeFile(skillPath, code);

  // Re-verify it actually loads
  try {
    delete require.cache[require.resolve(skillPath)];
    const skill = require(skillPath);
    if (!skill.name || typeof skill.execute !== 'function') {
      throw new Error('Module missing required exports (name, execute)');
    }
    registry.set(skill.name, { ...skill, _type: 'generated', _fileName: skillName });
    return { ok: true, skill };
  } catch (err) {
    // Remove the bad file
    await fs.unlink(skillPath).catch(() => {});
    return { ok: false, error: `Skill failed to load after saving: ${err.message}` };
  }
}

/**
 * Read the source code of a skill from disk.
 * Returns { source, type } where type is 'pre-built' or 'generated'.
 */
async function getSkillSource(name) {
  const skill = registry.get(name);
  if (!skill) throw new Error(`Skill "${name}" not found`);
  const dir = skill._type === 'pre-built'
    ? path.join(SKILLS_DIR(), 'pre-built')
    : path.join(SKILLS_DIR(), 'generated');
  const fileName = skill._fileName || name;
  const source = await fs.readFile(path.join(dir, `${fileName}.js`), 'utf8');
  return { source, type: skill._type || 'generated' };
}

/**
 * Set requiresApproval for any skill.
 * Pre-built: persisted in data/skill-overrides.json (source unchanged).
 * Generated: source file is patched in-place.
 */
async function setSkillApproval(name, value) {
  const skill = registry.get(name);
  if (!skill) throw new Error(`Skill "${name}" not found`);

  if (skill._type === 'pre-built') {
    const overrides = await _loadOverrides();
    overrides[name] = { ...overrides[name], requiresApproval: value };
    await _saveOverrides(overrides);
    registry.set(name, { ...skill, requiresApproval: value });
    return;
  }

  // Generated: patch the source file directly
  const filePath = path.join(SKILLS_DIR(), 'generated', `${skill._fileName || name}.js`);
  let code = await fs.readFile(filePath, 'utf8');
  if (/requiresApproval\s*:\s*(true|false)/.test(code)) {
    code = code.replace(/requiresApproval\s*:\s*(true|false)/, `requiresApproval: ${value}`);
  } else {
    code = code.replace(/([\s\n])(execute\s*:)/, `$1requiresApproval: ${value},\n  $2`);
  }
  await writeFile(filePath, code);
  delete require.cache[require.resolve(filePath)];
  const updated = require(filePath);
  registry.set(name, { ...updated, _type: 'generated' });
}

/**
 * Delete a generated skill from disk and remove it from the registry.
 * Pre-built skills cannot be deleted.
 */
async function deleteSkill(name) {
  const skill = registry.get(name);
  if (!skill) throw new Error(`Skill "${name}" not found`);
  if (skill._type === 'pre-built') throw new Error('Pre-built skills cannot be deleted');
  const filePath = path.join(SKILLS_DIR(), 'generated', `${skill._fileName || name}.js`);
  await fs.unlink(filePath);
  delete require.cache[require.resolve(filePath)];
  registry.delete(name);
}

module.exports = { loadSkills, getSkill, getAvailableSkills, getAgentSkills, saveGeneratedSkill, validateSkillCode, getSkillSource, deleteSkill, setSkillApproval };
