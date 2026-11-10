/** Curated configuration templates; importing never executes a process. */
export const integrationCatalog = {
  acp: [
    { id: "codex", name: "Codex", description: "OpenAI coding agent via ACP", command: "pnpm", args: ["dlx", "@agentclientprotocol/codex-acp"], env: {}, cwd: null, enabled: false },
    { id: "claude-code", name: "Claude Code", description: "Claude coding agent via ACP", command: "pnpm", args: ["dlx", "@agentclientprotocol/claude-agent-acp"], env: {}, cwd: null, enabled: false },
    { id: "opencode", name: "OpenCode", description: "OpenCode coding agent via ACP", command: "opencode", args: ["acp"], env: {}, cwd: null, enabled: false },
  ],
  mcp: [
    { id: "memory", name: "Memory", description: "Persistent knowledge graph", transportType: "STDIO", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"], env: {}, isEnabled: false },
    { id: "filesystem", name: "Filesystem", description: "File access within the directories you configure", transportType: "STDIO", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-filesystem"], env: {}, isEnabled: false },
  ],
} as const;
