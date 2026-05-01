'use strict';
const fs   = require('fs/promises');
const path = require('path');

const PROJECT_ROOT  = process.env._PROJECT_ROOT || path.join(__dirname, '..', '..');
const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap

module.exports = {
  name: 'file-write',
  description:
    'Write or append content to a local file within the project directory. Requires user approval.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file (absolute or relative to project root)',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
      mode: {
        type: 'string',
        enum: ['write', 'append'],
        description: 'Overwrite the file (write) or add to the end (append). Default: write',
      },
      encoding: {
        type: 'string',
        enum: ['utf-8', 'utf8', 'base64'],
        description: 'Content encoding (default: utf-8)',
      },
      createDirs: {
        type: 'boolean',
        description: 'Create intermediate directories if they do not exist (default: true)',
      },
    },
    required: ['filePath', 'content'],
  },
  requiresApproval: true,

  execute: async ({ filePath, content, mode = 'write', encoding = 'utf-8', createDirs = true }) => {
    try {
      const resolved = path.resolve(filePath);
      const root     = path.resolve(PROJECT_ROOT);

      // Safe confinement check
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { success: false, error: 'Path traversal denied: file must be within the project directory' };
      }

      const rawEncoding = encoding === 'utf-8' ? 'utf8' : encoding;
      const buf         = Buffer.from(content, rawEncoding === 'base64' ? 'base64' : 'utf8');

      if (buf.length > MAX_WRITE_BYTES) {
        return {
          success: false,
          error: `Content too large: ${buf.length} bytes (max ${MAX_WRITE_BYTES})`,
        };
      }

      if (createDirs) {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
      }

      if (mode === 'append') {
        await fs.appendFile(resolved, buf);
      } else {
        await fs.writeFile(resolved, buf);
      }

      const stat = await fs.stat(resolved);
      return {
        success: true,
        result: {
          path: resolved,
          mode,
          bytesWritten: buf.length,
          totalSize: stat.size,
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
