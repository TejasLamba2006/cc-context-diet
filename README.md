# cc-context-diet (`cc-diet`)

Cut Claude Code's Turn-1 context bloat by **80-90%** without deleting or moving a single skill, plugin, or MCP server.

## Why Turn 1 Costs 150,000+ Tokens

When you boot `@anthropic-ai/claude-code` with plugins (`superpowers`, `oh-my-claudecode`, `pstack`), user skills, and MCP servers (`atlassian`, `figma`, `slack`, `playwright`, `chrome-devtools`, `davinci-resolve`, `mongodb`) over a custom gateway (`9Router`, `LiteLLM`, `OpenRouter`, `ANTHROPIC_BASE_URL`), Claude Code hits four compounding bottlenecks:

1. **`ToolSearch` is disabled on custom gateways (`!Mf()`)**: Inside `claude.exe`, `l2()` disables dynamic MCP tool loading whenever `ANTHROPIC_BASE_URL` is not `https://api.anthropic.com`, dumping every MCP tool's full JSON schema (~70k-100k tokens) on **every turn**.
2. **Proprietary `tool_reference` & `defer_loading` wire fields fail on non-Anthropic models**: Even if you force `ENABLE_TOOL_SEARCH=true`, non-Anthropic models (`Gemini`, `GPT`, `DeepSeek`, `Qwen`, `OpenCode`) reject `defer_loading: true` on `tools[]` and `{ type: "tool_reference" }` blocks in `messages[]`.
3. **No `SkillSearch` for the skill catalog**: `Nli()` and `lGp()` materialize up to 40,000 characters (~16,000 tokens) of multi-line skill descriptions into `skill_listing` on Turn 1 ([anthropics/claude-code#43816](https://github.com/anthropics/claude-code/issues/43816), [#14882](https://github.com/anthropics/claude-code/issues/14882)).
4. **Subagents re-materialize the entire skill catalog on every spawn**: Every `Agent` tool spawn re-injects `skill_listing` ([anthropics/claude-code#60141](https://github.com/anthropics/claude-code/issues/60141)).

## What `cc-diet` Does

`cc-diet` patches both extracted JS bundles (`cli.js` / `native-claudejs-patched.js`) and Bun-compiled native `claude` binaries (`claude.exe` / `claude`) in place:

1. **Universal Client-Side `ToolSearch`**: Unlocks `ToolSearch` across all gateways and models, strips `DeferredToolPlaceholder` and `defer_loading` from the wire `tools[]` array, and converts `{ type: "tool_reference" }` blocks into human-readable text on the wire while keeping `tool_reference` in memory so discovered MCP schemas automatically hydrate on the next turn.
2. **In-Place `SkillSearch` & Compact Skill Catalog**: Keeps full 1-line descriptions for your pinned and most-used skills, compresses the remaining 250+ skills into compact namespace summaries (`superpowers:* (14)`, `oh-my-claudecode:* (37)`), and adds `Skill({ skill: "search:<keyword>" })` and `Skill({ skill: "list:<namespace>" })` directly inside the built-in `Skill` tool.
3. **Subagent Context Diet**: Skips redundant `skill_listing` injection inside spawned subagents (`e.agentId !== undefined`).
4. **Compact `deferred_tools_delta`**: Groups 200+ deferred MCP tool announcements by server prefix (`mcp__atlassian__* (14 tools)`).

## Quick Start

```bash
# 1. Audit your current Turn-1 token bloat
npx cc-context-diet audit

# 2. Apply the patch to claude / claude.exe
npx cc-context-diet patch

# 3. Check status or pin specific skills
npx cc-context-diet status
npx cc-context-diet pin superpowers:brainstorming

# 4. Restore original binary at any time
npx cc-context-diet unpatch
```

(When installed globally via `npm i -g cc-context-diet`, both `cc-context-diet` and the short alias `cc-diet` are available.)

## Coexistence with `cc-subagent-models`

`cc-diet` uses its own marker (`/* __CC_DIET_PATCH_V1__ */`) and backup suffix (`.cc-diet-backup`), coexisting cleanly alongside [`cc-subagent-models`](https://github.com/TejasLamba2006/cc-subagent-models) on the same `claude.exe` binary.

## License

MIT
