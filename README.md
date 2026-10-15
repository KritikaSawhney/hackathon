# 🎙️ EchoLog — Real-Time DevEx Intelligence from Verbal Conversations

<div align="center">

![EchoLog Banner](https://img.shields.io/badge/EchoLog-Hackathon%20Project-blueviolet?style=for-the-badge&logo=amazonaws)
![AWS Bedrock](https://img.shields.io/badge/AWS_Bedrock-Claude_3.5_Sonnet-orange?style=for-the-badge&logo=amazonaws)
![VS Code](https://img.shields.io/badge/VS_Code-Extension-007ACC?style=for-the-badge&logo=visualstudiocode)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)

**EchoLog bridges the gap between verbal team discussions and your codebase — automatically.**

[Architecture](#architecture) · [Quick Start](#quick-start) · [AWS Setup](#aws-bedrock-setup) · [VS Code Extension](#vs-code-extension) · [Roadmap](#roadmap)

</div>

---

## 💡 The Problem

Every engineering team loses critical architectural decisions in verbal conversations. Stand-ups, design reviews, and Slack calls produce invaluable technical context — but none of it reaches the IDE where developers actually *work*. This creates:

- **Decision drift** — What was said vs. what was implemented
- **Knowledge silos** — Only attendees know what was decided
- **Documentation debt** — Never written because it's "too much work"

## 🚀 The Solution

EchoLog is a real-time developer experience (DevEx) intelligence platform. It:

1. **Captures** verbal developer conversations via the [Bee AI Wearable](https://www.bee.computer/) (or a realistic simulator)
2. **Processes** raw transcripts through AWS Bedrock (Claude 3.5 Sonnet) to extract structured architectural decisions
3. **Injects** those decisions directly into VS Code as:
   - Beautiful sidebar decision cards
   - Inline phantom text decorators on relevant files
   - Exportable markdown documentation

**Zero friction. Zero tab-switching. Your conversations become your documentation.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       EchoLog System                            │
│                                                                 │
│   🎙️ Bee Wearable AI        📟 Simulator (15s intervals)       │
│        │                              │                         │
│        └──────────┬───────────────────┘                         │
│                   │ POST /webhook/bee-stream                     │
│                   ▼                                             │
│   ┌──────────────────────────────────┐                          │
│   │   Gateway (Node.js + Express)    │ HTTP :8080               │
│   │   - WebSocket Server             │ WS   :8081               │
│   │   - Bee Stream Router            │                          │
│   │   - VS Code Broadcaster          │                          │
│   └──────────────┬───────────────────┘                          │
│                  │ POST /process                                 │
│                  ▼                                              │
│   ┌──────────────────────────────────┐                          │
│   │   AI Engine (FastAPI + Python)   │ HTTP :5000               │
│   │   - AWS Bedrock (Claude 3.5)     │                          │
│   │   - DecisionExtraction Schema    │                          │
│   │   - Mock Fallback Mode           │                          │
│   └──────────────┬───────────────────┘                          │
│                  │ POST /internal/broadcast                      │
│                  ▼                                              │
│   ┌──────────────────────────────────┐                          │
│   │   Gateway → WebSocket Broadcast  │                          │
│   └──────────────┬───────────────────┘                          │
│                  │ ws://localhost:8081                           │
│                  ▼                                              │
│   ┌──────────────────────────────────┐                          │
│   │   VS Code Extension              │                          │
│   │   ├── Sidebar Webview Panel      │                          │
│   │   ├── Inline Code Decorators     │                          │
│   │   └── Markdown Export            │                          │
│   └──────────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### Extracted Decision Schema

```json
{
  "id": "uuid-v4",
  "timestamp": "2024-01-15T10:30:00Z",
  "category": "Architecture | Bug | Action Item | Security | Performance",
  "topic": "Redis Auth Session Cache",
  "summary": "Team decided to replace in-memory session store with Redis Cluster.",
  "decision": "Use Redis Cluster for auth session caching; update auth service config.",
  "target_file": "auth.ts",
  "confidence": 0.92,
  "session_id": "session-alpha"
}
```

---

## 📦 Project Structure

```
echolog/
├── package.json              # Root orchestrator (concurrently)
├── README.md
├── LICENSE
│
├── gateway/                  # Node.js Event Gateway
│   ├── package.json
│   ├── server.js             # Express + WebSocket server
│   └── simulator.js          # Bee Wearable stream simulator
│
├── ai_engine/                # Python FastAPI AI Engine
│   ├── main.py               # FastAPI + Bedrock/mock pipeline
│   ├── requirements.txt
│   └── .env.example          # Copy to .env with your AWS keys
│
└── vscode-ext/               # VS Code Extension (TypeScript)
    ├── package.json          # Extension manifest
    ├── tsconfig.json
    ├── webpack.config.js
    ├── src/
    │   └── extension.ts      # Main extension source
    ├── media/
    │   └── echolog-icon.svg
    └── .vscode/
        ├── launch.json       # F5 debug config
        └── tasks.json        # Build task
```

---

## ⚡ Quick Start

### Prerequisites

- **Node.js** ≥ 18 ([download](https://nodejs.org/))
- **Python** ≥ 3.10 ([download](https://www.python.org/))
- **VS Code** ≥ 1.85 ([download](https://code.visualstudio.com/))

### Step 1: Clone and Install Dependencies

```bash
git clone https://github.com/your-org/echolog.git
cd echolog

# Install all dependencies (Node + Python)
npm install
npm run install:all
```

### Step 2: Configure Environment (Optional — for live AWS)

```bash
cd ai_engine
cp .env.example .env
# Edit .env and paste your AWS credentials
# If you skip this, mock mode activates automatically ✅
```

### Step 3: Start All Services

```bash
# From the echolog/ root
npm run dev
```

This starts:
- 🟢 **Gateway** — HTTP `:8080`, WebSocket `:8081`
- 🟢 **AI Engine** — HTTP `:5000`
- 🎙️ **Simulator** fires its first chunk after 2 seconds, then every 15 seconds

### Step 4: Launch the VS Code Extension

```bash
cd vscode-ext
npm install
npm run watch   # Start webpack in watch mode (keep this running)
```

Then in VS Code:
1. Open the `vscode-ext/` folder
2. Press **F5** to launch the Extension Development Host
3. Look for the **🎙️ icon** in the Activity Bar
4. Click it to open the **EchoLog Live Decisions** panel

Within 15 seconds of starting the backend, a decision card will appear in the panel!

---

## 🔑 AWS Bedrock Setup

### 1. Enable Model Access

1. Sign in to [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **Amazon Bedrock → Model access**
3. Enable **Anthropic Claude 3.5 Sonnet** (`anthropic.claude-3-5-sonnet-20241022-v2:0`)

### 2. Create IAM Credentials

Create an IAM user with the following policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0"
    }
  ]
}
```

### 3. Add to `.env`

```env
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

> **💡 No AWS account?** EchoLog automatically uses **Mock Mode** — a deterministic corpus of 8 pre-built decisions that cycle through the same pipeline. The demo is 100% functional without any cloud credentials.

---

## 🎛️ VS Code Extension

### Panel Features

| Feature | Description |
|---|---|
| 🃏 **Decision Cards** | Color-coded by category with confidence bars |
| 📊 **Stats Bar** | Live counts per category |
| 🔴 **Live Status Pill** | Animated dot shows gateway connection state |
| 🔄 **Auto-Reconnect** | Exponential backoff (1s→2s→4s→…30s cap) |
| 📄 **Export MD** | One-click export to `.echolog-history.md` |
| 🗑️ **Clear** | Wipe session without restarting |

### Inline Decorators

When a decision's `target_file` matches your currently open editor, EchoLog injects inline phantom text:

```
// auth.ts
export class AuthService {    🏗️ EchoLog [Architecture]: Replace in-memory store with Redis Cluster for horizontal scalability.
```

### Extension Settings

| Setting | Default | Description |
|---|---|---|
| `echolog.gatewayUrl` | `ws://localhost:8081` | WebSocket gateway URL |
| `echolog.autoConnect` | `true` | Auto-connect on startup |
| `echolog.showInlineDecorations` | `true` | Toggle inline decorators |
| `echolog.maxDecisions` | `100` | Max decisions in memory |

---

## 🧪 API Reference

### Gateway — `http://localhost:8080`

| Endpoint | Method | Description |
|---|---|---|
| `/webhook/bee-stream` | `POST` | Receive transcript chunk from wearable |
| `/internal/broadcast` | `POST` | Receive structured decision from AI Engine; broadcast to VS Code |
| `/health` | `GET` | Health check + connected client count |
| `/buffer` | `GET` | View raw transcript buffer |

### AI Engine — `http://localhost:5000`

| Endpoint | Method | Description |
|---|---|---|
| `/process` | `POST` | Process transcript → decision extraction |
| `/health` | `GET` | Health check + mode (live/mock) |
| `/docs` | `GET` | Auto-generated OpenAPI docs (Swagger UI) |

---

## 🗺️ Roadmap

- [ ] Real Bee MCP Wearable SDK integration
- [ ] Multi-speaker diarization (separate Alice's decisions from Bob's)
- [ ] Slack/Notion export connectors
- [ ] GitHub Issues auto-creation for Action Items
- [ ] VS Code Timeline integration
- [ ] Team session sharing (multiple developers see the same feed)
- [ ] Decision approval workflow (accept/reject before code injection)

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or pull request.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit: `git commit -m 'feat: add my feature'`
4. Push: `git push origin feat/my-feature`
5. Open a PR

---

## 📄 License

MIT © 2025 EchoLog Team. See [LICENSE](./LICENSE) for details.

---

<div align="center">
  <strong>Built with ❤️ for the Developer Experience Hackathon 2025</strong><br/>
  <em>Because great engineering decisions deserve to live in your IDE.</em>
</div>
