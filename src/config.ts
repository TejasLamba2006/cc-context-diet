import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DietConfig {
  enabled: boolean;
  universalToolSearch: boolean;
  compactSkillListing: boolean;
  stripSubagentSkillListing: boolean;
  compactDeferredToolsDelta: boolean;
  maxFullSkills: number;
  maxCompactDescChars: number;
  pinnedSkills: string[];
}

export const DEFAULT_DIET_CONFIG: DietConfig = {
  enabled: true,
  universalToolSearch: true,
  compactSkillListing: true,
  stripSubagentSkillListing: true,
  compactDeferredToolsDelta: true,
  maxFullSkills: 10,
  maxCompactDescChars: 140,
  pinnedSkills: [
    "task-observer",
    "karpathy-guidelines",
    "using-superpowers",
    "superpowers:using-superpowers",
    "pstack:poteto-mode",
    "poteto-mode",
  ],
};

export function getDietConfigPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  if (process.env.CC_DIET_CONFIG) return path.resolve(process.env.CC_DIET_CONFIG);
  return path.join(os.homedir(), ".claude", "cc-diet.json");
}

export function loadDietConfig(customPath?: string): DietConfig {
  const cfgPath = getDietConfigPath(customPath);
  if (!fs.existsSync(cfgPath)) {
    return { ...DEFAULT_DIET_CONFIG, pinnedSkills: [...DEFAULT_DIET_CONFIG.pinnedSkills] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Partial<DietConfig>;
    return {
      enabled: raw.enabled ?? DEFAULT_DIET_CONFIG.enabled,
      universalToolSearch: raw.universalToolSearch ?? DEFAULT_DIET_CONFIG.universalToolSearch,
      compactSkillListing: raw.compactSkillListing ?? DEFAULT_DIET_CONFIG.compactSkillListing,
      stripSubagentSkillListing:
        raw.stripSubagentSkillListing ?? DEFAULT_DIET_CONFIG.stripSubagentSkillListing,
      compactDeferredToolsDelta:
        raw.compactDeferredToolsDelta ?? DEFAULT_DIET_CONFIG.compactDeferredToolsDelta,
      maxFullSkills:
        typeof raw.maxFullSkills === "number" && raw.maxFullSkills >= 0
          ? raw.maxFullSkills
          : DEFAULT_DIET_CONFIG.maxFullSkills,
      maxCompactDescChars:
        typeof raw.maxCompactDescChars === "number" && raw.maxCompactDescChars >= 40
          ? raw.maxCompactDescChars
          : DEFAULT_DIET_CONFIG.maxCompactDescChars,
      pinnedSkills: Array.isArray(raw.pinnedSkills)
        ? [...new Set(raw.pinnedSkills.map((s) => String(s).trim()).filter(Boolean))]
        : [...DEFAULT_DIET_CONFIG.pinnedSkills],
    };
  } catch {
    return { ...DEFAULT_DIET_CONFIG, pinnedSkills: [...DEFAULT_DIET_CONFIG.pinnedSkills] };
  }
}

export function saveDietConfig(config: DietConfig, customPath?: string): string {
  const cfgPath = getDietConfigPath(customPath);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return cfgPath;
}

export function pinSkill(skillName: string, customPath?: string): DietConfig {
  const cfg = loadDietConfig(customPath);
  const trimmed = skillName.trim().replace(/^\//, "");
  if (trimmed && !cfg.pinnedSkills.includes(trimmed)) {
    cfg.pinnedSkills.push(trimmed);
    saveDietConfig(cfg, customPath);
  }
  return cfg;
}

export function unpinSkill(skillName: string, customPath?: string): DietConfig {
  const cfg = loadDietConfig(customPath);
  const trimmed = skillName.trim().replace(/^\//, "");
  cfg.pinnedSkills = cfg.pinnedSkills.filter((s) => s !== trimmed);
  saveDietConfig(cfg, customPath);
  return cfg;
}
