import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId?: string;
  updatedAt?: string | number;
  displayName?: string;
  chatType?: string;
  channel?: string;
  provider?: string;
  subject?: string;
  room?: string;
  space?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  origin?: {
    label?: string;
    provider?: string;
    from?: string;
    to?: string;
  };
}

interface SessionStore {
  [key: string]: SessionEntry;
}

interface TranscriptEntry {
  type?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
  timestamp?: string;
  id?: string;
}

type LlmProvider = "gemini" | "openai" | "openrouter";

interface PluginConfig {
  enabled?: boolean;
  // Provider selection
  provider?: LlmProvider;
  // Gemini config
  geminiModel?: string;
  geminiApiKey?: string;
  // OpenAI config
  openaiModel?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  // OpenRouter config
  openrouterModel?: string;
  openrouterApiKey?: string;
  // Shared
  maxTranscriptChars?: number;
}

interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

// ─── LLM Abstraction ─────────────────────────────────────────────────────────

function resolveKeyFromKeychain(service: string, account: string): string | null {
  try {
    return execSync(
      `security find-generic-password -s "${service}" -a "${account}" -w 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim() || null;
  } catch {
    return null;
  }
}

function resolveLlmConfig(pluginConfig: PluginConfig): LlmConfig | null {
  const provider = pluginConfig.provider || "gemini";

  if (provider === "openai") {
    const apiKey =
      pluginConfig.openaiApiKey ||
      process.env.OPENAI_API_KEY ||
      resolveKeyFromKeychain("openai", "api-key");
    if (!apiKey) return null;
    return {
      provider: "openai",
      model: pluginConfig.openaiModel || "gpt-4o",
      apiKey,
      baseUrl: pluginConfig.openaiBaseUrl || "https://api.openai.com/v1",
    };
  }

  if (provider === "openrouter") {
    const apiKey =
      pluginConfig.openrouterApiKey ||
      process.env.OPENROUTER_API_KEY ||
      resolveKeyFromKeychain("openrouter", "api-key");
    if (!apiKey) return null;
    return {
      provider: "openrouter",
      model: pluginConfig.openrouterModel || "anthropic/claude-sonnet-4",
      apiKey,
      baseUrl: "https://openrouter.ai/api/v1",
    };
  }

  // Default: Gemini
  const apiKey =
    pluginConfig.geminiApiKey ||
    process.env.GEMINI_API_KEY ||
    resolveKeyFromKeychain("gemini", "api-key");
  if (!apiKey) return null;
  return {
    provider: "gemini",
    model: pluginConfig.geminiModel || "gemini-3-pro-preview",
    apiKey,
  };
}

async function callLlm(
  config: LlmConfig,
  prompt: string,
  systemInstruction?: string,
  maxTokens: number = 8192,
): Promise<string> {
  if (config.provider === "gemini") {
    return callGemini(config.apiKey, config.model, prompt, systemInstruction, maxTokens);
  }
  // OpenAI and OpenRouter both use the OpenAI chat completions format
  return callOpenAICompat(config, prompt, systemInstruction, maxTokens);
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  systemInstruction?: string,
  maxTokens: number = 8192,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: maxTokens,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json() as any;

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  return text;
}

async function callOpenAICompat(
  config: LlmConfig,
  prompt: string,
  systemInstruction?: string,
  maxTokens: number = 8192,
): Promise<string> {
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const url = `${baseUrl}/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) {
    messages.push({ role: "system", content: systemInstruction });
  }
  messages.push({ role: "user", content: prompt });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };

  // OpenRouter-specific headers
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/clockworksquirrel/session-bridge-openclaw";
    headers["X-Title"] = "Session Bridge for OpenClaw";
  }

  const body: any = {
    model: config.model,
    messages,
    temperature: 0.3,
    max_tokens: maxTokens,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = await response.json() as any;

  if (data.error) {
    const errMsg = typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error);
    throw new Error(`${config.provider} API error: ${errMsg}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`${config.provider} returned empty response`);
  }

  return text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findSessionsDir(config: any): string {
  const stateDir =
    config.stateDir ||
    join(process.env.HOME || "/tmp", ".openclaw");
  const agentId = config.agents?.list?.[0]?.id || "main";
  return join(stateDir, "agents", agentId, "sessions");
}

function readSessionStore(sessionsDir: string): SessionStore {
  const storePath = join(sessionsDir, "sessions.json");
  if (!existsSync(storePath)) return {};
  try {
    return JSON.parse(readFileSync(storePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeSessionStore(sessionsDir: string, store: SessionStore): void {
  const storePath = join(sessionsDir, "sessions.json");
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

function readTranscript(sessionsDir: string, sessionId: string, maxChars: number): string {
  const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) {
    return `[Transcript file not found: ${transcriptPath}]`;
  }

  const raw = readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      if (entry.type === "session") continue;

      let role = "";
      let text = "";

      if (entry.message) {
        role = entry.message.role || "unknown";
        if (typeof entry.message.content === "string") {
          text = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          text = entry.message.content
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        }
      } else if (entry.role) {
        role = entry.role;
        if (typeof entry.content === "string") {
          text = entry.content;
        } else if (Array.isArray(entry.content)) {
          text = entry.content
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        }
      }

      if (!text || !role) continue;
      if (role === "tool") continue;

      const formatted = `[${role.toUpperCase()}]: ${text}`;
      if (totalChars + formatted.length > maxChars) break;

      messages.push(formatted);
      totalChars += formatted.length;
    } catch {
      // Skip malformed lines
    }
  }

  return messages.join("\n\n---\n\n");
}

// ─── Batched Session Naming ──────────────────────────────────────────────────

async function batchGenerateSessionNames(
  llmConfig: LlmConfig,
  sessions: Array<{ key: string; snippet: string }>,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (sessions.length === 0) return results;

  // Build a single prompt with all sessions
  const sessionBlocks = sessions.map((s, i) =>
    `SESSION_${i + 1} (key: ${s.key}):\n${s.snippet}`
  ).join("\n\n---\n\n");

  const systemInstruction = `You are a conversation title generator. You will receive multiple conversation snippets, each labeled SESSION_1, SESSION_2, etc. For each one, generate a short, descriptive title.

Rules:
- 3-6 words per title
- No quotes around titles
- No punctuation at the end
- Be specific (not "Coding Discussion" but "Electron Window Manager Build")
- Output format: one line per session, exactly like:
SESSION_1: Your Title Here
SESSION_2: Another Title Here
- Output ONLY the titled lines, nothing else — no explanation, no preamble, no blank lines`;

  const prompt = `Generate titles for these ${sessions.length} conversations:\n\n${sessionBlocks}`;

  try {
    const response = await callLlm(llmConfig, prompt, systemInstruction, 2048);

    // Parse response lines
    for (const line of response.split("\n")) {
      const match = line.match(/^SESSION_(\d+):\s*(.+)$/i);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        if (idx >= 0 && idx < sessions.length) {
          const name = match[2]
            .replace(/^["'*]|["'*]$/g, "")
            .replace(/\.$/, "")
            .trim()
            .slice(0, 60);
          if (name) {
            results.set(sessions[idx].key, name);
          }
        }
      }
    }
  } catch (err) {
    // If batch fails, try individual naming as fallback (up to 3)
    const fallbackCount = Math.min(sessions.length, 3);
    for (let i = 0; i < fallbackCount; i++) {
      try {
        const name = await generateSingleSessionName(llmConfig, sessions[i].snippet);
        if (name) results.set(sessions[i].key, name);
      } catch {
        // Skip this one
      }
    }
  }

  return results;
}

async function generateSingleSessionName(
  llmConfig: LlmConfig,
  transcript: string,
): Promise<string> {
  const snippet = transcript.slice(0, 3000);

  const systemInstruction = `You are a conversation title generator. Your ONLY job is to output a short, descriptive title for a conversation. Rules:
- 3-6 words maximum
- No quotes around the title
- No punctuation at the end
- Capture the PRIMARY topic, project, or task
- Be specific (not "Coding Discussion" but "Electron Window Manager Build")
- Output ONLY the title, nothing else — no explanation, no preamble`;

  const name = await callLlm(llmConfig, `Generate a title for this conversation:\n\n${snippet}`, systemInstruction, 100);
  return name
    .replace(/^["'*]|["'*]$/g, "")
    .replace(/\.$/, "")
    .split("\n")[0]
    .trim()
    .slice(0, 60);
}

async function generateSessionSummary(
  llmConfig: LlmConfig,
  transcript: string,
  sessionName: string,
): Promise<string> {
  const systemInstruction = `You are a session context summarizer for an AI assistant called Vera. Your job is to create an extensive, detailed summary of a conversation so that Vera can seamlessly continue the work in a different chat channel.

Be THOROUGH. Include:
- Every decision made and why
- Every technical detail (versions, configs, architectures, code patterns)
- Every open question or unresolved item
- Every user preference or constraint expressed
- File paths, project names, URLs mentioned
- The current state of work (what's done, what's in progress, what's next)
- Any people mentioned and their context

The receiving assistant needs to feel like they were IN the original conversation.

Output format: A single valid JSON object (one line, no markdown code fences) with these fields:
{
  "session_name": "human-readable name",
  "topic": "main topic or project",
  "summary": "extensive narrative summary, 500-2000 words, covering everything discussed",
  "decisions": ["decision 1 with rationale", "decision 2 with rationale"],
  "technical_details": ["specific technical detail 1", "specific technical detail 2"],
  "current_status": "what state the work is in right now",
  "open_items": ["thing to do or decide 1", "thing to do or decide 2"],
  "preferences": ["user preference 1", "user preference 2"],
  "key_files": ["/path/to/important/file"],
  "people": ["Person Name - their relevance"]
}

Output ONLY the JSON object. No markdown, no explanation, no code fences.`;

  const prompt = `Session: "${sessionName}"

Full conversation transcript:
${transcript}

Generate the JSON summary:`;

  return await callLlm(llmConfig, prompt, systemInstruction);
}

function formatTimeAgo(dateVal: string | number | undefined): string {
  if (!dateVal) return "unknown";
  let ts: number;
  if (typeof dateVal === "number") {
    ts = dateVal;
  } else {
    ts = new Date(dateVal).getTime();
  }
  if (isNaN(ts)) return "unknown";

  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 0) return "just now";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function resolveSessionKey(
  store: SessionStore,
  input: string,
): { key: string; entry: SessionEntry } | null {
  const trimmed = input.trim();

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num > 0) {
    const entries = Object.entries(store)
      .filter(([_, e]) => e.sessionId)
      .sort((a, b) => {
        const ta = a[1].updatedAt ? new Date(a[1].updatedAt).getTime() : 0;
        const tb = b[1].updatedAt ? new Date(b[1].updatedAt).getTime() : 0;
        return tb - ta;
      });
    if (num <= entries.length) {
      const [key, entry] = entries[num - 1];
      return { key, entry };
    }
    return null;
  }

  if (store[trimmed]) {
    return { key: trimmed, entry: store[trimmed] };
  }

  const lower = trimmed.toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    const name = (entry.displayName || "").toLowerCase();
    if (name === lower || name.includes(lower)) {
      return { key, entry };
    }
  }

  for (const [key, entry] of Object.entries(store)) {
    if (key.toLowerCase().includes(lower)) {
      return { key, entry };
    }
  }

  return null;
}

function getSessionType(key: string): string {
  if (key.includes(":cron:") && key.includes(":run:")) return "⏰ cron-run";
  if (key.includes(":cron:")) return "⏰ cron";
  if (key.startsWith("hook:")) return "🪝 hook";
  if (key.includes(":subagent:")) return "🤖 subagent";
  if (key.includes(":group:")) return "👥 group";
  if (key.includes(":channel:")) return "📢 channel";
  if (key.includes(":thread:")) return "🧵 thread";
  if (key.includes(":topic:")) return "🧵 topic";
  if (key.includes(":dm:")) return "💬 dm";
  if (key.includes(":slash:")) return "⚡ slash";
  return "💬 session";
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const sessionBridgePlugin = {
  id: "session-bridge",
  name: "Session Bridge",
  description: "Cross-channel session context bridging with LLM summarization (Gemini, OpenAI, OpenRouter)",
  configSchema: {
    parse(value: unknown) {
      if (!value || typeof value !== "object") return {};
      return value as PluginConfig;
    },
  },

  register(api: OpenClawPluginApi) {
    const pluginConfig: PluginConfig =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as PluginConfig)
        : {};

    const maxTranscriptChars = pluginConfig.maxTranscriptChars || 200000;

    api.registerCommand({
      name: "session",
      description: "Session bridge: list, name, load, and rename sessions across channels",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        api.logger.info(`[session-bridge] Command invoked. channel=${ctx.channel} args="${ctx.args || ""}"`);

        try {
          const args = (ctx.args || "").trim();
          const tokens = args.split(/\s+/);
          const action = tokens[0]?.toLowerCase() || "list";

          const sessionsDir = findSessionsDir(ctx.config);
          const store = readSessionStore(sessionsDir);

          // ── /session list [--all] ──────────────────────────────────
          if (action === "list" || action === "ls") {
            const showAll = tokens.includes("--all") || tokens.includes("-a");

            const llmConfig = resolveLlmConfig(pluginConfig);

            const entries = Object.entries(store)
              .filter(([_, e]) => e.sessionId)
              .sort((a, b) => {
                const ta = typeof a[1].updatedAt === "number" ? a[1].updatedAt : new Date(a[1].updatedAt || 0).getTime();
                const tb = typeof b[1].updatedAt === "number" ? b[1].updatedAt : new Date(b[1].updatedAt || 0).getTime();
                return tb - ta;
              });

            if (entries.length === 0) {
              return { text: `📋 No active sessions found.` };
            }

            // ── Batch auto-name unnamed sessions ──────────────────────
            const unnamed: Array<{ key: string; snippet: string }> = [];
            for (const [key, entry] of entries) {
              if (!entry.displayName && entry.sessionId && llmConfig) {
                try {
                  const transcript = readTranscript(sessionsDir, entry.sessionId, 2000);
                  if (transcript && !transcript.startsWith("[Transcript")) {
                    // Take first 800 chars per session for batch naming (keeps total prompt manageable)
                    unnamed.push({ key, snippet: transcript.slice(0, 800) });
                  }
                } catch {
                  // Skip
                }
              }
            }

            if (unnamed.length > 0 && llmConfig) {
              api.logger.info(`[session-bridge] Batch naming ${unnamed.length} unnamed sessions via ${llmConfig.provider}/${llmConfig.model}`);
              try {
                const names = await batchGenerateSessionNames(llmConfig, unnamed);
                let needsWrite = false;
                for (const [key, name] of names) {
                  if (store[key]) {
                    store[key].displayName = name;
                    needsWrite = true;
                    api.logger.info(`[session-bridge] Named "${key}" → "${name}"`);
                  }
                }
                if (needsWrite) {
                  writeSessionStore(sessionsDir, store);
                }
              } catch (err) {
                api.logger.error(`[session-bridge] Batch naming failed: ${err}`);
              }
            }

            // ── Collapse cron runs ──────────────────────────────────
            const cronParents = new Map<string, number>();
            const displayEntries: Array<[string, SessionEntry, string]> = [];

            for (const [key, entry] of entries) {
              const sessionType = getSessionType(key);

              if (key.includes(":cron:") && key.includes(":run:")) {
                const parentKey = key.replace(/:run:[^:]+$/, "");
                cronParents.set(parentKey, (cronParents.get(parentKey) || 0) + 1);
                continue;
              }

              displayEntries.push([key, entry, sessionType]);
            }

            const lines = displayEntries.map(([key, entry, sessionType], i) => {
              const name = entry.displayName || key;
              const channel = entry.origin?.provider || entry.channel || entry.provider || "";
              const time = formatTimeAgo(entry.updatedAt);
              const runCount = cronParents.get(key);
              const runSuffix = runCount ? ` (${runCount} runs)` : "";
              const channelStr = channel ? `, ${channel}` : "";
              return `${i + 1}. ${sessionType} "${name}"${channelStr}, ${time}${runSuffix}`;
            });

            // ── --all: scan orphaned transcripts ──────────────────────
            let orphanSection = "";
            if (showAll) {
              try {
                const { readdirSync, statSync } = require("fs");
                const allFiles: string[] = readdirSync(sessionsDir)
                  .filter((f: string) => f.endsWith(".jsonl"));
                const knownSessionIds = new Set(
                  Object.values(store)
                    .map((e: SessionEntry) => e.sessionId)
                    .filter(Boolean),
                );
                const orphanFiles = allFiles.filter((f: string) => {
                  const id = f.replace(".jsonl", "");
                  return !knownSessionIds.has(id);
                });

                if (orphanFiles.length > 0) {
                  // Batch name orphans too
                  const orphanData: Array<{ key: string; snippet: string; time: string }> = [];
                  for (const file of orphanFiles.slice(0, 20)) {
                    const sessionId = file.replace(".jsonl", "");
                    const filePath = join(sessionsDir, file);
                    const stat = statSync(filePath);
                    const time = formatTimeAgo(stat.mtimeMs);
                    let snippet = "";
                    try {
                      const transcript = readTranscript(sessionsDir, sessionId, 800);
                      if (transcript && !transcript.startsWith("[Transcript")) {
                        snippet = transcript;
                      }
                    } catch { /* skip */ }
                    orphanData.push({ key: sessionId, snippet, time });
                  }

                  // Batch name the ones with snippets
                  const toName = orphanData.filter(o => o.snippet);
                  let orphanNames = new Map<string, string>();
                  if (toName.length > 0 && llmConfig) {
                    try {
                      orphanNames = await batchGenerateSessionNames(llmConfig, toName);
                    } catch { /* skip */ }
                  }

                  const orphanLines = orphanData.map(o => {
                    const name = orphanNames.get(o.key) || o.key;
                    return `  📜 "${name}" — archived, ${o.time}`;
                  });

                  const moreCount = orphanFiles.length > 20 ? `\n  ... and ${orphanFiles.length - 20} more` : "";
                  orphanSection = `\n\n📜 Historical Sessions (${orphanFiles.length}):\n${orphanLines.join("\n")}${moreCount}`;
                }
              } catch (err) {
                api.logger.error(`[session-bridge] Failed to scan orphaned transcripts: ${err}`);
              }
            }

            const providerNote = llmConfig ? ` (via ${llmConfig.provider}/${llmConfig.model})` : "";
            const allSuffix = !showAll && lines.length > 0
              ? "\n\nTip: /session list --all to include historical sessions"
              : "";

            return { text: `📋 Active Sessions${providerNote}:\n${lines.join("\n")}${orphanSection}${allSuffix}` };
          }

          // ── /session name <title> ──────────────────────────────────
          if (action === "name" || action === "title") {
            const newName = tokens.slice(1).join(" ").trim();
            if (!newName) {
              return { text: "❌ Usage: /session name <title>" };
            }

            const currentChannel = ctx.channel || "webchat";
            let currentKey: string | null = null;

            const sorted = Object.entries(store)
              .filter(([_, e]) => e.sessionId)
              .sort((a, b) => {
                const ta = a[1].updatedAt ? new Date(a[1].updatedAt).getTime() : 0;
                const tb = b[1].updatedAt ? new Date(b[1].updatedAt).getTime() : 0;
                return tb - ta;
              });

            if (sorted.length > 0) {
              const sameChannel = sorted.find(
                ([_, e]) =>
                  (e.origin?.provider || e.channel || "").includes(currentChannel),
              );
              currentKey = sameChannel ? sameChannel[0] : sorted[0][0];
            }

            if (!currentKey || !store[currentKey]) {
              return { text: "❌ Could not identify current session." };
            }

            store[currentKey].displayName = newName;
            try {
              writeSessionStore(sessionsDir, store);
            } catch (err) {
              return { text: `❌ Failed to save name: ${err}` };
            }

            return { text: `✅ Session renamed to "${newName}"` };
          }

          // ── /session rename <id> <title> ───────────────────────────
          if (action === "rename" || action === "mv") {
            if (tokens.length < 3) {
              return { text: "❌ Usage: /session rename <number or name> <new title>" };
            }

            const target = tokens[1];
            const newName = tokens.slice(2).join(" ").trim();
            const resolved = resolveSessionKey(store, target);

            if (!resolved) {
              return { text: `❌ Session not found: "${target}"` };
            }

            resolved.entry.displayName = newName;
            store[resolved.key] = resolved.entry;
            try {
              writeSessionStore(sessionsDir, store);
            } catch (err) {
              return { text: `❌ Failed to save name: ${err}` };
            }

            return { text: `✅ Session renamed to "${newName}"` };
          }

          // ── /session load <id or name> ─────────────────────────────
          if (action === "load" || action === "bridge" || action === "switch") {
            const target = tokens.slice(1).join(" ").trim();
            if (!target) {
              return { text: "❌ Usage: /session load <number or name>" };
            }

            const llmConfig = resolveLlmConfig(pluginConfig);
            if (!llmConfig) {
              return {
                text: "❌ No LLM API key configured. Set provider config in plugin settings, environment variables, or macOS Keychain.\n\nSupported providers: gemini, openai, openrouter",
              };
            }

            const resolved = resolveSessionKey(store, target);
            if (!resolved) {
              return { text: `❌ Session not found: "${target}"` };
            }

            if (!resolved.entry.sessionId) {
              return { text: `❌ Session "${target}" has no transcript.` };
            }

            const sessionName = resolved.entry.displayName || resolved.key;

            const transcript = readTranscript(
              sessionsDir,
              resolved.entry.sessionId,
              maxTranscriptChars,
            );

            if (transcript.startsWith("[Transcript")) {
              return { text: `❌ ${transcript}` };
            }

            // Generate name if missing
            if (!resolved.entry.displayName) {
              try {
                const name = await generateSingleSessionName(llmConfig, transcript);
                resolved.entry.displayName = name;
                store[resolved.key] = resolved.entry;
                writeSessionStore(sessionsDir, store);
              } catch { /* non-critical */ }
            }

            const finalName = resolved.entry.displayName || sessionName;

            // Generate summary
            let summary: string;
            try {
              summary = await generateSessionSummary(llmConfig, transcript, finalName);
            } catch (err) {
              return {
                text: `❌ Summarization failed (${llmConfig.provider}/${llmConfig.model}): ${err instanceof Error ? err.message : String(err)}`,
              };
            }

            const injectionMessage = `[Session Bridge] Loading context from session "${finalName}" (key: ${resolved.key})

The following is an extensive JSONL-formatted summary generated by ${llmConfig.provider}/${llmConfig.model} of the conversation from that session. Use this context to seamlessly continue the work discussed there.

${summary}

---
Session bridge complete. You now have full context from "${finalName}". Continue the conversation naturally.`;

            try {
              const currentChannel = ctx.channel || "webchat";
              let currentSessionKey: string | null = null;

              const recentSessions = Object.entries(store)
                .filter(([k, _]) => k !== resolved.key)
                .sort((a, b) => {
                  const ta = a[1].updatedAt ? new Date(a[1].updatedAt).getTime() : 0;
                  const tb = b[1].updatedAt ? new Date(b[1].updatedAt).getTime() : 0;
                  return tb - ta;
                });

              const channelMatch = recentSessions.find(([_, e]) => {
                const prov = e.origin?.provider || e.channel || "";
                return prov.includes(currentChannel);
              });

              if (channelMatch) {
                currentSessionKey = channelMatch[0];
              } else if (recentSessions.length > 0) {
                currentSessionKey = recentSessions[0][0];
              }

              if (currentSessionKey) {
                api.runtime.system.enqueueSystemEvent(injectionMessage, {
                  sessionKey: currentSessionKey,
                });
              }
            } catch (err) {
              api.logger.warn(`[session-bridge] Failed to enqueue system event: ${err}`);
            }

            return {
              text: `✅ Session "${finalName}" loaded via ${llmConfig.provider}!\n\nContext has been injected into your current session. The assistant now has full context from that conversation.\n\n📝 Summary preview:\n${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}`,
            };
          }

          // ── /session help ──────────────────────────────────────────
          if (action === "help" || action === "?") {
            const llmConfig = resolveLlmConfig(pluginConfig);
            const providerInfo = llmConfig
              ? `\n\n🔌 Provider: ${llmConfig.provider} (${llmConfig.model})`
              : "\n\n⚠️ No LLM provider configured";

            return {
              text: `📋 Session Bridge Commands:

/session list — List active sessions with names and activity
/session list --all — Include historical/archived sessions
/session load <# or name> — Load session context into current chat
/session name <title> — Name the current session
/session rename <# or name> <title> — Rename any session
/session help — Show this help${providerInfo}

Supported providers: gemini, openai, openrouter
Configure in OpenClaw plugin settings.`,
            };
          }

          // ── Default: suggest load ──────────────────────────────────
          const resolved = resolveSessionKey(store, args);
          if (resolved) {
            return {
              text: `Did you mean: /session load ${args}?\n\nUse /session help to see all commands.`,
            };
          }

          return {
            text: `❓ Unknown command: /session ${action}\n\nUse /session help to see available commands.`,
          };

        } catch (err) {
          const errMsg = err instanceof Error ? err.stack || err.message : String(err);
          api.logger.error(`[session-bridge] Unhandled error: ${errMsg}`);
          return { text: `❌ Session Bridge Error:\n${errMsg}` };
        }
      },
    });

    const llmConfig = resolveLlmConfig(pluginConfig);
    const providerStr = llmConfig ? `${llmConfig.provider}/${llmConfig.model}` : "no provider configured";
    api.logger.info(`[session-bridge] Plugin registered. Provider: ${providerStr}. Use /session to manage sessions.`);
  },
};

export default sessionBridgePlugin;
