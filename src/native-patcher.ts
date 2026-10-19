import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BackupMetadata,
  getBackupMetaPath,
  getBackupPath,
  PATCH_MARKER,
  type PatchResult,
  transformCliJsContent,
} from "./patcher.js";

interface NativeInstallationModule {
  index: number;
  name: string;
  contents: Buffer;
  isJavaScript?: boolean;
  isEntrypoint?: boolean;
}

interface ExtractedNativeBundle {
  sourceSha256: string;
  moduleStructSize: number;
  entryPointId: number;
  modules: NativeInstallationModule[];
}

interface TweakccNativeBridge {
  extractClaudeJsModulesFromNativeInstallation: (
    binPath: string,
  ) => Promise<ExtractedNativeBundle | null> | ExtractedNativeBundle | null;
  repackNativeInstallationModules: (
    srcPath: string,
    payload: { sourceSha256: string; modules: NativeInstallationModule[] },
    outPath: string,
  ) => Promise<void> | void;
}

async function loadNativeBridge(): Promise<TweakccNativeBridge> {
  try {
    const mod = (await import("tweakcc/dist/nativeInstallation.mjs" as string)) as TweakccNativeBridge;
    if (typeof mod.extractClaudeJsModulesFromNativeInstallation === "function") {
      return mod;
    }
  } catch {
    // Search npx cache for tweakcc's nativeInstallation-*.mjs
  }

  const searchDirs: string[] = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  searchDirs.push(
    path.join(localAppData, "npm-cache", "_npx"),
    path.join(os.homedir(), ".npm", "_npx"),
  );

  for (const npxRoot of searchDirs) {
    if (!fs.existsSync(npxRoot)) continue;
    for (const hashDir of fs.readdirSync(npxRoot)) {
      const distDir = path.join(npxRoot, hashDir, "node_modules", "tweakcc", "dist");
      if (!fs.existsSync(distDir)) continue;
      const match = fs
        .readdirSync(distDir)
        .find((f) => f.startsWith("nativeInstallation") && f.endsWith(".mjs"));
      if (match) {
        const modUrl = pathToFileURL(path.join(distDir, match)).href;
        const mod = (await import(modUrl)) as TweakccNativeBridge;
        if (typeof mod.extractClaudeJsModulesFromNativeInstallation === "function") {
          return mod;
        }
      }
    }
  }

  throw new Error(
    "Native binary patching requires `tweakcc` (with `node-lief`) in your npm/npx cache, or run `npx tweakcc --version` once first.",
  );
}

export function isNativeBinaryPatched(binPath: string): boolean {
  try {
    const buf = fs.readFileSync(binPath);
    return buf.includes(Buffer.from(PATCH_MARKER, "utf8"));
  } catch {
    return false;
  }
}

export async function patchNativeBinary(
  binPath: string,
  options: { dryRun?: boolean; claudeVersion?: string } = {},
): Promise<PatchResult & { stagedPath?: string; lockedRunning?: boolean }> {
  const resolvedPath = path.resolve(binPath);
  const backupPath = getBackupPath(resolvedPath);
  const metaPath = getBackupMetaPath(resolvedPath);

  if (isNativeBinaryPatched(resolvedPath)) {
    const existingMeta: Partial<BackupMetadata> = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
      : {};
    return {
      cliPath: resolvedPath,
      backupPath,
      metaPath,
      alreadyPatched: true,
      proxyGateMatches: 0,
      modelGateMatches: 0,
      wireToolsMatches: 0,
      wireMessagesMatches: 0,
      skillFormatMatches: 0,
      subagentSkillsMatches: 0,
      skillSearchMatches: 0,
      deferredDeltaMatches: 0,
      totalMatches: 0,
      versionHash: existingMeta.versionHash || "patched",
      dryRun: Boolean(options.dryRun),
      syntaxVerified: true,
    };
  }

  const bridge = await loadNativeBridge();
  const extracted = await bridge.extractClaudeJsModulesFromNativeInstallation(resolvedPath);
  if (!extracted) {
    throw new Error(`Failed to extract embedded Bun JS modules from ${resolvedPath}`);
  }

  let proxyGateMatches = 0;
  let modelGateMatches = 0;
  let wireToolsMatches = 0;
  let wireMessagesMatches = 0;
  let skillFormatMatches = 0;
  let subagentSkillsMatches = 0;
  let skillSearchMatches = 0;
  let deferredDeltaMatches = 0;
  const modified: NativeInstallationModule[] = [];

  for (const m of extracted.modules) {
    if (!m.isJavaScript) continue;
    const orig = m.contents.toString("utf8");
    const t = transformCliJsContent(orig);
    if (t.totalMatches > 0) {
      proxyGateMatches += t.proxyGateMatches;
      modelGateMatches += t.modelGateMatches;
      wireToolsMatches += t.wireToolsMatches;
      wireMessagesMatches += t.wireMessagesMatches;
      skillFormatMatches += t.skillFormatMatches;
      subagentSkillsMatches += t.subagentSkillsMatches;
      skillSearchMatches += t.skillSearchMatches;
      deferredDeltaMatches += t.deferredDeltaMatches;
      modified.push({
        ...m,
        contents: Buffer.from(t.code, "utf8"),
      });
    }
  }

  const totalMatches =
    proxyGateMatches +
    modelGateMatches +
    wireToolsMatches +
    wireMessagesMatches +
    skillFormatMatches +
    subagentSkillsMatches +
    skillSearchMatches +
    deferredDeltaMatches;

  if (totalMatches === 0) {
    throw new Error(`No matching context/skill/MCP patterns found inside native binary ${resolvedPath}`);
  }

  if (options.dryRun) {
    return {
      cliPath: resolvedPath,
      backupPath,
      metaPath,
      alreadyPatched: false,
      proxyGateMatches,
      modelGateMatches,
      wireToolsMatches,
      wireMessagesMatches,
      skillFormatMatches,
      subagentSkillsMatches,
      skillSearchMatches,
      deferredDeltaMatches,
      totalMatches,
      versionHash: extracted.sourceSha256,
      dryRun: true,
      syntaxVerified: true,
    };
  }

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(resolvedPath, backupPath);
  }
  const meta: BackupMetadata = {
    cliPath: resolvedPath,
    backupPath,
    versionHash: extracted.sourceSha256,
    patchedAt: new Date().toISOString(),
    ...(options.claudeVersion ? { claudeVersion: options.claudeVersion } : {}),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  const stagedPath = `${resolvedPath}.cc-diet-patched`;
  fs.copyFileSync(resolvedPath, stagedPath);
  await bridge.repackNativeInstallationModules(
    stagedPath,
    { sourceSha256: extracted.sourceSha256, modules: modified },
    stagedPath,
  );

  let lockedRunning = false;
  try {
    const oldExe = `${resolvedPath}.cc-diet-old`;
    if (fs.existsSync(oldExe)) {
      try {
        fs.unlinkSync(oldExe);
      } catch {
        // Still in use by previous process
      }
    }
    try {
      fs.copyFileSync(stagedPath, resolvedPath);
      fs.unlinkSync(stagedPath);
    } catch {
      fs.renameSync(resolvedPath, oldExe);
      fs.renameSync(stagedPath, resolvedPath);
      try {
        fs.unlinkSync(oldExe);
      } catch {
        // Cleaned up on next run
      }
    }
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : "";
    if (code === "EBUSY" || code === "EPERM" || code === "ETXTBSY" || code === "EACCES") {
      lockedRunning = true;
    } else {
      throw err;
    }
  }

  return {
    cliPath: resolvedPath,
    backupPath,
    metaPath,
    alreadyPatched: false,
    proxyGateMatches,
    modelGateMatches,
    wireToolsMatches,
    wireMessagesMatches,
    skillFormatMatches,
    subagentSkillsMatches,
    skillSearchMatches,
    deferredDeltaMatches,
    totalMatches,
    versionHash: extracted.sourceSha256,
    dryRun: false,
    syntaxVerified: true,
    ...(lockedRunning ? { stagedPath, lockedRunning } : {}),
  };
}
