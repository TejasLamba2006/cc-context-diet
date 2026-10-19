import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DietConfig, loadDietConfig } from "./config.js";

export interface SkillEntry {
  name: string;
  namespace: string;
  source: "user" | "plugin";
  filePath: string;
  description: string;
  listingChars: number;
  fullBodyChars: number;
}

export interface McpServerAudit {
  name: string;
  source: string;
  estimatedTools: number;
  estimatedSchemaTokens: number;
}

export interface ContextAuditReport {
  skills: {
    totalCount: number;
    userCount: number;
    pluginCount: number;
    beforeChars: number;
    beforeTokens: number;
    afterChars: number;
    afterTokens: number;
    savedTokens: number;
    byNamespace: Array<{ namespace: string; count: number; beforeTokens: number }>;
  };
  mcp: {
    serverCount: number;
    estimatedToolCount: number;
    gatewayDetected: boolean;
    baseUrl?: string;
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    servers: McpServerAudit[];
  };
  subagentBoot: {
    beforeTokensPerSpawn: number;
    afterTokensPerSpawn: number;
    savedTokensPerSpawn: number;
  };
  memoryAndRules: {
    claudeMdTokens: number;
    memoryMdTokens: number;
  };
  totals: {
    beforeTurn1Tokens: number;
    afterTurn1Tokens: number;
    savedTurn1Tokens: number;
    reductionPercent: number;
  };
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.8);
}

function parseFrontmatterDescription(content: string): { name?: string; description: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    const firstPara = content
      .replace(/^#[^\n]*\n+/, "")
      .trim()
      .split(/\r?\n\r?\n/)[0] || "";
    return { description: firstPara.replace(/\s+/g, " ").slice(0, 300) };
  }
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*["']?([^\r\n"']+)["']?/m);
  const descBlockMatch = fm.match(/^description:\s*[>|][-+]?\r?\n((?:[ \t]+[^\r\n]+\r?\n?)+)/m);
  if (descBlockMatch) {
    return {
      name: nameMatch?.[1]?.trim(),
      description: descBlockMatch[1].replace(/\s+/g, " ").trim(),
    };
  }
  const descLineMatch = fm.match(/^description:\s*["']?([^\r\n"']+)["']?/m);
  return {
    name: nameMatch?.[1]?.trim(),
    description: (descLineMatch?.[1] || "").trim(),
  };
}

function collectSkillFiles(
  rootDir: string,
  source: "user" | "plugin",
  out: SkillEntry[] = [],
): SkillEntry[] {
  if (!fs.existsSync(rootDir)) return out;
  const seenRealPaths = new Set<string>();

  function walk(dir: string, pluginPrefix?: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(fullPath);
          if (seenRealPaths.has(real)) continue;
          seenRealPaths.add(real);
          isDir = fs.statSync(real).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        const parentName = path.basename(dir);
        const grandParentName = path.basename(path.dirname(dir));
        const nextPrefix =
          source === "plugin" && !pluginPrefix && grandParentName === "cache"
            ? entry.name
            : pluginPrefix;
        // If we are inside cache/<marketplace>/<plugin>, only scan the newest version directory
        if (source === "plugin" && pluginPrefix && grandParentName !== "cache" && path.basename(path.dirname(path.dirname(dir))) === "cache") {
          try {
            const siblings = fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => ({
                name: d.name,
                mtime: fs.statSync(path.join(dir, d.name)).mtimeMs,
              }))
              .sort((a, b) => b.mtime - a.mtime);
            if (siblings.length > 1 && siblings[0].name !== entry.name) {
              continue;
            }
          } catch {
            // Fall through
          }
        }
        void parentName;
        walk(fullPath, nextPrefix);
      } else if (
        entry.name === "SKILL.md" ||
        (entry.name.endsWith(".md") && path.basename(dir) === "commands")
      ) {
        try {
          const raw = fs.readFileSync(fullPath, "utf8");
          const parsed = parseFrontmatterDescription(raw);
          const baseName =
            parsed.name ||
            (entry.name === "SKILL.md"
              ? path.basename(dir)
              : path.basename(entry.name, ".md"));
          const ns =
            source === "plugin"
              ? pluginPrefix || (baseName.includes(":") ? baseName.split(":")[0] : "plugin")
              : baseName.includes(":")
                ? baseName.split(":")[0]
                : "user";
          const fullName =
            source === "plugin" && pluginPrefix && !baseName.includes(":")
              ? `${pluginPrefix}:${baseName}`
              : baseName;
          const cappedDesc = parsed.description.slice(0, 1536);
          const listingLine = `- ${fullName}: ${cappedDesc}`;
          out.push({
            name: fullName,
            namespace: ns,
            source,
            filePath: fullPath,
            description: cappedDesc,
            listingChars: listingLine.length,
            fullBodyChars: raw.length,
          });
        } catch {
          // Ignore unreadable skill files
        }
      }
    }
  }

  walk(rootDir);
  return out;
}

const KNOWN_MCP_TOOL_ESTIMATES: Record<string, { tools: number; tokens: number }> = {
  atlassian: { tools: 14, tokens: 16800 },
  figma: { tools: 27, tokens: 19400 },
  "plugin:figma:figma": { tools: 27, tokens: 19400 },
  "davinci-resolve": { tools: 27, tokens: 21500 },
  slack: { tools: 21, tokens: 14200 },
  "plugin:slack:slack": { tools: 21, tokens: 14200 },
  "chrome-devtools": { tools: 26, tokens: 7800 },
  playwright: { tools: 22, tokens: 6200 },
  "mcp-server-chart": { tools: 25, tokens: 8900 },
  mongodb: { tools: 24, tokens: 6400 },
  "oh-my-claudecode": { tools: 42, tokens: 9600 },
  "plugin:oh-my-claudecode:t": { tools: 42, tokens: 9600 },
  arxiv: { tools: 15, tokens: 4800 },
  "shrimp-tasks": { tools: 14, tokens: 5400 },
  memory: { tools: 9, tokens: 2100 },
  shadcn: { tools: 9, tokens: 1900 },
  context7: { tools: 2, tokens: 1400 },
  "plugin:context7:context7": { tools: 2, tokens: 1400 },
  mintlify: { tools: 3, tokens: 1600 },
};

function discoverMcpServers(homeDir: string): {
  servers: McpServerAudit[];
  gatewayDetected: boolean;
  baseUrl?: string;
} {
  const servers = new Map<string, McpServerAudit>();
  let baseUrl = process.env.ANTHROPIC_BASE_URL;

  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
        env?: Record<string, string>;
        enabledPlugins?: Record<string, boolean>;
      };
      if (!baseUrl && settings.env?.ANTHROPIC_BASE_URL) {
        baseUrl = settings.env.ANTHROPIC_BASE_URL;
      }
      if (settings.enabledPlugins) {
        for (const [pluginKey, enabled] of Object.entries(settings.enabledPlugins)) {
          if (!enabled) continue;
          const shortName = pluginKey.split("@")[0];
          const known = KNOWN_MCP_TOOL_ESTIMATES[shortName];
          if (known && !servers.has(shortName)) {
            servers.set(shortName, {
              name: shortName,
              source: "plugin",
              estimatedTools: known.tools,
              estimatedSchemaTokens: known.tokens,
            });
          }
        }
      }
    } catch {
      // Ignore malformed settings.json
    }
  }

  const claudeJsonPath = path.join(homeDir, ".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (claudeJson.mcpServers && typeof claudeJson.mcpServers === "object") {
        for (const name of Object.keys(claudeJson.mcpServers)) {
          const known = KNOWN_MCP_TOOL_ESTIMATES[name] || { tools: 12, tokens: 3600 };
          servers.set(name, {
            name,
            source: "~/.claude.json",
            estimatedTools: known.tools,
            estimatedSchemaTokens: known.tokens,
          });
        }
      }
    } catch {
      // Ignore malformed .claude.json
    }
  }

  const gatewayDetected = Boolean(
    baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/i.test(baseUrl.trim()),
  );

  return {
    servers: [...servers.values()].sort(
      (a, b) => b.estimatedSchemaTokens - a.estimatedSchemaTokens,
    ),
    gatewayDetected,
    baseUrl,
  };
}

export function auditClaudeContext(options: {
  homeDir?: string;
  config?: DietConfig;
} = {}): ContextAuditReport {
  const homeDir = options.homeDir || os.homedir();
  const cfg = options.config || loadDietConfig();

  const userSkills = collectSkillFiles(path.join(homeDir, ".claude", "skills"), "user");
  const pluginSkills = collectSkillFiles(
    path.join(homeDir, ".claude", "plugins", "cache"),
    "plugin",
  );

  // Deduplicate by skill name
  const uniqueSkillsMap = new Map<string, SkillEntry>();
  for (const sk of [...userSkills, ...pluginSkills]) {
    if (!uniqueSkillsMap.has(sk.name)) {
      uniqueSkillsMap.set(sk.name, sk);
    }
  }
  const allSkills = [...uniqueSkillsMap.values()];

  const beforeSkillChars = allSkills.reduce((sum, s) => sum + s.listingChars + 1, 0);
  const beforeSkillTokens = estimateTokens(beforeSkillChars);

  const nsGroups = new Map<string, { count: number; chars: number }>();
  for (const sk of allSkills) {
    const cur = nsGroups.get(sk.namespace) || { count: 0, chars: 0 };
    cur.count += 1;
    cur.chars += sk.listingChars;
    nsGroups.set(sk.namespace, cur);
  }

  const pinnedSet = new Set(cfg.pinnedSkills);
  const pinnedEntries = allSkills
    .filter((s) => pinnedSet.has(s.name))
    .slice(0, cfg.maxFullSkills);
  const pinnedChars = pinnedEntries.reduce(
    (sum, s) => sum + `- ${s.name}: ${s.description.slice(0, cfg.maxCompactDescChars)}\n`.length,
    0,
  );
  const groupSummaryChars = [...nsGroups.entries()].reduce(
    (sum, [ns, info]) => sum + `- ${ns}:* (${info.count} skills, Skill({skill:"list:${ns}"}))\n`.length,
    0,
  );
  const afterSkillChars = cfg.compactSkillListing
    ? pinnedChars + groupSummaryChars + 180
    : beforeSkillChars;
  const afterSkillTokens = estimateTokens(afterSkillChars);

  const { servers, gatewayDetected, baseUrl } = discoverMcpServers(homeDir);
  const totalMcpTools = servers.reduce((sum, s) => sum + s.estimatedTools, 0);
  const beforeMcpTokens = servers.reduce((sum, s) => sum + s.estimatedSchemaTokens, 0);
  const afterMcpTokens = cfg.universalToolSearch
    ? Math.min(beforeMcpTokens, Math.max(650, servers.length * 45 + 450))
    : beforeMcpTokens;

  let claudeMdChars = 0;
  const globalClaudeMd = path.join(homeDir, ".claude", "CLAUDE.md");
  if (fs.existsSync(globalClaudeMd)) {
    try {
      claudeMdChars += fs.readFileSync(globalClaudeMd, "utf8").length;
    } catch {
      // Ignore
    }
  }

  let memoryMdChars = 0;
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (fs.existsSync(projectsDir)) {
    try {
      for (const proj of fs.readdirSync(projectsDir)) {
        const memFile = path.join(projectsDir, proj, "memory", "MEMORY.md");
        if (fs.existsSync(memFile)) {
          memoryMdChars = Math.max(memoryMdChars, fs.readFileSync(memFile, "utf8").length);
        }
      }
    } catch {
      // Ignore
    }
  }

  const claudeMdTokens = estimateTokens(claudeMdChars);
  const memoryMdTokens = estimateTokens(memoryMdChars);
  const baseSystemTokens = 14500;

  const beforeTurn1Tokens =
    baseSystemTokens + beforeMcpTokens + beforeSkillTokens + claudeMdTokens + memoryMdTokens;
  const afterTurn1Tokens =
    baseSystemTokens + afterMcpTokens + afterSkillTokens + claudeMdTokens + memoryMdTokens;
  const savedTurn1Tokens = Math.max(0, beforeTurn1Tokens - afterTurn1Tokens);
  const reductionPercent =
    beforeTurn1Tokens > 0 ? Math.round((savedTurn1Tokens / beforeTurn1Tokens) * 100) : 0;

  const beforeSubagentTokens = beforeSkillTokens + beforeMcpTokens;
  const afterSubagentTokens =
    (cfg.stripSubagentSkillListing ? 0 : afterSkillTokens) + afterMcpTokens;

  return {
    skills: {
      totalCount: allSkills.length,
      userCount: userSkills.length,
      pluginCount: allSkills.length - userSkills.length,
      beforeChars: beforeSkillChars,
      beforeTokens: beforeSkillTokens,
      afterChars: afterSkillChars,
      afterTokens: afterSkillTokens,
      savedTokens: Math.max(0, beforeSkillTokens - afterSkillTokens),
      byNamespace: [...nsGroups.entries()]
        .map(([namespace, v]) => ({
          namespace,
          count: v.count,
          beforeTokens: estimateTokens(v.chars),
        }))
        .sort((a, b) => b.beforeTokens - a.beforeTokens),
    },
    mcp: {
      serverCount: servers.length,
      estimatedToolCount: totalMcpTools,
      gatewayDetected,
      ...(baseUrl ? { baseUrl } : {}),
      beforeTokens: beforeMcpTokens,
      afterTokens: afterMcpTokens,
      savedTokens: Math.max(0, beforeMcpTokens - afterMcpTokens),
      servers,
    },
    subagentBoot: {
      beforeTokensPerSpawn: beforeSubagentTokens,
      afterTokensPerSpawn: afterSubagentTokens,
      savedTokensPerSpawn: Math.max(0, beforeSubagentTokens - afterSubagentTokens),
    },
    memoryAndRules: {
      claudeMdTokens,
      memoryMdTokens,
    },
    totals: {
      beforeTurn1Tokens,
      afterTurn1Tokens,
      savedTurn1Tokens,
      reductionPercent,
    },
  };
}
