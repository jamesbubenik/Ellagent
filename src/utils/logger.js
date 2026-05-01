'use strict';
const fs   = require('fs');
const path = require('path');

const LOGS_DIR    = path.resolve(__dirname, '..', '..', 'logs');
const LOG_FILE    = path.join(LOGS_DIR, 'app.log');
const MAX_BYTES   = 10 * 1024 * 1024; // rotate at 10 MB
const MAX_BACKUPS = 5;                 // keep app.1.log … app.5.log

// ── Level hierarchy ───────────────────────────────────────────────────────────
//  off   (0) : nothing written
//  error (1) : ERROR only
//  info  (2) : ERROR + WARN + INFO  (default)
//  debug (3) : everything, also echoed to the console

const LEVEL_CEILING  = { off: 0, error: 1, info: 2, debug: 3 };
const EVENT_SEVERITY = { ERROR: 1, WARN: 2, INFO: 2, DEBUG: 3 };

function _ceiling() {
  try {
    const { getConfig } = require('../services/configService');
    return LEVEL_CEILING[getConfig().logLevel] ?? LEVEL_CEILING.info;
  } catch {
    return LEVEL_CEILING.info;
  }
}

// ── Rotation ──────────────────────────────────────────────────────────────────

function _ensure() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function _rotate() {
  // Shift backups up: app.5.log is dropped, app.4.log → app.5.log, …, app.log → app.1.log
  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const src  = i === 1 ? LOG_FILE : path.join(LOGS_DIR, `app.${i - 1}.log`);
    const dest = path.join(LOGS_DIR, `app.${i}.log`);
    if (fs.existsSync(src)) {
      if (i === MAX_BACKUPS && fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(src, dest);
    }
  }
}

// ── Core writer ───────────────────────────────────────────────────────────────

function _write(level, data) {
  const ceiling = _ceiling();
  if (ceiling === 0) return;
  if ((EVENT_SEVERITY[level] ?? 2) > ceiling) return;

  _ensure();

  // Rotate before writing if the active log has grown too large
  try {
    if (fs.statSync(LOG_FILE).size >= MAX_BYTES) _rotate();
  } catch {
    // File doesn't exist yet — no rotation needed
  }

  const entry = JSON.stringify({ ts: new Date().toISOString(), level, ...data }) + '\n';
  try {
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
  } catch (err) {
    // Last-resort fallback — never recurse into appLog here
    console.error('[logger] Failed to write log:', err.message);
  }

  // At debug level, also echo every entry to the console
  if (ceiling >= LEVEL_CEILING.debug) {
    const fn = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'DEBUG' ? 'debug' : 'log';
    console[fn](`[${level}] [${data.event || '?'}]`, JSON.stringify(data));
  }
}

// ── General application logger ────────────────────────────────────────────────

const appLog = {
  info  (event, data = {}) { _write('INFO',  { logger: 'app', event, ...data }); },
  warn  (event, data = {}) { _write('WARN',  { logger: 'app', event, ...data }); },
  error (event, data = {}) { _write('ERROR', { logger: 'app', event, ...data }); },
  debug (event, data = {}) { _write('DEBUG', { logger: 'app', event, ...data }); },
};

// ── Skill Build Logger ────────────────────────────────────────────────────────

const skillBuildLog = {
  buildStart(skillName, description) {
    _write('INFO', { logger: 'skill-build', event: 'build_start', skillName, description });
  },

  promptBuilt(skillName, systemPromptLength, userPromptLength) {
    _write('DEBUG', {
      logger: 'skill-build', event: 'prompt_built', skillName,
      systemPromptLen: systemPromptLength, userPromptLen: userPromptLength,
    });
  },

  llmResponse(skillName, rawCode, strippedCode) {
    _write('DEBUG', {
      logger: 'skill-build', event: 'llm_response', skillName,
      rawLen: rawCode.length, strippedLen: strippedCode.length,
      strippedPreview: strippedCode.slice(0, 400),
    });
  },

  validationFail(skillName, error) {
    _write('WARN', { logger: 'skill-build', event: 'validation_fail', skillName, error });
  },

  buildSuccess(skillName) {
    _write('INFO', { logger: 'skill-build', event: 'build_success', skillName });
  },

  buildFail(skillName, error) {
    _write('ERROR', {
      logger: 'skill-build', event: 'build_fail', skillName,
      error: String(error), stack: error?.stack,
    });
  },
};

// ── Skill Usage Logger ────────────────────────────────────────────────────────

const skillUsageLog = {
  callStart(sessionId, agentSlug, skillName, params) {
    _write('INFO', { logger: 'skill-usage', event: 'call_start', sessionId, agentSlug, skillName, params });
  },

  blocked(sessionId, agentSlug, skillName, reason) {
    _write('WARN', { logger: 'skill-usage', event: 'call_blocked', sessionId, agentSlug, skillName, reason });
  },

  callResult(sessionId, agentSlug, skillName, success, result, error, durationMs) {
    _write(success ? 'INFO' : 'ERROR', {
      logger: 'skill-usage', event: 'call_result', sessionId, agentSlug, skillName, success, durationMs,
      result: success ? _summarize(result) : undefined,
      error:  error   ? String(error)       : undefined,
    });
  },

  approvalRequired(sessionId, agentSlug, skillName) {
    _write('INFO', { logger: 'skill-usage', event: 'approval_required', sessionId, agentSlug, skillName });
  },

  approvalResponse(sessionId, agentSlug, skillName, approved) {
    _write('INFO', { logger: 'skill-usage', event: 'approval_response', sessionId, agentSlug, skillName, approved });
  },
};

function _summarize(value) {
  if (value == null) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

module.exports = { appLog, skillBuildLog, skillUsageLog };
