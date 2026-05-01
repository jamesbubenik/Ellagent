# Ellagent

A full-stack AI agent builder and operator platform that runs entirely on your local machine. Create, configure, and chat with AI agents powered by any model running in [LM Studio](https://lmstudio.ai).

No cloud subscriptions. No API costs. Your data stays local.

---

## Features

- **Agent Creator** — Build agents with a name, description, personality (soul), system prompt, and long-term memory. Assign skills and MCP servers per agent.
- **Agent Operator** — Chat with any agent in a full conversation interface with real-time streaming, tool-use indicators, and context-window monitoring.
- **Skills System** — Pre-built and user-generated skills extend what agents can do: file I/O, HTTP requests, web search, web scraping, shell execution, and more. Skills are Node.js modules with a validated sandbox.
- **MCP Server Support** — Connect agents to [Model Context Protocol](https://modelcontextprotocol.io) servers (stdio and HTTP) for external tool integrations.
- **Settings** — Configure LM Studio connection, model selection, context window, inference parameters, and global MCP servers through the UI.

---

## Dependencies

| Dependency | Purpose |
|---|---|
| [Node.js](https://nodejs.org) ≥ 18 | Runtime |
| [LM Studio](https://lmstudio.ai) ≥ 0.3 | Local LLM server (OpenAI-compatible API) |

No other external services required.

---

## Installation

**1. Clone the repository**

```bash
git clone https://github.com/jamesbubenik/Ellagent.git
cd ellagent
```

**2. Install dependencies**

```bash
npm install
```

**3. Start LM Studio**

- Open LM Studio and download a model
- Start the local server (default: `http://localhost:1234`)
- Load your chosen model

**4. Start Ellagent**

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Configuration

All configuration is done through the **Settings** tab in the UI. No manual file editing required.

| Setting | Description | Default |
|---|---|---|
| LM Studio URL | Base URL of the LM Studio server | `http://localhost:1234/v1` |
| API Key | LM Studio API key (any string works) | `lm-studio` |
| Model | Model ID to load and use | *(select from dropdown)* |
| Timeout | Request timeout in milliseconds | `120000` |
| Context Window | Token context length for the model | `4096` |
| Max Tool Depth | Maximum recursive tool-call depth | `5` |
| Log Level | Server log verbosity (`off`, `error`, `info`, `debug`) | `info` |

### Optional: Environment Variables

Copy `.env.example` to `.env` to override server defaults:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3000` |
| `AGENTS_DIR` | Path to agents directory | `./agents` |
| `SKILLS_DIR` | Path to skills directory | `./skills` |

---

## Project Structure

```
ellagent/
├── agents/              # Agent directories (created at runtime)
├── data/
│   └── skill-overrides.json   # Per-skill approval overrides
├── logs/                # Server logs (runtime)
├── public/              # Frontend (HTML, CSS, JS)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── creator.js   # Agent creator view
│       ├── operator.js  # Agent operator/chat view
│       ├── settings.js  # Settings view
│       └── skills.js    # Skills manager view
├── scripts/
│   └── update-memory.js # Optional Claude Code hook
├── skills/
│   ├── pre-built/       # Built-in skills
│   └── generated/       # User-created skills (runtime)
├── src/
│   ├── routes/          # Express route handlers
│   ├── services/        # Business logic (LLM, agents, skills, MCP)
│   └── utils/           # Shared utilities
├── server.js            # Entry point
└── package.json
```

---

## Pre-Built Skills

| Skill | Description | Approval Required |
|---|---|---|
| `file-read` | Read files from the local filesystem | Yes |
| `file-write` | Write files to the local filesystem | Yes |
| `http-request` | Make HTTP/HTTPS requests | Yes |
| `shell-exec` | Execute shell commands | Yes |
| `web-search` | Search the web via DuckDuckGo | Yes |
| `web-scrape` | Scrape text content from a URL | Yes |

Approval requirements can be toggled per-skill from the Skills page.

---

## Creating Custom Skills

Custom skills are CommonJS Node.js modules placed in `skills/generated/`. You can create them directly from the **Skills** tab in the UI (with optional AI assistant).

A skill must export:

```javascript
module.exports = {
  name: 'my-skill',
  description: 'What this skill does',
  requiresApproval: true,   // true if it touches the network or filesystem
  parameters: {             // JSON Schema for the params object
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  execute: async (params) => {
    // ... your logic
    return { success: true, result: '...' };
    // or: return { success: false, error: 'something went wrong' };
  },
};
```

**Constraints enforced at save time:**
- Only built-in Node.js modules allowed (`http`, `https`, `fs`, `path`, `crypto`, etc.)
- No `eval()`, `new Function()`, or dynamic `require()`
- Skills making network calls or writing to the filesystem must set `requiresApproval: true`

---

## MCP Servers

Ellagent supports [Model Context Protocol](https://modelcontextprotocol.io) servers as a tool source for agents.

**Global MCP servers** are configured in Settings → MCP Servers and can be assigned to individual agents in the agent editor.

Supported transports:
- **stdio** — launches a local process (e.g. `npx @modelcontextprotocol/server-filesystem`)
- **http** — connects to a running HTTP MCP server

---

## Optional: Claude Code Memory Hook

`scripts/update-memory.js` is a Claude Code Stop hook that uses the local LLM to summarize sessions and persist useful context to long-term memory. It is **not required** to use Ellagent.

To enable it, add the following to your Claude Code project settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/ellagent/scripts/update-memory.js",
        "timeout": 45,
        "async": true
      }]
    }]
  }
}
```

---

## License

MIT
