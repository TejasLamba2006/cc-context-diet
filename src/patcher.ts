import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PATCH_MARKER = "/* __CC_DIET_PATCH_V1__ */";

export interface BackupMetadata {
  cliPath: string;
  backupPath: string;
  versionHash: string;
  patchedAt: string;
  claudeVersion?: string;
}

export interface TransformResult {
  code: string;
  alreadyPatched: boolean;
  proxyGateMatches: number;
  modelGateMatches: number;
  wireToolsMatches: number;
  wireMessagesMatches: number;
  skillFormatMatches: number;
  subagentSkillsMatches: number;
  skillSearchMatches: number;
  deferredDeltaMatches: number;
  totalMatches: number;
}

export interface PatchResult extends Omit<TransformResult, "code"> {
  code?: string;
  cliPath: string;
  backupPath: string;
  metaPath: string;
  versionHash: string;
  dryRun: boolean;
  syntaxVerified: boolean;
}

export function getBackupPath(cliPath: string): string {
  return `${path.resolve(cliPath)}.cc-diet-backup`;
}

export function getBackupMetaPath(cliPath: string): string {
  return `${path.resolve(cliPath)}.cc-diet-backup.meta.json`;
}

export function computeFileHash(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export function buildInjectedRuntimeCode(): string {
  return `${PATCH_MARKER}
;(function(){
  if (globalThis.__ccDietRuntimeInitialized) return;
  globalThis.__ccDietRuntimeInitialized = true;
  var _req = typeof process !== "undefined" && typeof process.getBuiltinModule === "function"
    ? function(m) { return process.getBuiltinModule(m.replace(/^node:/, "")); }
    : typeof require === "function" ? require : null;
  var _fs = _req ? _req("node:fs") : null;
  var _path = _req ? _req("node:path") : null;
  var _os = _req ? _req("node:os") : null;

  var _cachedCfg = null;
  var _cachedMtime = -1;
  var _defaultPinned = [
    "task-observer",
    "karpathy-guidelines",
    "using-superpowers",
    "superpowers:using-superpowers",
    "pstack:poteto-mode",
    "poteto-mode"
  ];

  function _loadCfg() {
    var def = {
      enabled: true,
      universalToolSearch: true,
      compactSkillListing: true,
      stripSubagentSkillListing: true,
      compactDeferredToolsDelta: true,
      maxFullSkills: 10,
      maxCompactDescChars: 140,
      pinnedSkills: _defaultPinned
    };
    if (!_fs || !_path || !_os) return def;
    try {
      var p = (typeof process !== "undefined" && process.env && process.env.CC_DIET_CONFIG)
        ? _path.resolve(process.env.CC_DIET_CONFIG)
        : _path.join(_os.homedir(), ".claude", "cc-diet.json");
      if (!_fs.existsSync(p)) return def;
      var st = _fs.statSync(p);
      if (_cachedCfg && st.mtimeMs === _cachedMtime) return _cachedCfg;
      var raw = JSON.parse(_fs.readFileSync(p, "utf8"));
      _cachedCfg = {
        enabled: raw.enabled !== false,
        universalToolSearch: raw.universalToolSearch !== false,
        compactSkillListing: raw.compactSkillListing !== false,
        stripSubagentSkillListing: raw.stripSubagentSkillListing !== false,
        compactDeferredToolsDelta: raw.compactDeferredToolsDelta !== false,
        maxFullSkills: typeof raw.maxFullSkills === "number" ? raw.maxFullSkills : 10,
        maxCompactDescChars: typeof raw.maxCompactDescChars === "number" ? raw.maxCompactDescChars : 140,
        pinnedSkills: Array.isArray(raw.pinnedSkills) ? raw.pinnedSkills : _defaultPinned
      };
      _cachedMtime = st.mtimeMs;
      return _cachedCfg;
    } catch (_e) {
      return def;
    }
  }

  globalThis.__ccDietIsUniversalToolSearch = function() {
    var cfg = _loadCfg();
    return Boolean(cfg.enabled && cfg.universalToolSearch);
  };

  globalThis.__ccDietSanitizeTools = function(tools, _model) {
    var cfg = _loadCfg();
    if (!cfg.enabled || !cfg.universalToolSearch || !Array.isArray(tools)) return tools;
    var out = [];
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      if (!t || typeof t !== "object") {
        out.push(t);
        continue;
      }
      if (t.name === "DeferredToolPlaceholder") continue;
      if ("defer_loading" in t) {
        var copy = Object.assign({}, t);
        delete copy.defer_loading;
        out.push(copy);
      } else {
        out.push(t);
      }
    }
    return out;
  };

  globalThis.__ccDietSanitizeWireMessages = function(messages, opts) {
    var cfg = _loadCfg();
    if (!cfg.enabled || !cfg.universalToolSearch || !Array.isArray(messages)) return messages;
    var toolMap = new Map();
    if (opts && Array.isArray(opts.tools)) {
      for (var i = 0; i < opts.tools.length; i++) {
        var tl = opts.tools[i];
        if (tl && tl.name) toolMap.set(tl.name, tl);
      }
    }
    return messages.map(function(msg) {
      if (!msg || msg.type !== "user" || !msg.message || !Array.isArray(msg.message.content)) return msg;
      var hasRef = msg.message.content.some(function(b) {
        return b && b.type === "tool_result" && Array.isArray(b.content) && b.content.some(function(c) {
          return c && c.type === "tool_reference";
        });
      });
      if (!hasRef) return msg;
      return Object.assign({}, msg, {
        message: Object.assign({}, msg.message, {
          content: msg.message.content.map(function(b) {
            if (!b || b.type !== "tool_result" || !Array.isArray(b.content)) return b;
            var refs = [];
            var rest = [];
            for (var j = 0; j < b.content.length; j++) {
              var item = b.content[j];
              if (item && item.type === "tool_reference" && typeof item.tool_name === "string") {
                refs.push(item.tool_name);
              } else {
                rest.push(item);
              }
            }
            if (refs.length === 0) return b;
            var lines = refs.map(function(rName) {
              var found = toolMap.get(rName);
              var desc = found && typeof found.description === "string"
                ? ": " + found.description.replace(/\\s+/g, " ").slice(0, 200)
                : "";
              return "- " + rName + desc + " (full schema now active in your tools list; call it directly)";
            });
            rest.push({
              type: "text",
              text: "Loaded deferred tool schemas:\\n" + lines.join("\\n")
            });
            return Object.assign({}, b, { content: rest });
          })
        })
      });
    });
  };

  function _skillDesc(cmd, maxChars) {
    var raw = "";
    if (cmd && typeof cmd.description === "string") raw = cmd.description;
    if (cmd && typeof cmd.whenToUse === "string" && cmd.whenToUse) {
      raw = raw ? raw + " - " + cmd.whenToUse : cmd.whenToUse;
    }
    raw = raw.replace(/\\s+/g, " ").trim();
    if (raw.length > maxChars) return raw.slice(0, maxChars - 1) + "…";
    return raw;
  }

  globalThis.__ccDietFormatSkillListing = function(skills, scoreFn) {
    var cfg = _loadCfg();
    if (!cfg.enabled || !cfg.compactSkillListing || !Array.isArray(skills) || skills.length <= 20) {
      return null;
    }
    var pinnedSet = new Set(cfg.pinnedSkills || []);
    var fullSkills = [];
    var remaining = [];
    for (var i = 0; i < skills.length; i++) {
      var s = skills[i];
      if (!s || typeof s.name !== "string") continue;
      var shortName = s.name.includes(":") ? s.name.split(":").pop() : s.name;
      if (pinnedSet.has(s.name) || (shortName && pinnedSet.has(shortName)) || (s.type === "prompt" && s.source === "bundled")) {
        fullSkills.push(s);
      } else {
        remaining.push(s);
      }
    }
    if (typeof scoreFn === "function" && fullSkills.length < cfg.maxFullSkills) {
      remaining.sort(function(a, b) {
        try { return (scoreFn(b) || 0) - (scoreFn(a) || 0); } catch (_e) { return 0; }
      });
      while (fullSkills.length < cfg.maxFullSkills && remaining.length > 0) {
        var top = remaining[0];
        var sc = 0;
        try { sc = scoreFn(top) || 0; } catch (_e) { sc = 0; }
        if (sc <= 0) break;
        fullSkills.push(remaining.shift());
      }
    }
    var lines = [];
    for (var j = 0; j < fullSkills.length; j++) {
      var fsItem = fullSkills[j];
      lines.push("- " + fsItem.name + ": " + _skillDesc(fsItem, cfg.maxCompactDescChars));
    }
    var groups = new Map();
    for (var k = 0; k < remaining.length; k++) {
      var rem = remaining[k];
      var ns = rem.name.includes(":") ? rem.name.split(":")[0] : "general";
      if (!groups.has(ns)) groups.set(ns, []);
      groups.get(ns).push(rem.name.includes(":") ? rem.name.split(":").slice(1).join(":") : rem.name);
    }
    if (groups.size > 0) {
      lines.push("");
      lines.push("Compact skill namespaces (" + remaining.length + " skills compressed by cc-diet. Call Skill({skill:\\"search:<keyword>\\"}) or Skill({skill:\\"list:<namespace>\\"}) to view descriptions, or invoke any skill directly by name):");
      var sortedNs = Array.from(groups.keys()).sort();
      for (var n = 0; n < sortedNs.length; n++) {
        var key = sortedNs[n];
        var list = groups.get(key);
        var preview = list.slice(0, 6).join(", ") + (list.length > 6 ? ", +" + (list.length - 6) + " more" : "");
        lines.push("- " + key + ":* (" + list.length + ") [" + preview + "]");
      }
    }
    return lines.join("\\n");
  };

  globalThis.__ccDietSkipSubagentSkills = function(ctx) {
    var cfg = _loadCfg();
    if (!cfg.enabled || !cfg.stripSubagentSkillListing) return false;
    return Boolean(ctx && ctx.agentId !== undefined);
  };

  globalThis.__ccDietSkillSearch = function(skillName, argsStr, allSkills) {
    var cfg = _loadCfg();
    if (!cfg.enabled || !Array.isArray(allSkills)) return null;
    var raw = String(skillName || "").trim().replace(/^\\//, "");
    var arg = String(argsStr || "").trim();
    var mode = null;
    var query = "";
    if (/^(search|find|query)$/i.test(raw)) {
      mode = "search";
      query = arg;
    } else if (/^(search|find|query):/i.test(raw)) {
      mode = "search";
      query = raw.replace(/^(search|find|query):/i, "").trim() || arg;
    } else if (/^(list|ls)$/i.test(raw)) {
      mode = "list";
      query = arg;
    } else if (/^(list|ls):/i.test(raw)) {
      mode = "list";
      query = raw.replace(/^(list|ls):/i, "").trim() || arg;
    }
    if (!mode) return null;

    var qLower = query.toLowerCase();
    var terms = qLower.split(/\\s+/).filter(Boolean);
    var matches = [];
    for (var i = 0; i < allSkills.length; i++) {
      var s = allSkills[i];
      if (!s || typeof s.name !== "string") continue;
      var desc = _skillDesc(s, 320);
      var hay = (s.name + " " + desc).toLowerCase();
      if (mode === "list") {
        if (!qLower || s.name.toLowerCase().startsWith(qLower + ":") || (qLower === "general" && !s.name.includes(":")) || hay.includes(qLower)) {
          matches.push("- " + s.name + ": " + desc);
        }
      } else {
        var score = 0;
        for (var t = 0; t < terms.length; t++) {
          if (s.name.toLowerCase().includes(terms[t])) score += 3;
          else if (hay.includes(terms[t])) score += 1;
        }
        if (terms.length === 0 || score > 0) {
          matches.push({ score: score, line: "- " + s.name + ": " + desc });
        }
      }
    }
    if (mode === "search") {
      matches.sort(function(a, b) { return b.score - a.score; });
      matches = matches.slice(0, 20).map(function(m) { return m.line; });
    } else {
      matches = matches.slice(0, 40);
    }
    var body = matches.length > 0
      ? "[cc-diet SkillSearch] Found " + matches.length + " matching skill(s) for " + JSON.stringify(query || "*") + ":\\n" + matches.join("\\n") + "\\n\\nTo invoke one, call Skill({ skill: \\"<exact-name>\\" })."
      : "[cc-diet SkillSearch] No skills matched " + JSON.stringify(query) + ". Try Skill({ skill: \\"list\\" }) to browse all namespaces.";
    return { result: false, message: body, errorCode: 2 };
  };

  globalThis.__ccDietCompactDeferredDelta = function(event) {
    var cfg = _loadCfg();
    if (!cfg.enabled || !cfg.compactDeferredToolsDelta || !event || !Array.isArray(event.addedLines)) {
      return event;
    }
    if (event.addedLines.length <= 25) return event;
    var byServer = new Map();
    for (var i = 0; i < event.addedLines.length; i++) {
      var line = String(event.addedLines[i] || "").trim();
      if (line.startsWith("mcp__")) {
        var parts = line.split("__");
        var srv = parts.length >= 2 ? "mcp__" + parts[1] + "__*" : line;
        var toolShort = parts.length >= 3 ? parts.slice(2).join("__") : line;
        if (!byServer.has(srv)) byServer.set(srv, []);
        byServer.get(srv).push(toolShort);
      } else {
        if (!byServer.has("builtin")) byServer.set("builtin", []);
        byServer.get("builtin").push(line);
      }
    }
    var compactLines = [];
    byServer.forEach(function(tools, srv) {
      var sample = tools.slice(0, 4).join(", ") + (tools.length > 4 ? ", +" + (tools.length - 4) + " more" : "");
      compactLines.push(srv + " (" + tools.length + " tools: " + sample + ")");
    });
    return Object.assign({}, event, { addedLines: compactLines });
  };
})();
`;
}

// 1. Proxy gate in l2() / ty()
const PROXY_GATE_RE =
  /if\(!([A-Za-z0-9_$]+)\.ENABLE_TOOL_SEARCH&&!([A-Za-z0-9_$]+)\(\)&&([A-Za-z0-9_$]+)\(\)==="firstParty"&&!([A-Za-z0-9_$]+)\(\)\)/g;

// 2. Model unsupported check NHe() / JQ()
const MODEL_UNSUPPORTED_RE =
  /function ([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{let ([A-Za-z0-9_$]+)=\2\.toLowerCase\(\),([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)\(\);for\(let ([A-Za-z0-9_$]+) of \4\)if\(\3\.includes\(\6\.toLowerCase\(\)\)\)return!1;return!0\}/g;

// 3. Wire tools sanitizer POd() / H$o()
const WIRE_TOOLS_RE =
  /function ([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\)\{if\(([A-Za-z0-9_$]+)\(\)!=="foundry"\)return \2;/g;

// 4. Wire messages normalizer QLS() / Pqt()
const WIRE_MESSAGES_RE =
  /if\(!([A-Za-z0-9_$]+)\.useToolSearch\)([A-Za-z0-9_$]+)=\2\.map\(\(([A-Za-z0-9_$]+)\)=>\{switch\(\3\.type\)\{case"user":return ([A-Za-z0-9_$]+)\(\3\);case"assistant":return ([A-Za-z0-9_$]+)\(\3\);default:return \3\}\}\);/g;

// 5. Skill listing formatter lGp() / Nen()
const SKILL_FORMAT_RE =
  /function ([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+),([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\)\{if\(\2\.length===0\)return"";let ([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)\(\4,\5\)/g;

// 6. Subagent skill listing skip in Nli() / S3n()
const SUBAGENT_SKILLS_RE =
  /let\{newSkills:([A-Za-z0-9_$]+),isInitial:([A-Za-z0-9_$]+)\}=([A-Za-z0-9_$]+);([A-Za-z0-9_$]+)\(`Sending \$\{\1\.length\} skills via attachment/g;

// 7. Skill tool validateInput + if(!found) SkillSearch hook
const SKILL_VALIDATE_SIG_RE =
  /(searchHint:"invoke a slash-command skill"[\s\S]{1,800}?async validateInput\()\{skill:([A-Za-z0-9_$]+)\}(,([A-Za-z0-9_$]+))?\)\{/g;

const SKILL_NOT_FOUND_RE =
  /if\(!([A-Za-z0-9_$]+)\)\{let ([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)(?:\.options)?\.spawnedBySkill\);/g;

// 8. deferred_tools_delta compaction
const DEFERRED_DELTA_RE = /case"deferred_tools_delta":\{/g;

export function transformCliJsContent(source: string): TransformResult {
  if (source.includes(PATCH_MARKER)) {
    return {
      code: source,
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
    };
  }

  let proxyGateMatches = 0;
  let modelGateMatches = 0;
  let wireToolsMatches = 0;
  let wireMessagesMatches = 0;
  let skillFormatMatches = 0;
  let subagentSkillsMatches = 0;
  let skillSearchMatches = 0;
  let deferredDeltaMatches = 0;

  let transformed = source.replace(PROXY_GATE_RE, (_m, envObj, fn1, fn2, fn3) => {
    proxyGateMatches += 1;
    return `if(!(globalThis.__ccDietIsUniversalToolSearch&&globalThis.__ccDietIsUniversalToolSearch())&&!${envObj}.ENABLE_TOOL_SEARCH&&!${fn1}()&&${fn2}()==="firstParty"&&!${fn3}())`;
  });

  transformed = transformed.replace(
    MODEL_UNSUPPORTED_RE,
    (_m, fnName, arg, lowVar, listVar, listFn, itemVar) => {
      modelGateMatches += 1;
      return `function ${fnName}(${arg}){if(globalThis.__ccDietIsUniversalToolSearch&&globalThis.__ccDietIsUniversalToolSearch())return!0;let ${lowVar}=${arg}.toLowerCase(),${listVar}=${listFn}();for(let ${itemVar} of ${listVar})if(${lowVar}.includes(${itemVar}.toLowerCase()))return!1;return!0}`;
    },
  );

  transformed = transformed.replace(WIRE_TOOLS_RE, (_m, fnName, toolsVar, modelVar, provFn) => {
    wireToolsMatches += 1;
    return `function ${fnName}(${toolsVar},${modelVar}){if(globalThis.__ccDietSanitizeTools)${toolsVar}=globalThis.__ccDietSanitizeTools(${toolsVar},${modelVar});if(${provFn}()!=="foundry")return ${toolsVar};`;
  });

  transformed = transformed.replace(
    WIRE_MESSAGES_RE,
    (_m, optsVar, msgsVar, itemVar, userFn, asstFn) => {
      wireMessagesMatches += 1;
      return `if(!${optsVar}.useToolSearch)${msgsVar}=${msgsVar}.map((${itemVar})=>{switch(${itemVar}.type){case"user":return ${userFn}(${itemVar});case"assistant":return ${asstFn}(${itemVar});default:return ${itemVar}}});else if(globalThis.__ccDietSanitizeWireMessages)${msgsVar}=globalThis.__ccDietSanitizeWireMessages(${msgsVar},${optsVar});`;
    },
  );

  transformed = transformed.replace(
    SKILL_FORMAT_RE,
    (_m, fnName, skillsVar, scoreFn, arg3, arg4, budgetVar, budgetFn) => {
      skillFormatMatches += 1;
      return `function ${fnName}(${skillsVar},${scoreFn},${arg3},${arg4}){if(${skillsVar}.length===0)return"";if(globalThis.__ccDietFormatSkillListing){let _ccOut=globalThis.__ccDietFormatSkillListing(${skillsVar},${scoreFn});if(typeof _ccOut==="string")return _ccOut}let ${budgetVar}=${budgetFn}(${arg3},${arg4})`;
    },
  );

  transformed = transformed.replace(
    SUBAGENT_SKILLS_RE,
    (_m, newSkillsVar, isInitVar, resVar, logFn) => {
      subagentSkillsMatches += 1;
      return `if(globalThis.__ccDietSkipSubagentSkills&&globalThis.__ccDietSkipSubagentSkills(e))return[];let{newSkills:${newSkillsVar},isInitial:${isInitVar}}=${resVar};${logFn}(\`Sending \${${newSkillsVar}.length} skills via attachment`;
    },
  );

  transformed = transformed.replace(
    SKILL_VALIDATE_SIG_RE,
    (_m, prefix, skillVar, secondParamFull, _secondParamName) => {
      return `${prefix}{skill:${skillVar},args:_ccSkillArgs}${secondParamFull || ""}){\n`;
    },
  );

  transformed = transformed.replace(
    SKILL_NOT_FOUND_RE,
    (fullMatch, cmdVar, _v2, _v3, skillsArrVar, skillNameVar) => {
      skillSearchMatches += 1;
      return `if(!${cmdVar}){if(globalThis.__ccDietSkillSearch){let _ccRes=globalThis.__ccDietSkillSearch(${skillNameVar},typeof _ccSkillArgs==="string"?_ccSkillArgs:"",${skillsArrVar});if(_ccRes)return _ccRes}${fullMatch.slice(`if(!${cmdVar}){`.length)}`;
    },
  );

  transformed = transformed.replace(DEFERRED_DELTA_RE, () => {
    deferredDeltaMatches += 1;
    return `case"deferred_tools_delta":{if(globalThis.__ccDietCompactDeferredDelta)e=globalThis.__ccDietCompactDeferredDelta(e);`;
  });

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
    return {
      code: source,
      alreadyPatched: false,
      proxyGateMatches: 0,
      modelGateMatches: 0,
      wireToolsMatches: 0,
      wireMessagesMatches: 0,
      skillFormatMatches: 0,
      subagentSkillsMatches: 0,
      skillSearchMatches: 0,
      deferredDeltaMatches: 0,
      totalMatches: 0,
    };
  }

  const runtimeCode = buildInjectedRuntimeCode();
  let finalCode: string;
  if (transformed.startsWith("#!")) {
    const firstNewline = transformed.indexOf("\n");
    if (firstNewline !== -1) {
      finalCode =
        transformed.slice(0, firstNewline + 1) +
        runtimeCode +
        transformed.slice(firstNewline + 1);
    } else {
      finalCode = `${transformed}\n${runtimeCode}`;
    }
  } else {
    finalCode = `${runtimeCode}${transformed}`;
  }

  return {
    code: finalCode,
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
  };
}

export function verifyJavaScriptSyntax(filePath: string): boolean {
  execFileSync(process.execPath, ["--check", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  });
  return true;
}

export function isCliJsPatched(cliPath: string): boolean {
  if (!fs.existsSync(cliPath)) return false;
  const content = fs.readFileSync(cliPath, "utf8");
  return content.includes(PATCH_MARKER);
}

export function patchCliJs(
  cliPath: string,
  options: { dryRun?: boolean; claudeVersion?: string } = {},
): PatchResult {
  const resolvedPath = path.resolve(cliPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target cli.js not found: ${resolvedPath}`);
  }

  const backupPath = getBackupPath(resolvedPath);
  const metaPath = getBackupMetaPath(resolvedPath);
  const originalContent = fs.readFileSync(resolvedPath, "utf8");

  if (originalContent.includes(PATCH_MARKER)) {
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
      versionHash: existingMeta.versionHash || computeFileHash(resolvedPath),
      dryRun: Boolean(options.dryRun),
      syntaxVerified: true,
    };
  }

  const versionHash = computeFileHash(resolvedPath);
  const transformed = transformCliJsContent(originalContent);

  if (transformed.totalMatches === 0) {
    throw new Error(`No matching Claude Code context/skill/MCP patterns found in ${resolvedPath}`);
  }

  if (options.dryRun) {
    return {
      ...transformed,
      cliPath: resolvedPath,
      backupPath,
      metaPath,
      versionHash,
      dryRun: true,
      syntaxVerified: true,
    };
  }

  fs.copyFileSync(resolvedPath, backupPath);
  const meta: BackupMetadata = {
    cliPath: resolvedPath,
    backupPath,
    versionHash,
    patchedAt: new Date().toISOString(),
    ...(options.claudeVersion ? { claudeVersion: options.claudeVersion } : {}),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  const tempPath = `${resolvedPath}.cc-diet-tmp-${process.pid}.js`;
  try {
    fs.writeFileSync(tempPath, transformed.code, "utf8");
    verifyJavaScriptSyntax(tempPath);
    fs.renameSync(tempPath, resolvedPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup error
      }
    }
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, resolvedPath);
    }
    throw err;
  }

  return {
    ...transformed,
    cliPath: resolvedPath,
    backupPath,
    metaPath,
    versionHash,
    dryRun: false,
    syntaxVerified: true,
  };
}

export function unpatchCliJs(cliPath: string): {
  restored: boolean;
  cliPath: string;
  backupPath: string;
} {
  const resolvedPath = path.resolve(cliPath);
  const backupPath = getBackupPath(resolvedPath);
  const metaPath = getBackupMetaPath(resolvedPath);

  if (!fs.existsSync(backupPath)) {
    return {
      restored: false,
      cliPath: resolvedPath,
      backupPath,
    };
  }

  fs.copyFileSync(backupPath, resolvedPath);
  try {
    fs.unlinkSync(backupPath);
  } catch {
    // Keep backup if unlink fails
  }
  if (fs.existsSync(metaPath)) {
    try {
      fs.unlinkSync(metaPath);
    } catch {
      // Ignore
    }
  }

  return {
    restored: true,
    cliPath: resolvedPath,
    backupPath,
  };
}

const CLAUDE_MD_SECTION_START = "# Context diet (cc-diet patch)";

export function syncClaudeMdInstructions(customClaudeMdPath?: string): string {
  const claudeMdPath =
    customClaudeMdPath || path.join(os.homedir(), ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });

  const block = `${CLAUDE_MD_SECTION_START}

claude.exe is patched by \`cc-diet\`:
- **SkillSearch**: Only pinned & high-frequency skills show full descriptions at boot; remaining skills are grouped by namespace. Call \`Skill({ skill: "search:<keyword>" })\` or \`Skill({ skill: "list:<namespace>" })\` to inspect matching skill descriptions on demand, or invoke any known skill directly via \`Skill({ skill: "<name>" })\`.
- **Universal ToolSearch**: Deferred MCP tools are summarized by server prefix at boot. Call \`ToolSearch({ query: "<keyword>" })\` or \`ToolSearch({ query: "select:<tool_name>" })\` to load full MCP schemas on demand across any model or gateway.
`;

  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, block, "utf8");
    return claudeMdPath;
  }

  const existing = fs.readFileSync(claudeMdPath, "utf8");
  if (existing.includes(CLAUDE_MD_SECTION_START)) {
    const idx = existing.indexOf(CLAUDE_MD_SECTION_START);
    const nextHeader = existing.indexOf("\n# ", idx + CLAUDE_MD_SECTION_START.length);
    const updated =
      nextHeader !== -1
        ? existing.slice(0, idx) + block + "\n" + existing.slice(nextHeader + 1)
        : existing.slice(0, idx) + block;
    fs.writeFileSync(claudeMdPath, updated, "utf8");
    return claudeMdPath;
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(claudeMdPath, existing + sep + block, "utf8");
  return claudeMdPath;
}
