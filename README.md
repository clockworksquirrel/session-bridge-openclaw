# Session Bridge for OpenClaw

Cross-channel session context bridging for [OpenClaw](https://github.com/openclaw/openclaw). Load conversation context from any session into any channel — webchat, Telegram, Discord, WhatsApp, etc.

Supports **Gemini**, **OpenAI**, and **OpenRouter** as LLM providers for naming and summarization.

## What It Does

When you're working on a project in webchat and want to continue on Telegram (or vice versa), Session Bridge lets you:

1. **List** all your sessions across channels with auto-generated names
2. **Load** a session's full context into your current chat via LLM summarization
3. **Name** sessions with custom titles for easy reference
4. **Browse** historical/archived sessions

## How It Works

```
/session list              → See all active sessions with names
/session list --all        → Include historical/archived sessions
/session load <# or name>  → Load session context into current chat
/session name <title>      → Name the current session
/session rename <# or name> <title> → Rename any session
/session help              → Show commands + active provider
```

### Example

```
You (on Telegram):  /session list

📋 Active Sessions (via gemini/gemini-3-pro-preview):
1. 💬 session "Electron Window Manager Build", webchat, 3m ago
2. ⏰ cron "Proton Mail Bridge Sync", 1d ago (52 runs)
3. 💬 session "Side Project", telegram, 2h ago

You (on Telegram):  /session load 1

✅ Session "Electron Window Manager Build" loaded via gemini!
Context has been injected into your current session...
```

Now the AI assistant in your Telegram chat has full context from your webchat conversation and can continue seamlessly.

## How Context Transfer Works

1. Reads the session's JSONL transcript
2. Sends it to your configured LLM provider for extensive summarization
3. Summary is formatted as structured JSON with: topic, decisions, technical details, current status, open items, preferences, key files, and people
4. Summary is injected into the current session via OpenClaw's system event mechanism
5. The AI assistant sees the summary and can continue the work naturally

## Batched Session Naming

When listing sessions, all unnamed sessions are named in a **single batched LLM call** — the plugin sends all conversation snippets in one prompt and gets all titles back at once. This is faster and avoids rate limits compared to individual API calls per session.

## Installation

### From source

```bash
git clone https://github.com/clockworksquirrel/session-bridge-openclaw.git
cp -r session-bridge-openclaw ~/.openclaw/extensions/session-bridge
```

### Manual

Copy the files to `~/.openclaw/extensions/session-bridge/`:

```
~/.openclaw/extensions/session-bridge/
├── index.ts
├── openclaw.plugin.json
└── package.json
```

### Enable in config

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "session-bridge": {
        "enabled": true,
        "config": {
          "provider": "gemini",
          "geminiModel": "gemini-3-pro-preview",
          "maxTranscriptChars": 200000
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

## LLM Providers

Session Bridge supports three providers. Set `provider` in your config to switch.

### Gemini (default)

```json
{
  "provider": "gemini",
  "geminiModel": "gemini-3-pro-preview",
  "geminiApiKey": "your-key-here"
}
```

API key resolution: plugin config → `GEMINI_API_KEY` env → macOS Keychain (`service: gemini, account: api-key`)

### OpenAI

```json
{
  "provider": "openai",
  "openaiModel": "gpt-4o",
  "openaiApiKey": "sk-..."
}
```

API key resolution: plugin config → `OPENAI_API_KEY` env → macOS Keychain (`service: openai, account: api-key`)

The `openaiBaseUrl` option supports any OpenAI-compatible API (Azure, local LLMs, etc.):

```json
{
  "provider": "openai",
  "openaiModel": "llama-3.3-70b",
  "openaiApiKey": "your-key",
  "openaiBaseUrl": "http://localhost:11434/v1"
}
```

### OpenRouter

```json
{
  "provider": "openrouter",
  "openrouterModel": "anthropic/claude-sonnet-4",
  "openrouterApiKey": "sk-or-..."
}
```

API key resolution: plugin config → `OPENROUTER_API_KEY` env → macOS Keychain (`service: openrouter, account: api-key`)

Any model on [OpenRouter's model list](https://openrouter.ai/models) works.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `gemini` | LLM provider: `gemini`, `openai`, or `openrouter` |
| `geminiModel` | `gemini-3-pro-preview` | Gemini model for summarization and naming |
| `geminiApiKey` | *(auto-detected)* | Gemini API key |
| `openaiModel` | `gpt-4o` | OpenAI model |
| `openaiApiKey` | *(auto-detected)* | OpenAI API key |
| `openaiBaseUrl` | `https://api.openai.com/v1` | Custom OpenAI-compatible base URL |
| `openrouterModel` | `anthropic/claude-sonnet-4` | OpenRouter model |
| `openrouterApiKey` | *(auto-detected)* | OpenRouter API key |
| `maxTranscriptChars` | `200000` | Max transcript characters sent for summarization |

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) (2026.2.x or later)
- An API key for at least one supported provider

## Session Types

The list view shows emoji tags for different session types:

| Emoji | Type | Description |
|-------|------|-------------|
| 💬 | session | Regular chat session (DM, webchat) |
| 💬 | dm | Direct message session |
| ⏰ | cron | Cron job session (collapsed with run count) |
| 🪝 | hook | Webhook session |
| 🤖 | subagent | Sub-agent session |
| 👥 | group | Group chat session |
| 📢 | channel | Channel/room session |
| 🧵 | thread/topic | Thread or topic session |
| ⚡ | slash | Slash command session |
| 📜 | archived | Historical session (--all flag) |

## Changelog

### 2026-02-11 (v1.1.0)
- **Multi-provider support**: Added OpenAI and OpenRouter alongside Gemini. Any OpenAI-compatible API works via `openaiBaseUrl`.
- **Batched session naming**: All unnamed sessions are now named in a single LLM call instead of one-by-one. Fixes the issue where only 1-2 sessions got named before rate limits kicked in.
- **Provider display**: `/session list` and `/session help` show which provider and model are active.

### 2026-02-11 (v1.0.0)
- Initial release with Gemini support, `/session list/load/name/rename/help` commands.

## License

MIT

## Credits

Built by Vera 🌀 for Josh.
