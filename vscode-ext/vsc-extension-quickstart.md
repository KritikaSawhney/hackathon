# Welcome to EchoLog VS Code Extension

## What's in the Box?

- **`src/extension.ts`** — The extension entry point. Contains the WebSocket client, sidebar WebviewViewProvider, inline decorator logic, and export command.
- **`package.json`** — Extension manifest. Defines commands, activity bar view, configuration schema.
- **`webpack.config.js`** — Bundles the TypeScript source to `dist/extension.js` for packaging.
- **`.vscode/launch.json`** — Lets you press **F5** to open a new Extension Development Host window.

## Get Up and Running

### 1. Install Dependencies

```bash
cd vscode-ext
npm install
```

### 2. Compile and Watch

```bash
npm run watch
```
This starts Webpack in watch mode and recompiles on every save.

### 3. Launch the Extension (F5)

Open the `vscode-ext/` folder in VS Code, then press **F5**. A new **Extension Development Host** window opens with EchoLog active.

### 4. Verify the Panel

Look for the **🎙️ microphone icon** in the Activity Bar on the left. Click it to open the **EchoLog Live Decisions** panel.

### 5. Start the Full Stack

In a separate terminal from the project root:

```bash
npm run dev
```

This starts:
- **Gateway** on HTTP `8080` and WS `8081`
- **AI Engine** on `5000`
- **Simulator** fires every 15 seconds automatically

Within 15 seconds, the first decision card will appear in the EchoLog panel.

## Commands

| Command | Description |
|---|---|
| `EchoLog: Export Decisions to Markdown` | Writes `.echolog-history.md` to workspace root |
| `EchoLog: Connect to Gateway` | Manually reconnect to WS gateway |
| `EchoLog: Disconnect from Gateway` | Close the WS connection |
| `EchoLog: Clear All Decisions` | Wipe current session data |

## Architecture

```
Bee Wearable or Simulator
        │ POST /webhook/bee-stream
        ▼
  Gateway (port 8080 HTTP)
        │ POST /process
        ▼
  AI Engine (port 5000)
   └─ AWS Bedrock (or mock fallback)
        │ POST /internal/broadcast
        ▼
  Gateway (port 8080 HTTP)
        │ WebSocket broadcast
        ▼
  VS Code Extension (WS client)
   ├─ Sidebar Cards
   ├─ Inline Decorators
   └─ Markdown Export
```

## Troubleshooting

- **No cards appearing?** Check the EchoLog output channel (`View → Output → EchoLog`) for connection errors.
- **Webpack errors?** Make sure `npm install` completed without errors and Node.js ≥ 18 is installed.
- **Extension not activating?** The `activationEvents: ["onStartupFinished"]` means it waits until VS Code is fully loaded. It should auto-connect within ~2 seconds.
