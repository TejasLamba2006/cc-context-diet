#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { auditClaudeContext } from "./auditor.js";
import {
  DEFAULT_DIET_CONFIG,
  getDietConfigPath,
  loadDietConfig,
  pinSkill,
  saveDietConfig,
  unpinSkill,
} from "./config.js";
import { locateCliJs } from "./locator.js";
import { isNativeBinaryPatched, patchNativeBinary } from "./native-patcher.js";
import {
  isCliJsPatched,
  patchCliJs,
  syncClaudeMdInstructions,
  unpatchCliJs,
} from "./patcher.js";

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function renderAuditReport(report: ReturnType<typeof auditClaudeContext>): void {
  console.log(pc.bold(pc.cyan("\n=== cc-diet Context Bloat Audit ===\n")));
  if (report.mcp.gatewayDetected) {
    console.log(
      pc.yellow(
        `! Custom gateway detected (${report.mcp.baseUrl}): Claude Code disables ToolSearch by default on non-first-party hosts, dumping all MCP schemas on Turn 1.`,
      ),
    );
  }

  console.log(
    [
      "",
      `${pc.bold("Category".padEnd(32))} ${pc.bold("Before".padStart(14))} ${pc.bold("After (cc-diet)".padStart(16))} ${pc.bold("Saved".padStart(14))}`,
      "-".repeat(80),
      `${`MCP Tool Schemas (${report.mcp.estimatedToolCount} tools)`.padEnd(32)} ${`${formatNum(report.mcp.beforeTokens)} tok`.padStart(14)} ${`${formatNum(report.mcp.afterTokens)} tok`.padStart(16)} ${pc.green(`-${formatNum(report.mcp.savedTokens)} tok`.padStart(14))}`,
      `${`Skill Catalog (${report.skills.totalCount} skills)`.padEnd(32)} ${`${formatNum(report.skills.beforeTokens)} tok`.padStart(14)} ${`${formatNum(report.skills.afterTokens)} tok`.padStart(16)} ${pc.green(`-${formatNum(report.skills.savedTokens)} tok`.padStart(14))}`,
      `${"CLAUDE.md + MEMORY.md".padEnd(32)} ${`${formatNum(report.memoryAndRules.claudeMdTokens + report.memoryAndRules.memoryMdTokens)} tok`.padStart(14)} ${`${formatNum(report.memoryAndRules.claudeMdTokens + report.memoryAndRules.memoryMdTokens)} tok`.padStart(16)} ${"0 tok".padStart(14)}`,
      `${"Base System Prompt + Builtins".padEnd(32)} ${"14,500 tok".padStart(14)} ${"14,500 tok".padStart(16)} ${"0 tok".padStart(14)}`,
      "-".repeat(80),
      `${pc.bold("Total Turn-1 Prefix".padEnd(32))} ${pc.red(`${formatNum(report.totals.beforeTurn1Tokens)} tok`.padStart(14))} ${pc.green(`${formatNum(report.totals.afterTurn1Tokens)} tok`.padStart(16))} ${pc.bold(pc.green(`-${formatNum(report.totals.savedTurn1Tokens)} tok (-${report.totals.reductionPercent}%)`.padStart(14)))}`,
      `${pc.bold("Per-Subagent Spawn Overhead".padEnd(32))} ${pc.red(`${formatNum(report.subagentBoot.beforeTokensPerSpawn)} tok`.padStart(14))} ${pc.green(`${formatNum(report.subagentBoot.afterTokensPerSpawn)} tok`.padStart(16))} ${pc.bold(pc.green(`-${formatNum(report.subagentBoot.savedTokensPerSpawn)} tok`.padStart(14)))}`,
      "",
    ].join("\n"),
  );

  if (report.mcp.servers.length > 0) {
    console.log(pc.bold("Top MCP Token Consumers (Deferred on Turn 1 via Universal ToolSearch):"));
    for (const srv of report.mcp.servers.slice(0, 8)) {
      console.log(
        `  - ${srv.name.padEnd(28)} ~${String(srv.estimatedTools).padStart(2)} tools  (${formatNum(srv.estimatedSchemaTokens)} tok)`,
      );
    }
    console.log("");
  }

  if (report.skills.byNamespace.length > 0) {
    console.log(pc.bold("Top Skill Namespaces (Compacted via Native SkillSearch):"));
    for (const ns of report.skills.byNamespace.slice(0, 8)) {
      console.log(
        `  - ${(ns.namespace + ":*").padEnd(28)} ${String(ns.count).padStart(3)} skills (${formatNum(ns.beforeTokens)} tok)`,
      );
    }
    console.log("");
  }
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("cc-diet")
    .description(
      "Cut Claude Code Turn-1 context bloat by 85%: native SkillSearch, compact skill catalog, subagent skill diet, and universal gateway ToolSearch patcher",
    )
    .version("1.0.0");

  program
    .command("audit")
    .description("Scan ~/.claude skills, plugins, MCP servers, and memory to calculate Turn-1 token bloat")
    .option("--json", "Output raw JSON audit report")
    .action((opts: { json?: boolean }) => {
      const report = auditClaudeContext();
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      renderAuditReport(report);
    });

  program
    .command("patch")
    .description("Patch Claude Code (cli.js and/or native claude binary) with cc-diet hooks")
    .option("--cli-path <path>", "Explicit path to cli.js or claude binary")
    .option("--dry-run", "Verify pattern matches without writing files")
    .option("--no-claude-md", "Skip syncing instructions block into ~/.claude/CLAUDE.md")
    .action(async (opts: { cliPath?: string; dryRun?: boolean; claudeMd?: boolean }) => {
      const located = locateCliJs({ cliPath: opts.cliPath });
      const cfgPath = getDietConfigPath();
      const cfg = loadDietConfig(cfgPath);
      if (!opts.dryRun) {
        saveDietConfig(cfg, cfgPath);
      }

      if (!located.isNativeBinary) {
        const res = patchCliJs(located.cliPath, {
          dryRun: opts.dryRun,
          claudeVersion: located.version,
        });
        console.log(
          res.alreadyPatched
            ? pc.green(`✓ JS bundle already patched: ${res.cliPath}`)
            : pc.green(
                `✓ ${opts.dryRun ? "[Dry Run] Matched" : "Patched"} JS bundle: ${res.cliPath} (${res.totalMatches} hooks)`,
              ),
        );
      }

      const binTarget = located.nativeBinaryPath || (located.isNativeBinary ? located.cliPath : undefined);
      if (binTarget) {
        const nativeRes = await patchNativeBinary(binTarget, {
          dryRun: opts.dryRun,
          claudeVersion: located.version,
        });
        console.log(
          nativeRes.alreadyPatched
            ? pc.green(`✓ Native binary already patched: ${nativeRes.cliPath}`)
            : pc.green(
                `✓ ${opts.dryRun ? "[Dry Run] Matched" : "Patched"} native binary: ${nativeRes.cliPath} (${nativeRes.totalMatches} hooks)`,
              ),
        );
        if (nativeRes.lockedRunning && nativeRes.stagedPath) {
          console.log(
            pc.yellow(
              `! Running claude binary was locked; staged patched binary at: ${nativeRes.stagedPath}`,
            ),
          );
        }
      }

      if (!opts.dryRun && opts.claudeMd !== false) {
        const mdPath = syncClaudeMdInstructions();
        console.log(pc.cyan(`✓ Synced cc-diet instructions to ${mdPath}`));
      }

      const report = auditClaudeContext({ config: cfg });
      console.log(
        pc.bold(
          pc.green(
            `\nEstimated Turn-1 savings: ${formatNum(report.totals.beforeTurn1Tokens)} tok -> ${formatNum(report.totals.afterTurn1Tokens)} tok (-${report.totals.reductionPercent}%)\n`,
          ),
        ),
      );
    });

  program
    .command("unpatch")
    .description("Restore Claude Code from its .cc-diet-backup file")
    .option("--cli-path <path>", "Explicit path to cli.js or claude binary")
    .action((opts: { cliPath?: string }) => {
      const located = locateCliJs({ cliPath: opts.cliPath });
      const r1 = unpatchCliJs(located.cliPath);
      console.log(
        r1.restored
          ? pc.green(`✓ Restored ${r1.cliPath} from ${r1.backupPath}`)
          : pc.yellow(`No backup found at ${r1.backupPath}`),
      );
      if (located.nativeBinaryPath && located.nativeBinaryPath !== located.cliPath) {
        const r2 = unpatchCliJs(located.nativeBinaryPath);
        console.log(
          r2.restored
            ? pc.green(`✓ Restored ${r2.cliPath} from ${r2.backupPath}`)
            : pc.yellow(`No backup found at ${r2.backupPath}`),
        );
      }
    });

  program
    .command("status")
    .description("Show current cc-diet patch status, config, and estimated token savings")
    .option("--cli-path <path>", "Explicit path to cli.js or claude binary")
    .action((opts: { cliPath?: string }) => {
      const located = locateCliJs({ cliPath: opts.cliPath });
      const jsPatched = !located.isNativeBinary && isCliJsPatched(located.cliPath);
      const binTarget =
        located.nativeBinaryPath || (located.isNativeBinary ? located.cliPath : undefined);
      const binPatched = binTarget ? isNativeBinaryPatched(binTarget) : false;
      const cfgPath = getDietConfigPath();
      const cfg = loadDietConfig(cfgPath);

      console.log(pc.bold("\ncc-diet Status"));
      console.log(`  Claude Version : ${located.version || "unknown"}`);
      if (!located.isNativeBinary) {
        console.log(
          `  JS Bundle      : ${located.cliPath} (${jsPatched ? pc.green("PATCHED") : pc.yellow("UNPATCHED")})`,
        );
      }
      if (binTarget) {
        console.log(
          `  Native Binary  : ${binTarget} (${binPatched ? pc.green("PATCHED") : pc.yellow("UNPATCHED")})`,
        );
      }
      console.log(`  Config Path    : ${cfgPath}`);
      console.log(`  Pinned Skills  : ${cfg.pinnedSkills.join(", ")}`);
      renderAuditReport(auditClaudeContext({ config: cfg }));
    });

  program
    .command("pin <skill>")
    .description("Pin a skill so its full description is always included on Turn 1")
    .action((skill: string) => {
      const cfg = pinSkill(skill);
      console.log(pc.green(`✓ Pinned skill "${skill}". Active pins: ${cfg.pinnedSkills.join(", ")}`));
    });

  program
    .command("unpin <skill>")
    .description("Remove a skill from the Turn-1 pinned list")
    .action((skill: string) => {
      const cfg = unpinSkill(skill);
      console.log(pc.green(`✓ Unpinned skill "${skill}". Active pins: ${cfg.pinnedSkills.join(", ")}`));
    });

  program
    .command("reset-config")
    .description("Reset ~/.claude/cc-diet.json to default settings")
    .action(() => {
      const p = saveDietConfig(DEFAULT_DIET_CONFIG);
      console.log(pc.green(`✓ Reset config at ${p}`));
    });

  await program.parseAsync(argv);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("cli.ts") ||
    process.argv[1].includes("cc-diet"));

if (isMain) {
  runCli().catch((err: unknown) => {
    console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}
