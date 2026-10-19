import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { auditClaudeContext } from "../src/auditor.js";
import { DEFAULT_DIET_CONFIG, loadDietConfig, pinSkill, saveDietConfig, unpinSkill } from "../src/config.js";
import {
  PATCH_MARKER,
  patchCliJs,
  syncClaudeMdInstructions,
  transformCliJsContent,
  unpatchCliJs,
} from "../src/patcher.js";

const SYNTHETIC_BUNDLE = `#!/usr/bin/env node
// Version: 2.1.289
function NHe(e){let t=e.toLowerCase(),r=e$_();for(let n of r)if(t.includes(n.toLowerCase()))return!1;return!0}
function l2(){let e=cCr();if(e==="standard"){if(ZE.claim("tool_search_optimistic_decision"))w("off");return!1}if(!q.ENABLE_TOOL_SEARCH&&!n2o()&&Yn()==="firstParty"&&!Mf()){if(ZE.claim("tool_search_optimistic_decision"))w("disabled proxy");return!1}return!0}
function POd(e,t){if(Yn()!=="foundry")return e;return e}
function QLS(e,t){let u=e;if(!t.useToolSearch)u=u.map((d)=>{switch(d.type){case"user":return rXa(d);case"assistant":return F7f(d);default:return d}});return u}
function lGp(e,t,r,n){if(e.length===0)return"";let o=Jtr(r,n);return e.map((x)=>"- "+x.name+": "+x.description).join("\\n")}
async function Nli(e){let l={newSkills:[{name:"a",description:"b"}],isInitial:!0};let{newSkills:c,isInitial:u}=l;w(\`Sending \${c.length} skills via attachment\`);return c}
var LWr=Ui({name:Ih,searchHint:"invoke a slash-command skill",async validateInput({skill:e},t){let o=e.trim(),s=await A8a(t),a=kA(o,s);if(!a){let c=yza(s,o,t.options.spawnedBySkill);return{result:!1,message:"Unknown skill: "+o,errorCode:2}}return{result:!0}}});
function renderAtt(e){switch(e.type){case"deferred_tools_delta":{let r=e.addedLines;return r}}}
`;

describe("cc-diet patcher & runtime hooks", () => {
  it("transforms all 8 Claude Code context bloat call sites and is idempotent", () => {
    const res = transformCliJsContent(SYNTHETIC_BUNDLE);
    expect(res.alreadyPatched).toBe(false);
    expect(res.proxyGateMatches).toBe(1);
    expect(res.modelGateMatches).toBe(1);
    expect(res.wireToolsMatches).toBe(1);
    expect(res.wireMessagesMatches).toBe(1);
    expect(res.skillFormatMatches).toBe(1);
    expect(res.subagentSkillsMatches).toBe(1);
    expect(res.skillSearchMatches).toBe(1);
    expect(res.deferredDeltaMatches).toBe(1);
    expect(res.totalMatches).toBe(8);
    expect(res.code).toContain(PATCH_MARKER);

    const second = transformCliJsContent(res.code);
    expect(second.alreadyPatched).toBe(true);
    expect(second.totalMatches).toBe(0);
    expect(second.code).toBe(res.code);
  });

  it("executes runtime hooks for SkillSearch, compact skill catalog, wire tool/message sanitization, and deferred_tools_delta compaction", () => {
    const res = transformCliJsContent(SYNTHETIC_BUNDLE);
    const sandbox: Record<string, unknown> = {
      globalThis: {},
      process,
      console,
      Map,
      Set,
      Object,
      Array,
      JSON,
      String,
      Boolean,
      Number,
      cCr: () => "tst",
      ZE: { claim: () => false },
      w: () => {},
      q: { ENABLE_TOOL_SEARCH: undefined, ANTHROPIC_BASE_URL: "http://localhost:20128" },
      n2o: () => false,
      Yn: () => "firstParty",
      Mf: () => false,
      e$_: () => ["claude-3-haiku"],
      Jtr: () => 40000,
      rXa: (d: unknown) => d,
      F7f: (d: unknown) => d,
      Ih: "Skill",
      A8a: async () => [
        { name: "task-observer", description: "Observe tasks and log skill improvements" },
        { name: "superpowers:brainstorming", description: "Brainstorm designs before coding" },
        { name: "superpowers:tdd", description: "Test driven development workflow" },
      ],
      kA: (name: string, list: Array<{ name: string }>) => list.find((x) => x.name === name),
      yza: () => [],
      Ui: (def: unknown) => def,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(res.code.replace(/^#![^\n]*\n/, ""), sandbox);

    // 1. Proxy gate unlocked
    const l2Fn = sandbox.l2 as () => boolean;
    expect(l2Fn()).toBe(true);

    // 2. Wire tools sanitizer strips DeferredToolPlaceholder and defer_loading
    const POdFn = sandbox.POd as (tools: Array<Record<string, unknown>>, model: string) => Array<Record<string, unknown>>;
    const sanitizedTools = POdFn(
      [
        { name: "Bash", input_schema: {} },
        { name: "DeferredToolPlaceholder", description: "Reserved", defer_loading: true },
        { name: "mcp__atlassian__getJiraIssue", description: "Fetch Jira issue", defer_loading: true },
      ],
      "vx/gemini-4-argon",
    );
    expect(sanitizedTools).toHaveLength(2);
    expect(sanitizedTools[1].name).toBe("mcp__atlassian__getJiraIssue");
    expect("defer_loading" in sanitizedTools[1]).toBe(false);

    // 3. Wire messages sanitizer converts tool_reference into text block
    const QLSFn = sandbox.QLS as (msgs: unknown[], opts: Record<string, unknown>) => Array<Record<string, any>>;
    const wireMsgs = QLSFn(
      [
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: [{ type: "tool_reference", tool_name: "mcp__atlassian__getJiraIssue" }],
              },
            ],
          },
        },
      ],
      {
        useToolSearch: true,
        tools: [{ name: "mcp__atlassian__getJiraIssue", description: "Get a Jira issue by key" }],
      },
    );
    const block = wireMsgs[0].message.content[0].content[0];
    expect(block.type).toBe("text");
    expect(block.text).toContain("mcp__atlassian__getJiraIssue");
    expect(block.text).toContain("Get a Jira issue by key");

    // 4. Compact skill listing (>20 skills triggers namespace grouping)
    const manySkills = [
      { name: "task-observer", description: "Observe tasks" },
      ...Array.from({ length: 25 }, (_, idx) => ({
        name: `superpowers:skill-${idx}`,
        description: `Detailed description for skill ${idx}`,
      })),
    ];
    const lGpFn = sandbox.lGp as (skills: unknown[], scoreFn: () => number, r: number, n: number) => string;
    const formatted = lGpFn(manySkills, () => 0, 200000, 4);
    expect(formatted).toContain("- task-observer: Observe tasks");
    expect(formatted).toContain("- superpowers:* (25)");

    // 5. Subagent skill listing skipped when agentId is present
    const NliFn = sandbox.Nli as (ctx: { agentId?: string }) => Promise<unknown[]>;
    expect(NliFn({ agentId: "subagent-123" })).resolves.toEqual([]);
    expect(NliFn({ agentId: undefined })).resolves.toHaveLength(1);

    // 6. Skill tool validateInput handles Skill({ skill: "search:brainstorm" })
    const LWrObj = sandbox.LWr as {
      validateInput: (
        input: { skill: string; args?: string },
        ctx: { options: { spawnedBySkill?: string } },
      ) => Promise<{ result: boolean; message?: string }>;
    };
    expect(
      LWrObj.validateInput({ skill: "search:brainstorm" }, { options: {} }),
    ).resolves.toMatchObject({
      result: false,
      message: expect.stringContaining("superpowers:brainstorming"),
    });

    // 7. deferred_tools_delta compaction when >25 tools
    const renderAttFn = sandbox.renderAtt as (ev: { type: string; addedLines: string[] }) => string[];
    const manyMcpLines = Array.from({ length: 30 }, (_, i) => `mcp__atlassian__tool_${i}`);
    const compactedLines = renderAttFn({ type: "deferred_tools_delta", addedLines: manyMcpLines });
    expect(compactedLines).toHaveLength(1);
    expect(compactedLines[0]).toContain("mcp__atlassian__* (30 tools:");
  });

  it("patches, verifies syntax, and unpatches a JS bundle on disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diet-test-"));
    const cliFile = path.join(tmpDir, "cli.js");
    fs.writeFileSync(cliFile, SYNTHETIC_BUNDLE, "utf8");

    const patchRes = patchCliJs(cliFile);
    expect(patchRes.alreadyPatched).toBe(false);
    expect(patchRes.totalMatches).toBe(8);
    expect(patchRes.syntaxVerified).toBe(true);
    expect(fs.existsSync(patchRes.backupPath)).toBe(true);

    const unpatchRes = unpatchCliJs(cliFile);
    expect(unpatchRes.restored).toBe(true);
    expect(fs.readFileSync(cliFile, "utf8")).toBe(SYNTHETIC_BUNDLE);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manages config pins, CLAUDE.md sync, and context audit", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diet-cfg-"));
    const cfgFile = path.join(tmpDir, "cc-diet.json");
    saveDietConfig(DEFAULT_DIET_CONFIG, cfgFile);
    const afterPin = pinSkill("custom:my-skill", cfgFile);
    expect(afterPin.pinnedSkills).toContain("custom:my-skill");
    const afterUnpin = unpinSkill("custom:my-skill", cfgFile);
    expect(afterUnpin.pinnedSkills).not.toContain("custom:my-skill");
    expect(loadDietConfig(cfgFile).enabled).toBe(true);

    const mdFile = path.join(tmpDir, "CLAUDE.md");
    syncClaudeMdInstructions(mdFile);
    expect(fs.readFileSync(mdFile, "utf8")).toContain("# Context diet (cc-diet patch)");

    const audit = auditClaudeContext({ homeDir: tmpDir });
    expect(audit.totals.beforeTurn1Tokens).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
