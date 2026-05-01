#!/usr/bin/env node
'use strict';

/**
 * Memory updater — optional Claude Code Stop hook.
 * After each session, reads the transcript and asks the local LLM whether
 * anything significant should be persisted to a long-term memory file.
 *
 * To enable, add this to your .claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "Stop": [{
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node /absolute/path/to/scripts/update-memory.js",
 *           "timeout": 45,
 *           "async": true
 *         }]
 *       }]
 *     }
 *   }
 *
 * stdin JSON (Claude Code Stop hook): { transcript_path: "..." }
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE  = path.join(PROJECT_ROOT, 'config.json');

// Derive the Claude Code project memory path from the project root.
// Claude Code hashes the project path into a directory name — this constructs it
// the same way: replace path separators with '--' and strip the leading slash.
function getMemoryFile() {
  const normalized = PROJECT_ROOT.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
  const slug = normalized.replace(/\//g, '-').replace(/^-/, '');
  const base = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(base, '.claude', 'projects', slug, 'memory', 'memory-long-term.md');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return null; }
}

function callLMStudio(baseUrl, apiKey, model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2048, stream: false });
    const url  = new URL(`${baseUrl}/chat/completions`);
    const lib  = url.protocol === 'http:' ? http : https;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'http:' ? 80 : 443),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey || 'lm-studio'}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content || ''); }
        catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function messagesFromTranscript(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
  const out   = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      let content = '';
      if (typeof entry.message?.content === 'string') {
        content = entry.message.content;
      } else if (Array.isArray(entry.message?.content)) {
        content = entry.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      }
      if (content.trim()) out.push({ role: entry.type === 'user' ? 'user' : 'assistant', content });
    } catch { /* skip */ }
  }
  return out.slice(-10);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  if (!cfg?.baseUrl || !cfg?.model) return;

  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  let hookInput;
  try { hookInput = JSON.parse(raw); } catch { return; }

  let messages;
  if (Array.isArray(hookInput.messages) && hookInput.messages.length > 0) {
    messages = hookInput.messages;
  } else if (hookInput.transcript_path && fs.existsSync(hookInput.transcript_path)) {
    messages = messagesFromTranscript(hookInput.transcript_path);
  } else {
    return;
  }

  if (messages.length < 2) return;

  const memoryFile = getMemoryFile();
  const currentMemory = fs.existsSync(memoryFile)
    ? fs.readFileSync(memoryFile, 'utf8')
    : '# Long-Term Memory\n\n(empty)';

  const systemPrompt =
    'You are a memory manager. After each conversation you decide what new information ' +
    'is worth keeping in a long-term memory file so the assistant gets smarter and more ' +
    'personable over time. Store: user preferences, project decisions, patterns, anything ' +
    'that improves future interactions. Rules: only add genuinely new information; keep ' +
    'entries concise; never duplicate existing entries; never remove correct memories. ' +
    'If nothing new was learned respond with exactly: NO_UPDATE. ' +
    'Otherwise respond with the COMPLETE updated memory file content.';

  const prompt =
    `Current memory file:\n\`\`\`\n${currentMemory}\n\`\`\`\n\n` +
    `Recent conversation:\n` +
    messages.map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 1500)}`).join('\n\n---\n\n') +
    `\n\nShould the memory file be updated? Return the full updated file or NO_UPDATE.`;

  const response = await callLMStudio(cfg.baseUrl, cfg.apiKey, cfg.model, [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: prompt },
  ]);

  if (!response || response.trim() === 'NO_UPDATE') return;
  if (response.length < 50 || !response.includes('#')) return;

  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, response.trim() + '\n', 'utf8');
}

main().catch(() => { /* silently exit on any error */ });
