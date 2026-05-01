'use strict';
const fs = require('fs/promises');
const path = require('path');

// Use the module's own __dirname as the reliable root (src/utils -> project root)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Normalize a path for safe comparison on any OS.
 * On Windows, path.resolve() can return inconsistent drive-letter casing,
 * so we lowercase for comparison only (the returned path keeps original casing).
 */
function normForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve a path and ensure it stays within the project root.
 * Throws on path traversal attempts.
 */
function safePath(filePath) {
  const resolved = path.resolve(filePath);
  const root = PROJECT_ROOT;
  if (!normForCompare(resolved).startsWith(normForCompare(root))) {
    throw new Error(`Path traversal denied: ${filePath}`);
  }
  return resolved;
}

async function ensureDir(dirPath) {
  await fs.mkdir(path.resolve(dirPath), { recursive: true });
}

async function readFile(filePath) {
  const safe = safePath(filePath);
  return fs.readFile(safe, 'utf-8');
}

async function writeFile(filePath, content) {
  const safe = safePath(filePath);
  await ensureDir(path.dirname(safe));
  return fs.writeFile(safe, content, 'utf-8');
}

async function appendFile(filePath, content) {
  const safe = safePath(filePath);
  await ensureDir(path.dirname(safe));
  return fs.appendFile(safe, content, 'utf-8');
}

async function fileExists(filePath) {
  try {
    const resolved = path.resolve(filePath);
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

async function listDir(dirPath) {
  try {
    return await fs.readdir(path.resolve(dirPath));
  } catch {
    return [];
  }
}

async function removeDir(dirPath) {
  // Use path.resolve directly; safePath only needed for user-provided paths
  await fs.rm(path.resolve(dirPath), { recursive: true, force: true });
}

async function copyFile(src, dest) {
  await ensureDir(path.dirname(path.resolve(dest)));
  await fs.copyFile(path.resolve(src), path.resolve(dest));
}

async function readJSON(filePath) {
  const text = await readFile(filePath);
  return JSON.parse(text);
}

async function writeJSON(filePath, obj) {
  await writeFile(filePath, JSON.stringify(obj, null, 2));
}

module.exports = {
  safePath, ensureDir, readFile, writeFile, appendFile,
  fileExists, listDir, removeDir, copyFile, readJSON, writeJSON,
  PROJECT_ROOT,
};
