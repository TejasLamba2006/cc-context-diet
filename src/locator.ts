import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export interface LocatedCli {
  cliPath: string;
  source:
    | "custom"
    | "claude-local"
    | "config-claude-local"
    | "require-resolve"
    | "npm-global"
    | "which-symlink"
    | "tweakcc-extracted";
  isNativeBinary: boolean;
  nativeBinaryPath?: string;
  version?: string;
}

export interface LocateOptions {
  cliPath?: string;
  cwd?: string;
}

export function isBinaryFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    if (bytesRead === 0) return false;
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
    const magic32 = buf.readUInt32BE(0);
    if (
      magic32 === 0xfeedface ||
      magic32 === 0xfeedfacf ||
      magic32 === 0xcefaedfe ||
      magic32 === 0xcffaedfe ||
      magic32 === 0xcafebabe
    ) {
      return true;
    }
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function extractClaudeVersion(filePath: string): string | undefined {
  try {
    if (isBinaryFile(filePath)) {
      const out = execFileSync(filePath, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m?.[1];
    }
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    const m = head.match(/\/\/\s*Version:\s*([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/i);
    if (m) return m[1];
  } catch {
    // Ignore version read failures
  }
  return undefined;
}

function resolveWhichClaude(): string | undefined {
  const bin = process.platform === "win32" ? "where.exe" : "which";
  try {
    const out = execFileSync(bin, ["claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const candidate of out) {
      if (fs.existsSync(candidate)) {
        try {
          return fs.realpathSync(candidate);
        } catch {
          return candidate;
        }
      }
    }
  } catch {
    // Not in PATH
  }
  const fallbackBin = path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  if (fs.existsSync(fallbackBin)) {
    try {
      return fs.realpathSync(fallbackBin);
    } catch {
      return fallbackBin;
    }
  }
  return undefined;
}

export function locateCliJs(options: LocateOptions = {}): LocatedCli {
  const home = os.homedir();
  const explicitPath = options.cliPath || process.env.CC_CLI_PATH;
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Custom cli.js path does not exist: ${resolved}`);
    }
    const isBin = isBinaryFile(resolved);
    const version = extractClaudeVersion(resolved);
    return {
      cliPath: resolved,
      source: "custom",
      isNativeBinary: isBin,
      ...(isBin ? { nativeBinaryPath: resolved } : {}),
      version,
    };
  }

  const localClaudePath = path.join(
    home,
    ".claude",
    "local",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "cli.js",
  );
  if (fs.existsSync(localClaudePath) && !isBinaryFile(localClaudePath)) {
    return {
      cliPath: localClaudePath,
      source: "claude-local",
      isNativeBinary: false,
      version: extractClaudeVersion(localClaudePath),
    };
  }

  const configClaudePath = path.join(
    home,
    ".config",
    "claude",
    "local",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "cli.js",
  );
  if (fs.existsSync(configClaudePath) && !isBinaryFile(configClaudePath)) {
    return {
      cliPath: configClaudePath,
      source: "config-claude-local",
      isNativeBinary: false,
      version: extractClaudeVersion(configClaudePath),
    };
  }

  try {
    const req = createRequire(path.join(options.cwd || process.cwd(), "package.json"));
    const resolved = req.resolve("@anthropic-ai/claude-code/cli.js");
    if (fs.existsSync(resolved) && !isBinaryFile(resolved)) {
      return {
        cliPath: resolved,
        source: "require-resolve",
        isNativeBinary: false,
        version: extractClaudeVersion(resolved),
      };
    }
  } catch {
    // Not resolvable from cwd
  }

  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmRoot = execFileSync(npmCmd, ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (npmRoot) {
      const globalCli = path.join(npmRoot, "@anthropic-ai", "claude-code", "cli.js");
      if (fs.existsSync(globalCli) && !isBinaryFile(globalCli)) {
        return {
          cliPath: globalCli,
          source: "npm-global",
          isNativeBinary: false,
          version: extractClaudeVersion(globalCli),
        };
      }
    }
  } catch {
    // Ignore npm root errors
  }

  const whichResolved = resolveWhichClaude();
  if (whichResolved) {
    if (!isBinaryFile(whichResolved) && whichResolved.endsWith(".js")) {
      return {
        cliPath: whichResolved,
        source: "which-symlink",
        isNativeBinary: false,
        version: extractClaudeVersion(whichResolved),
      };
    }
    const tweakccPatched = path.join(home, ".tweakcc", "native-claudejs-patched.js");
    if (fs.existsSync(tweakccPatched) && !isBinaryFile(tweakccPatched)) {
      const ver = extractClaudeVersion(whichResolved) || extractClaudeVersion(tweakccPatched);
      return {
        cliPath: tweakccPatched,
        source: "tweakcc-extracted",
        isNativeBinary: false,
        nativeBinaryPath: whichResolved,
        version: ver,
      };
    }
    if (isBinaryFile(whichResolved)) {
      const ver = extractClaudeVersion(whichResolved);
      return {
        cliPath: whichResolved,
        source: "which-symlink",
        isNativeBinary: true,
        nativeBinaryPath: whichResolved,
        version: ver,
      };
    }
  }

  throw new Error(
    "Could not locate @anthropic-ai/claude-code/cli.js or claude binary. Pass --cli-path <path> or set CC_CLI_PATH.",
  );
}
