'use strict';
const fs   = require('fs/promises');
const path = require('path');

const PROJECT_ROOT  = process.env._PROJECT_ROOT || path.join(__dirname, '..', '..');
const MAX_BYTES_CAP = 512 * 1024; // hard cap at 512 KB

module.exports = {
  name: 'file-read',
  description:
    'Read the contents of a local file. ' +
    'Path must be within the project directory. ' +
    'Large files are truncated; use startLine/endLine to read a specific range.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file (absolute or relative to project root)',
      },
      encoding: {
        type: 'string',
        enum: ['utf-8', 'utf8', 'base64'],
        description: 'File encoding (default: utf-8)',
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum bytes to return (default: 102400 = 100 KB). Oversized files are truncated.',
      },
      startLine: {
        type: 'number',
        description: '1-based line number to start reading from (requires utf-8 encoding)',
      },
      endLine: {
        type: 'number',
        description: '1-based line number to stop at (inclusive). Requires startLine.',
      },
    },
    required: ['filePath'],
  },
  requiresApproval: false,

  execute: async ({ filePath, encoding = 'utf-8', maxBytes = 102400, startLine, endLine }) => {
    try {
      const resolved = path.resolve(filePath);
      const root     = path.resolve(PROJECT_ROOT);

      // Safe confinement check — use path.relative to avoid prefix-match false positives
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { success: false, error: 'Path traversal denied: file must be within the project directory' };
      }

      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return { success: false, error: `Not a file: ${resolved}` };
      }

      const effectiveMax = Math.min(maxBytes, MAX_BYTES_CAP);
      const rawEncoding  = encoding === 'utf-8' ? 'utf8' : encoding;

      // Line-range read
      if (startLine !== undefined && rawEncoding !== 'base64') {
        const fullContent = await fs.readFile(resolved, 'utf8');
        const lines = fullContent.split('\n');
        const from  = Math.max(1, startLine) - 1;
        const to    = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;
        const slice = lines.slice(from, to).join('\n');
        return {
          success: true,
          result: {
            path: resolved,
            content: slice,
            linesReturned: to - from,
            totalLines: lines.length,
            encoding: 'utf-8',
          },
        };
      }

      // Standard read with size enforcement
      let content;
      let truncated = false;

      if (stat.size > effectiveMax) {
        // Read only the allowed byte count rather than erroring
        const fd = await fs.open(resolved, 'r');
        try {
          const buf = Buffer.alloc(effectiveMax);
          await fd.read(buf, 0, effectiveMax, 0);
          content   = rawEncoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
          truncated = true;
        } finally {
          await fd.close();
        }
      } else {
        content = await fs.readFile(resolved, rawEncoding);
      }

      return {
        success: true,
        result: {
          path: resolved,
          content,
          size: stat.size,
          encoding,
          ...(truncated ? { truncated: true, note: `File truncated at ${effectiveMax} bytes (full size: ${stat.size})` } : {}),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
