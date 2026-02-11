import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
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

interface PluginConfig {
  enabled?: boolean;
  geminiModel?: string;
  geminiApiKey?: string;
  maxTranscriptChars?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveGeminiApiKey(pluginConfig: PluginConfig): string | null {
  // 1. Plugin config
  if (pluginConfig.geminiApiKey) return pluginConfig.geminiApiKey;

  // 2. Environment variable
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;

  // 3. macOS Keychain
  try {
    const key = execSync(
      'security find-generic-password -s "gemini" -a "api-key" -w 2>/dev/null',
      { encoding: "utf-8" },
    ).trim();
    if (key) return key;
  } catch {
    // Keychain not available or entry not found
  }

  return null;
}

function findSessionsDir(config: any): string {
  // Default path: ~/.openclaw/agents/<agentId>/sessions/
  const stateDir =
    config.stateDir ||
    join(process.env.HOME || "/tmp", ".openclaw");
  const agentId = config.agents?.list?.[0]?.id || "main";
  const result = join(stateDir, "agents", agentId, "sessions");

  // Debug: also check what files are actually there
  try {
    const { readdirSync } = require("fs");
    const files = readdirSync(result);
    console.error(`[session-bridge] findSessionsDir: ${result} has ${files.length} files: ${files.slice(0, 10).join(", ")}`);
  } catch (e) {
    console.error(`[session-bridge] findSessionsDir: ${result} - error reading: ${e}`);
  }

  return result;
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
  // Try direct sessionId.jsonl
  let transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) {
    // Sometimes sessionId has colons that become part of the filename
    // Try finding it
    return `[Transcript file not found: ${transcriptPath}]`;
  }

  const raw = readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  // Extract readable conversation from JSONL
  const messages: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);

      // Skip non-message entries
      if (entry.type === "session") continue;

      let role = "";
      let text = "";

      // Handle different entry formats
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

      // Skip tool results and system events that are just noise
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

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  systemInstruction?: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
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

  const data: GeminiResponse = await response.json();

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  return text;
}

async function generateSessionName(
  apiKey: string,
  model: string,
  transcript: string,
): Promise<string> {
  // Only send first ~3000 chars for naming — enough to understand the topic
  const snippet = transcript.slice(0, 3000);

  const systemInstruction = `You are a conversation title generator. Your ONLY job is to output a short, descriptive title for a conversation. Rules:
- 3-6 words maximum
- No quotes around the title
- No punctuation at the end
- Capture the PRIMARY topic, project, or task
- Be specific (not "Coding Discussion" but "Electron Window Manager Build")
- Output ONLY the title, nothing else — no explanation, no preamble`;

  const prompt = `Generate a title for this conversation:

${snippet}`;

  const name = await callGemini(apiKey, model, prompt, systemInstruction);
  // Clean up — remove quotes, trim, take first line only
  return name
    .replace(/^["'*]|["'*]$/g, "")
    .replace(/\.$/, "")
    .split("\n")[0]
    .trim()
    .slice(0, 60);
}

async function generateSessionSummary(
  apiKey: string,
  model: string,
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

  return await callGemini(apiKey, model, prompt, systemInstruction);
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

  // Try by number (from list)
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

  // Try by exact key
  if (store[trimmed]) {
    return { key: trimmed, entry: store[trimmed] };
  }

  // Try by display name (case-insensitive, fuzzy)
  const lower = trimmed.toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    const name = (entry.displayName || "").toLowerCase();
    if (name === lower || name.includes(lower)) {
      return { key, entry };
    }
  }

  // Try by key substring
  for (const [key, entry] of Object.entries(store)) {
    if (key.toLowerCase().includes(lower)) {
      return { key, entry };
    }
  }

  return null;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const sessionBridgePlugin = {
  id: "session-bridge",
  name: "Session Bridge",
  description: "Cross-channel session context bridging with Gemini summarization",
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

    const geminiModel = pluginConfig.geminiModel || "gemini-3-pro-preview";
    const maxTranscriptChars = pluginConfig.maxTranscriptChars || 200000;

    api.registerCommand({
      name: "session",
      description: "Session bridge: list, name, load, and rename sessions across channels",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        api.logger.info(`[session-bridge] Command handler invoked. channel=${ctx.channel} sender=${ctx.senderId} args="${ctx.args || ""}"`);

        try {
          const args = (ctx.args || "").trim();
          const tokens = args.split(/\s+/);
          const action = tokens[0]?.toLowerCase() || "list";

          api.logger.info(`[session-bridge] Parsed action: "${action}" from args: "${args}"`);

          const sessionsDir = findSessionsDir(ctx.config);
          api.logger.info(`[session-bridge] Resolved sessionsDir: ${sessionsDir}`);

          const store = readSessionStore(sessionsDir);
          api.logger.info(`[session-bridge] Loaded store with ${Object.keys(store).length} entries`);

        // ── /session list [--all] ──────────────────────────────────────
        if (action === "list" || action === "ls") {
          const showAll = tokens.includes("--all") || tokens.includes("-a");
          api.logger.info(`[session-bridge] /session list invoked`);
          api.logger.info(`[session-bridge] sessionsDir: ${sessionsDir}`);
          api.logger.info(`[session-bridge] sessionsDir exists: ${existsSync(sessionsDir)}`);

          const storeKeys = Object.keys(store);
          api.logger.info(`[session-bridge] store has ${storeKeys.length} keys: ${storeKeys.join(", ")}`);

          const apiKey = resolveGeminiApiKey(pluginConfig);
          api.logger.info(`[session-bridge] Gemini API key resolved: ${apiKey ? "yes (" + apiKey.slice(0, 8) + "...)" : "NO"}`);

          const entries = Object.entries(store)
            .filter(([_, e]) => e.sessionId)
            .sort((a, b) => {
              const ta = typeof a[1].updatedAt === "number" ? a[1].updatedAt : new Date(a[1].updatedAt || 0).getTime();
              const tb = typeof b[1].updatedAt === "number" ? b[1].updatedAt : new Date(b[1].updatedAt || 0).getTime();
              return tb - ta;
            });

          api.logger.info(`[session-bridge] total entries with sessionId: ${entries.length}`);

          if (entries.length === 0) {
            // Show debug info in the response too
            return {
              text: `📋 No active sessions found.\n\n🔍 Debug:\n- Sessions dir: ${sessionsDir}\n- Dir exists: ${existsSync(sessionsDir)}\n- Store keys: ${storeKeys.length > 0 ? storeKeys.join(", ") : "(empty)"}\n- Store entries with sessionId: 0`,
            };
          }

          // Auto-name sessions that don't have displayName
          let needsWrite = false;
          for (const [key, entry] of entries) {
            if (!entry.displayName && entry.sessionId && apiKey) {
              api.logger.info(`[session-bridge] Auto-naming session: ${key} (sessionId: ${entry.sessionId})`);
              try {
                const transcript = readTranscript(sessionsDir, entry.sessionId, 2000);
                api.logger.info(`[session-bridge] Transcript for ${key}: ${transcript ? transcript.length + " chars" : "null"}, starts with: ${transcript?.slice(0, 50)}`);
                if (transcript && !transcript.startsWith("[Transcript")) {
                  const name = await generateSessionName(apiKey, geminiModel, transcript);
                  api.logger.info(`[session-bridge] Generated name for ${key}: "${name}"`);
                  entry.displayName = name;
                  store[key] = entry;
                  needsWrite = true;
                }
              } catch (err) {
                api.logger.error(`[session-bridge] Failed to auto-name session ${key}: ${err}`);
              }
            }
          }

          if (needsWrite) {
            try {
              writeSessionStore(sessionsDir, store);
              api.logger.info(`[session-bridge] Wrote updated session store`);
            } catch (err) {
              api.logger.error(`[session-bridge] Failed to write session store: ${err}`);
            }
          }

          // Determine session type from key
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

          // Collapse duplicate cron runs — show parent cron once with run count
          const cronParents = new Map<string, number>();
          const displayEntries: Array<[string, SessionEntry, string]> = [];

          for (const [key, entry] of entries) {
            const sessionType = getSessionType(key);

            if (key.includes(":cron:") && key.includes(":run:")) {
              // Extract parent cron key
              const parentKey = key.replace(/:run:[^:]+$/, "");
              cronParents.set(parentKey, (cronParents.get(parentKey) || 0) + 1);
              // Skip individual runs — we'll show the parent with a count
              continue;
            }

            if (key.includes(":cron:") && !key.includes(":run:")) {
              // This is the parent cron — we'll add run count later
              displayEntries.push([key, entry, sessionType]);
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

          if (lines.length === 0 && !showAll) {
            return { text: "📋 No active sessions found.\nTry /session list --all to include historical sessions." };
          }

          // If --all, also scan for orphaned transcript files not in the store
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
                // Try to name orphaned sessions via Gemini
                const orphanLines: string[] = [];
                for (const file of orphanFiles.slice(0, 20)) { // Cap at 20 to avoid huge Gemini bills
                  const sessionId = file.replace(".jsonl", "");
                  const filePath = join(sessionsDir, file);
                  const stat = statSync(filePath);
                  const time = formatTimeAgo(stat.mtimeMs);

                  let name = sessionId;
                  if (apiKey) {
                    try {
                      const transcript = readTranscript(sessionsDir, sessionId, 2000);
                      if (transcript && !transcript.startsWith("[Transcript")) {
                        name = await generateSessionName(apiKey, geminiModel, transcript);
                      }
                    } catch {
                      // Keep UUID as name
                    }
                  }

                  orphanLines.push(`  📜 "${name}" — archived, ${time}`);
                }
                const moreCount = orphanFiles.length > 20 ? `\n  ... and ${orphanFiles.length - 20} more` : "";
                orphanSection = `\n\n📜 Historical Sessions (${orphanFiles.length}):\n${orphanLines.join("\n")}${moreCount}`;
              }
            } catch (err) {
              api.logger.error(`[session-bridge] Failed to scan orphaned transcripts: ${err}`);
            }
          }

          const allSuffix = !showAll && lines.length > 0
            ? "\n\nTip: /session list --all to include historical sessions"
            : "";

          return { text: `📋 Active Sessions:\n${lines.join("\n")}${orphanSection}${allSuffix}` };
        }

        // ── /session name <title> ──────────────────────────────────────
        if (action === "name" || action === "title") {
          const newName = tokens.slice(1).join(" ").trim();
          if (!newName) {
            return { text: "❌ Usage: /session name <title>" };
          }

          // Find the current session key from context
          // The command handler doesn't directly expose the session key,
          // so we try to find the most recently updated session for this channel
          const currentChannel = ctx.channel || "webchat";
          let currentKey: string | null = null;

          // Find most recently updated session
          const sorted = Object.entries(store)
            .filter(([_, e]) => e.sessionId)
            .sort((a, b) => {
              const ta = a[1].updatedAt ? new Date(a[1].updatedAt).getTime() : 0;
              const tb = b[1].updatedAt ? new Date(b[1].updatedAt).getTime() : 0;
              return tb - ta;
            });

          if (sorted.length > 0) {
            // Prefer sessions from the same channel, otherwise take most recent
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

        // ── /session rename <id> <title> ───────────────────────────────
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

        // ── /session load <id or name> ─────────────────────────────────
        if (action === "load" || action === "bridge" || action === "switch") {
          const target = tokens.slice(1).join(" ").trim();
          if (!target) {
            return { text: "❌ Usage: /session load <number or name>" };
          }

          const apiKey = resolveGeminiApiKey(pluginConfig);
          if (!apiKey) {
            return {
              text: "❌ Gemini API key not configured. Set it in plugin config, GEMINI_API_KEY env var, or macOS Keychain (service: gemini, account: api-key).",
            };
          }

          const resolved = resolveSessionKey(store, target);
          if (!resolved) {
            return { text: `❌ Session not found: "${target}"` };
          }

          if (!resolved.entry.sessionId) {
            return { text: `❌ Session "${target}" has no transcript.` };
          }

          const sessionName =
            resolved.entry.displayName || resolved.key;

          // Read the transcript
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
              const name = await generateSessionName(apiKey, geminiModel, transcript);
              resolved.entry.displayName = name;
              store[resolved.key] = resolved.entry;
              writeSessionStore(sessionsDir, store);
            } catch {
              // Non-critical, continue
            }
          }

          const finalName = resolved.entry.displayName || sessionName;

          // Generate summary via Gemini
          let summary: string;
          try {
            summary = await generateSessionSummary(
              apiKey,
              geminiModel,
              transcript,
              finalName,
            );
          } catch (err) {
            return {
              text: `❌ Gemini summarization failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }

          // Inject the summary into the current session via system event
          // Build the injection message
          const injectionMessage = `[Session Bridge] Loading context from session "${finalName}" (key: ${resolved.key})

The following is an extensive JSONL-formatted summary generated by Gemini of the conversation from that session. Use this context to seamlessly continue the work discussed there.

${summary}

---
Session bridge complete. You now have full context from "${finalName}". Continue the conversation naturally.`;

          // Enqueue as system event so the agent sees it on the next turn
          try {
            // We need to figure out the current session key for injection.
            // Since registerCommand doesn't expose it directly, we inject into
            // the most likely current session for this channel.
            const currentChannel = ctx.channel || "webchat";

            // Find the session key for the current channel
            let currentSessionKey: string | null = null;

            // For the main session (most common), it's agent:main:main
            // But we should try to find the actual current session
            const recentSessions = Object.entries(store)
              .filter(([k, _]) => k !== resolved.key) // Don't inject into the source session
              .sort((a, b) => {
                const ta = a[1].updatedAt ? new Date(a[1].updatedAt).getTime() : 0;
                const tb = b[1].updatedAt ? new Date(b[1].updatedAt).getTime() : 0;
                return tb - ta;
              });

            // Try to find a session matching the current channel
            const channelMatch = recentSessions.find(([_, e]) => {
              const prov = e.origin?.provider || e.channel || "";
              return prov.includes(currentChannel);
            });

            if (channelMatch) {
              currentSessionKey = channelMatch[0];
            } else if (recentSessions.length > 0) {
              // Fall back to most recent session
              currentSessionKey = recentSessions[0][0];
            }

            if (currentSessionKey) {
              api.runtime.system.enqueueSystemEvent(injectionMessage, {
                sessionKey: currentSessionKey,
              });
            }
          } catch (err) {
            api.logger.warn(`[session-bridge] Failed to enqueue system event: ${err}`);
            // Even if system event injection fails, return the summary as the command reply
            // so the user still sees it
          }

          // Also return the summary as the command reply (user sees it immediately)
          return {
            text: `✅ Session "${finalName}" loaded!\n\nContext has been injected into your current session. The assistant now has full context from that conversation.\n\n📝 Summary preview:\n${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}`,
          };
        }

        // ── /session help ──────────────────────────────────────────────
        if (action === "help" || action === "?") {
          return {
            text: `📋 Session Bridge Commands:

/session list — List active sessions with names and activity
/session list --all — Include historical/archived sessions
/session load <# or name> — Load session context into current chat
/session name <title> — Name the current session
/session rename <# or name> <title> — Rename any session
/session help — Show this help`,
          };
        }

        // ── Default: treat as /session list ────────────────────────────
        // If someone types /session with something we don't recognize,
        // try to load it (maybe they typed /session 1 or /session "my project")
        const resolved = resolveSessionKey(store, args);
        if (resolved) {
          // Redirect to load logic
          const fakeCtx = { ...ctx, args: `load ${args}` };
          // Re-run as load — but to avoid recursion, just tell them to use load
          return {
            text: `Did you mean: /session load ${args}?\n\nUse /session help to see all commands.`,
          };
        }

        return {
          text: `❓ Unknown command: /session ${action}\n\nUse /session help to see available commands.`,
        };

        } catch (err) {
          const errMsg = err instanceof Error ? err.stack || err.message : String(err);
          api.logger.error(`[session-bridge] Unhandled error in command handler: ${errMsg}`);
          return {
            text: `❌ Session Bridge Error:\n${errMsg}`,
          };
        }
      },
    });

    api.logger.info("[session-bridge] Plugin registered. Use /session to manage sessions.");
  },
};

export default sessionBridgePlugin;
