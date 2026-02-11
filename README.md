# Session Bridge for OpenClaw

Cross-channel session context bridging for [OpenClaw](https://github.com/openclaw/openclaw). Load conversation context from any session into any channel — webchat, Telegram, Discord, WhatsApp, etc.

## What It Does

When you're working on a project in webchat and want to continue on Telegram (or vice versa), Session Bridge lets you:

1. **List** all your sessions across channels with auto-generated names
2. **Load** a session's full context into your current chat via Gemini AI summarization
3. **Name** sessions with custom titles for easy reference
4. **Browse** historical/archived sessions

## How It Works

```
/session list              → See all active sessions with names
/session list --all        → Include historical/archived sessions
/session load <# or name>  → Load session context into current chat
/session name <title>      → Name the current session
/session rename <# or name> <title> → Rename any session
/session help              → Show commands
```

### Example

```
You (on Telegram):  /session list

📋 Active Sessions:
1. 💬 session "Electron Window Manager Build", webchat, 3m ago
2. ⏰ cron "Proton Mail Bridge Sync", 1d ago (52 runs)
3. 💬 session "Side Project", telegram, 2h ago

You (on Telegram):  /session load 1

✅ Session "Electron Window Manager Build" loaded!
Context has been injected into your current session...
```

Now the AI assistant in your Telegram chat has full context from your webchat conversation and can continue seamlessly.

## How Context Transfer Works

1. Reads the session's JSONL transcript
2. Sends it to **Gemini 3 Pro Preview** for extensive summarization
3. Summary is formatted as structured JSON with: topic, decisions, technical details, current status, open items, preferences, key files, and people
4. Summary is injected into the current session via OpenClaw's system event mechanism
5. The AI assistant sees the summary and can continue the work naturally

## Installation

### From source

```bash
# Clone the repo
git clone https://github.com/clockworksquirrel/session-bridge-openclaw.git

# Copy to OpenClaw extensions
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

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `geminiModel` | `gemini-3-pro-preview` | Gemini model for summarization and naming |
| `geminiApiKey` | *(auto-detected)* | Gemini API key. Auto-resolves from: plugin config → `GEMINI_API_KEY` env → macOS Keychain |
| `maxTranscriptChars` | `200000` | Max transcript characters sent to Gemini |

### Gemini API Key Resolution

The plugin looks for the Gemini API key in this order:

1. Plugin config: `plugins.entries.session-bridge.config.geminiApiKey`
2. Environment variable: `GEMINI_API_KEY`
3. macOS Keychain: `security find-generic-password -s "gemini" -a "api-key" -w`

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) (2026.2.x or later)
- A [Google Gemini API key](https://aistudio.google.com/apikey)

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

## License

MIT

## Credits

Built by Vera 🌀 for Josh.
