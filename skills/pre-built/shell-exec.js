'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

// Allowlist from .env — deliberately excludes node/npm to prevent arbitrary code execution.
// Override with ALLOWED_SHELL_COMMANDS=ls,pwd,echo,... in your .env file.
const ALLOWED_COMMANDS = (
  process.env.ALLOWED_SHELL_COMMANDS || 'ls,pwd,echo,cat,grep,find,python3,python,pip'
)
  .split(',')
  .map(c => c.trim().toLowerCase())
  .filter(Boolean);

const MAX_OUTPUT_BYTES = 32 * 1024; // 32 KB — prevents huge stdout from flooding context

const PROJECT_ROOT = process.env._PROJECT_ROOT || path.join(__dirname, '..', '..');

module.exports = {
  name: 'shell-exec',
  description:
    `Execute a whitelisted shell command. Allowed: ${ALLOWED_COMMANDS.join(', ')}. ` +
    'Override the allowlist with ALLOWED_SHELL_COMMANDS in .env. Requires user approval.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to run (must be in the allowed list)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments to pass to the command',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (must be within the project directory)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 15000)',
      },
    },
    required: ['command'],
  },
  requiresApproval: true,

  execute: async ({ command, args = [], cwd, timeoutMs = 15000 }) => {
    // 1. Allowlist check
    if (!ALLOWED_COMMANDS.includes(command.toLowerCase())) {
      return {
        success: false,
        error: `"${command}" is not in the allowed list. Allowed: ${ALLOWED_COMMANDS.join(', ')}`,
      };
    }

    // 2. Reject args containing shell metacharacters (prevent injection)
    const dangerous = /[;&|`$<>\\'"]/;
    for (const arg of args) {
      if (dangerous.test(arg)) {
        return { success: false, error: `Argument contains disallowed characters: "${arg}"` };
      }
    }

    // 3. Confine cwd to within the project directory
    let resolvedCwd;
    if (cwd) {
      resolvedCwd = path.resolve(cwd);
      const root = path.resolve(PROJECT_ROOT);
      const rel  = path.relative(root, resolvedCwd);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { success: false, error: 'cwd must be within the project directory' };
      }
    }

    try {
      const opts = {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
      };

      const { stdout, stderr } = await execFileAsync(command, args, opts);

      const truncate = (s) => {
        if (Buffer.byteLength(s) > MAX_OUTPUT_BYTES) {
          return s.slice(0, MAX_OUTPUT_BYTES) + `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
        }
        return s;
      };

      return {
        success: true,
        result: {
          command: [command, ...args].join(' '),
          stdout: truncate(stdout.trim()),
          stderr: truncate(stderr.trim()),
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.killed ? `Command timed out after ${timeoutMs}ms` : err.message,
        result: {
          stdout: (err.stdout || '').trim(),
          stderr: (err.stderr || '').trim(),
        },
      };
    }
  },
};
