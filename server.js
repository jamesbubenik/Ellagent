'use strict';
const express = require('express');
const path = require('path');
const { ensureDir } = require('./src/utils/fileUtils');
const { loadSkills } = require('./src/services/skillService');
const { getConfig } = require('./src/services/configService');
const { loadModel, unloadAllModels } = require('./src/services/llmService');

const app = express();
const PORT = process.env.PORT || 3000;
const AGENTS_DIR = process.env.AGENTS_DIR || path.join(__dirname, 'agents');
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(__dirname, 'skills');

process.env.AGENTS_DIR = AGENTS_DIR;
process.env.SKILLS_DIR = SKILLS_DIR;
process.env._PROJECT_ROOT = __dirname;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/config',   require('./src/routes/config'));
app.use('/api/creator',  require('./src/routes/creator'));
app.use('/api/operator', require('./src/routes/operator'));
app.use('/api/skills',   require('./src/routes/skills'));

app.get('/api/health', async (req, res) => {
  const { checkHealth } = require('./src/services/llmService');
  try {
    const status = await checkHealth();
    res.json(status);
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function init() {
  await ensureDir(AGENTS_DIR);
  await ensureDir(path.join(SKILLS_DIR, 'pre-built'));
  await ensureDir(path.join(SKILLS_DIR, 'generated'));
  await loadSkills();

  const cfg = getConfig();
  app.listen(PORT, () => {
    console.log(`Ellagent running at http://localhost:${PORT}`);
    console.log(`  LM Studio URL: ${cfg.baseUrl}`);
    console.log(`  Model:         ${cfg.model}`);
    console.log(`  Agents dir:    ${AGENTS_DIR}`);
    console.log(`  Skills dir:    ${SKILLS_DIR}`);

    // Unload all existing models then load the configured one — run in background
    unloadAllModels(cfg).then(() => loadModel(cfg)).then(r => {
      if (r.ok) console.log(`  Model loaded: ctx=${r.contextLength ?? cfg.contextWindow} (${r.loadTime ?? '?'}s)`);
      else      console.warn(`  Model load skipped: ${r.error}`);
    });
  });
}

init().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
