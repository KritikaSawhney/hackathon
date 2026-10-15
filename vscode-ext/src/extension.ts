/**
 * EchoLog VS Code Extension — extension.ts
 *
 * Features:
 *   A) Sidebar Webview (EchoLog Panel) — renders decisions as styled cards
 *   B) Inline Code Decorators — phantom text on matching open files
 *   C) Markdown Export Command — writes .echolog-history.md to workspace root
 *
 * WebSocket auto-reconnect with exponential backoff is fully implemented.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as WebSocket from 'ws';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface DecisionExtraction {
  id: string;
  timestamp: string;
  category: 'Architecture' | 'Bug' | 'Action Item' | 'Security' | 'Performance';
  topic: string;
  summary: string;
  decision: string;
  target_file: string | null;
  confidence: number;
  raw_source_preview: string;
  session_id?: string;
  type?: string;
}

interface GatewayHandshake {
  type: 'handshake';
  message: string;
  timestamp: string;
}

type GatewayMessage = DecisionExtraction | GatewayHandshake;

// ─────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────

let wsClient: WebSocket | null = null;
let reconnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_DELAY_MS = 1000;

const sessionDecisions: DecisionExtraction[] = [];
let echoLogPanel: EchoLogPanelProvider | null = null;

// Decoration type for inline phantom text
let decorationType: vscode.TextEditorDecorationType | null = null;

// Status bar item
let statusBarItem: vscode.StatusBarItem;

// Output channel for diagnostics
let outputChannel: vscode.OutputChannel;

// ─────────────────────────────────────────────
// Extension Entry Point
// ─────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('EchoLog');
  outputChannel.appendLine('EchoLog extension activating...');

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(sync~spin) EchoLog: Connecting...';
  statusBarItem.tooltip = 'EchoLog — Connecting to Gateway';
  statusBarItem.command = 'echolog.connectGateway';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Decorator type for inline phantom text
  decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      fontStyle: 'italic',
    },
    isWholeLine: false,
  });
  context.subscriptions.push(decorationType);

  // Register Webview Panel Provider
  echoLogPanel = new EchoLogPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('echolog.panel', echoLogPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('echolog.exportDecisions', exportDecisionsToMarkdown),
    vscode.commands.registerCommand('echolog.connectGateway', () => {
      reconnectAttempts = 0;
      connectWebSocket();
    }),
    vscode.commands.registerCommand('echolog.disconnectGateway', disconnectWebSocket),
    vscode.commands.registerCommand('echolog.clearDecisions', () => {
      sessionDecisions.length = 0;
      echoLogPanel?.refresh([]);
      clearDecorations();
      vscode.window.showInformationMessage('EchoLog: All decisions cleared.');
      outputChannel.appendLine('[EchoLog] Session decisions cleared.');
    })
  );

  // Auto-connect if configured
  const config = vscode.workspace.getConfiguration('echolog');
  if (config.get<boolean>('autoConnect', true)) {
    connectWebSocket();
  } else {
    setStatusBar('disconnected');
  }

  // Re-apply decorators when the active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        applyDecorationsToEditor(editor);
      }
    })
  );

  outputChannel.appendLine('EchoLog extension activated successfully.');
}

export function deactivate(): void {
  disconnectWebSocket();
  outputChannel?.appendLine('EchoLog extension deactivated.');
}

// ─────────────────────────────────────────────
// WebSocket Management
// ─────────────────────────────────────────────

function getGatewayUrl(): string {
  const config = vscode.workspace.getConfiguration('echolog');
  return config.get<string>('gatewayUrl', 'ws://localhost:8081');
}

function connectWebSocket(): void {
  if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
    outputChannel.appendLine('[WS] Already connected or connecting, skipping.');
    return;
  }

  const url = getGatewayUrl();
  outputChannel.appendLine(`[WS] Connecting to ${url} (attempt ${reconnectAttempts + 1})...`);
  setStatusBar('connecting');

  try {
    wsClient = new WebSocket(url);
  } catch (err) {
    outputChannel.appendLine(`[WS] Failed to create WebSocket: ${err}`);
    scheduleReconnect();
    return;
  }

  wsClient.on('open', () => {
    outputChannel.appendLine(`[WS] ✓ Connected to EchoLog Gateway at ${url}`);
    reconnectAttempts = 0;
    setStatusBar('connected');
    // Send a ready signal
    wsClient?.send(JSON.stringify({ type: 'vscode_client_ready', version: '1.0.0' }));
  });

  wsClient.on('message', (data: WebSocket.RawData) => {
    try {
      const raw = data.toString();
      const parsed: GatewayMessage = JSON.parse(raw);

      if ('type' in parsed && parsed.type === 'handshake') {
        outputChannel.appendLine(`[WS] Handshake received: ${(parsed as GatewayHandshake).message}`);
        return;
      }

      // It's a DecisionExtraction
      const decision = parsed as DecisionExtraction;
      handleIncomingDecision(decision);

    } catch (parseErr) {
      outputChannel.appendLine(`[WS] Failed to parse message: ${parseErr}`);
    }
  });

  wsClient.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason?.toString() || 'no reason';
    outputChannel.appendLine(`[WS] Connection closed (code: ${code}, reason: ${reasonStr})`);
    setStatusBar('disconnected');
    wsClient = null;
    scheduleReconnect();
  });

  wsClient.on('error', (err: Error) => {
    outputChannel.appendLine(`[WS] Error: ${err.message}`);
    // 'close' event will fire after error, triggering reconnect
  });
}

function disconnectWebSocket(): void {
  if (reconnectTimeoutHandle) {
    clearTimeout(reconnectTimeoutHandle);
    reconnectTimeoutHandle = null;
  }
  if (wsClient) {
    wsClient.removeAllListeners();
    wsClient.close(1000, 'User disconnected');
    wsClient = null;
  }
  setStatusBar('disconnected');
  outputChannel.appendLine('[WS] Manually disconnected from Gateway.');
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    outputChannel.appendLine(
      `[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`
    );
    setStatusBar('error');
    vscode.window.showWarningMessage(
      'EchoLog: Could not connect to Gateway after many attempts. Use "EchoLog: Connect to Gateway" to retry.',
      'Retry'
    ).then((choice) => {
      if (choice === 'Retry') {
        reconnectAttempts = 0;
        connectWebSocket();
      }
    });
    return;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s cap
  const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  outputChannel.appendLine(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
  setStatusBar('reconnecting', reconnectAttempts);

  reconnectTimeoutHandle = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

// ─────────────────────────────────────────────
// Decision Handling
// ─────────────────────────────────────────────

function handleIncomingDecision(decision: DecisionExtraction): void {
  const config = vscode.workspace.getConfiguration('echolog');
  const maxDecisions = config.get<number>('maxDecisions', 100);

  // Add to session store
  sessionDecisions.unshift(decision); // prepend so newest is first
  if (sessionDecisions.length > maxDecisions) {
    sessionDecisions.splice(maxDecisions);
  }

  outputChannel.appendLine(
    `[EchoLog] New decision: [${decision.category}] "${decision.topic}" → target: ${decision.target_file || 'none'}`
  );

  // Update sidebar
  echoLogPanel?.addDecision(decision);

  // Feature B: Inline Decorators
  if (config.get<boolean>('showInlineDecorations', true) && decision.target_file) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const activeFileName = path.basename(activeEditor.document.fileName);
      if (
        activeFileName.toLowerCase() === decision.target_file.toLowerCase() ||
        activeEditor.document.fileName.toLowerCase().endsWith(
          decision.target_file.toLowerCase()
        )
      ) {
        applyDecoration(activeEditor, decision);
      }
    }
  }

  // Show notification for security/bug categories
  if (decision.category === 'Security' || decision.category === 'Bug') {
    vscode.window.showWarningMessage(
      `⚠️ EchoLog [${decision.category}]: ${decision.topic}`,
      'View Panel'
    ).then((choice) => {
      if (choice === 'View Panel') {
        vscode.commands.executeCommand('echolog.panel.focus');
      }
    });
  }
}

// ─────────────────────────────────────────────
// Feature B: Inline Code Decorators
// ─────────────────────────────────────────────

// Map from document URI → applied decorations to avoid duplicates
const appliedDecorations: Map<string, Set<string>> = new Map();

function applyDecoration(editor: vscode.TextEditor, decision: DecisionExtraction): void {
  if (!decorationType) {
    return;
  }

  const docUri = editor.document.uri.toString();
  if (!appliedDecorations.has(docUri)) {
    appliedDecorations.set(docUri, new Set());
  }

  const applied = appliedDecorations.get(docUri)!;
  if (applied.has(decision.id)) {
    return; // Already applied this decision to this file
  }

  // Find what line to inject on (line 0 = top of file)
  const insertLine = 0;
  const lineLength = editor.document.lineAt(insertLine).text.length;

  const range = new vscode.Range(
    new vscode.Position(insertLine, lineLength),
    new vscode.Position(insertLine, lineLength)
  );

  const categoryEmoji: Record<string, string> = {
    Architecture: '🏗️',
    Bug: '🐛',
    'Action Item': '✅',
    Security: '🔒',
    Performance: '⚡',
  };
  const emoji = categoryEmoji[decision.category] || '💡';

  const decorationOptions: vscode.DecorationOptions = {
    range,
    renderOptions: {
      after: {
        contentText: `  ${emoji} EchoLog [${decision.category}]: ${decision.summary}`,
        color: getCategoryColor(decision.category),
        fontStyle: 'italic',
        fontWeight: 'normal',
      },
    },
    hoverMessage: new vscode.MarkdownString(
      `**EchoLog Decision**\n\n` +
        `- **Category:** ${decision.category}\n` +
        `- **Topic:** ${decision.topic}\n` +
        `- **Summary:** ${decision.summary}\n` +
        `- **Decision:** ${decision.decision}\n` +
        `- **Confidence:** ${Math.round(decision.confidence * 100)}%\n` +
        `- **Captured:** ${new Date(decision.timestamp).toLocaleString()}`
    ),
  };

  // Collect all current decorations for this file + add new one
  const allDecorations: vscode.DecorationOptions[] = [];
  // Re-apply all existing for this doc
  sessionDecisions
    .filter(
      (d) =>
        d.target_file &&
        editor.document.fileName.toLowerCase().endsWith(d.target_file.toLowerCase())
    )
    .forEach((d, i) => {
      if (d.id !== decision.id) {
        const ln = Math.min(i, editor.document.lineCount - 1);
        const existingRange = new vscode.Range(
          new vscode.Position(ln, editor.document.lineAt(ln).text.length),
          new vscode.Position(ln, editor.document.lineAt(ln).text.length)
        );
        allDecorations.push({
          range: existingRange,
          renderOptions: {
            after: {
              contentText: `  ${categoryEmoji[d.category] || '💡'} EchoLog [${d.category}]: ${d.summary}`,
              color: getCategoryColor(d.category),
              fontStyle: 'italic',
            },
          },
        });
      }
    });

  allDecorations.push(decorationOptions);
  editor.setDecorations(decorationType, allDecorations);
  applied.add(decision.id);
}

function applyDecorationsToEditor(editor: vscode.TextEditor): void {
  const config = vscode.workspace.getConfiguration('echolog');
  if (!config.get<boolean>('showInlineDecorations', true)) {
    return;
  }
  if (!decorationType) {
    return;
  }

  const relevantDecisions = sessionDecisions.filter(
    (d) =>
      d.target_file &&
      editor.document.fileName.toLowerCase().endsWith(d.target_file.toLowerCase())
  );

  if (relevantDecisions.length === 0) {
    return;
  }

  const categoryEmoji: Record<string, string> = {
    Architecture: '🏗️',
    Bug: '🐛',
    'Action Item': '✅',
    Security: '🔒',
    Performance: '⚡',
  };

  const decorations: vscode.DecorationOptions[] = relevantDecisions.map((d, i) => {
    const ln = Math.min(i, editor.document.lineCount - 1);
    const lineLen = editor.document.lineAt(ln).text.length;
    const range = new vscode.Range(
      new vscode.Position(ln, lineLen),
      new vscode.Position(ln, lineLen)
    );
    const emoji = categoryEmoji[d.category] || '💡';
    return {
      range,
      renderOptions: {
        after: {
          contentText: `  ${emoji} EchoLog [${d.category}]: ${d.summary}`,
          color: getCategoryColor(d.category),
          fontStyle: 'italic',
        },
      },
      hoverMessage: new vscode.MarkdownString(
        `**EchoLog Decision**\n\n` +
          `- **Category:** ${d.category}\n` +
          `- **Topic:** ${d.topic}\n` +
          `- **Decision:** ${d.decision}\n` +
          `- **Confidence:** ${Math.round(d.confidence * 100)}%`
      ),
    };
  });

  editor.setDecorations(decorationType, decorations);
}

function clearDecorations(): void {
  appliedDecorations.clear();
  vscode.window.visibleTextEditors.forEach((editor) => {
    if (decorationType) {
      editor.setDecorations(decorationType, []);
    }
  });
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    Architecture: 'new ThemeColor("charts.blue")',
    Bug: '#FF6B6B',
    'Action Item': '#51CF66',
    Security: '#FFD43B',
    Performance: '#FF922B',
  };
  return colors[category] || '#9775FA';
}

// ─────────────────────────────────────────────
// Feature C: Markdown Export
// ─────────────────────────────────────────────

async function exportDecisionsToMarkdown(): Promise<void> {
  if (sessionDecisions.length === 0) {
    vscode.window.showInformationMessage('EchoLog: No decisions captured yet in this session.');
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('EchoLog: No workspace folder open to export to.');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const exportPath = path.join(workspaceRoot, '.echolog-history.md');

  const categoryEmoji: Record<string, string> = {
    Architecture: '🏗️',
    Bug: '🐛',
    'Action Item': '✅',
    Security: '🔒',
    Performance: '⚡',
  };

  const lines: string[] = [
    `# 🎙️ EchoLog — Session Decisions`,
    ``,
    `> Generated by **EchoLog** on ${new Date().toLocaleString()}  `,
    `> Total decisions captured: **${sessionDecisions.length}**`,
    ``,
    `---`,
    ``,
  ];

  // Group by category
  const grouped = new Map<string, DecisionExtraction[]>();
  for (const d of sessionDecisions) {
    if (!grouped.has(d.category)) {
      grouped.set(d.category, []);
    }
    grouped.get(d.category)!.push(d);
  }

  for (const [category, decisions] of grouped.entries()) {
    const emoji = categoryEmoji[category] || '💡';
    lines.push(`## ${emoji} ${category}`);
    lines.push('');

    for (const d of decisions) {
      lines.push(`### ${d.topic}`);
      lines.push('');
      lines.push(`| Field | Value |`);
      lines.push(`|---|---|`);
      lines.push(`| **Timestamp** | \`${new Date(d.timestamp).toLocaleString()}\` |`);
      lines.push(`| **Summary** | ${d.summary} |`);
      lines.push(`| **Decision** | ${d.decision} |`);
      lines.push(`| **Target File** | ${d.target_file ? `\`${d.target_file}\`` : '—'} |`);
      lines.push(`| **Confidence** | ${Math.round(d.confidence * 100)}% |`);
      lines.push(`| **Session** | ${d.session_id || 'default'} |`);
      if (d.raw_source_preview) {
        lines.push(`| **Source Preview** | *"${d.raw_source_preview.replace(/\|/g, '\\|')}"* |`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  lines.push(
    `*This file was auto-generated by the EchoLog VS Code Extension.*  `,
    `*[EchoLog Repository](https://github.com/echolog-team/echolog)*`
  );

  const content = lines.join('\n');

  try {
    fs.writeFileSync(exportPath, content, 'utf8');
    outputChannel.appendLine(`[EchoLog] Exported ${sessionDecisions.length} decisions to ${exportPath}`);

    const choice = await vscode.window.showInformationMessage(
      `✅ EchoLog: Exported ${sessionDecisions.length} decisions to .echolog-history.md`,
      'Open File'
    );
    if (choice === 'Open File') {
      const doc = await vscode.workspace.openTextDocument(exportPath);
      await vscode.window.showTextDocument(doc);
    }

    // Notify the webview
    echoLogPanel?.notifyExport(exportPath);

    // Notify Gateway
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ type: 'export_ack', filepath: exportPath }));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`EchoLog: Failed to export: ${errMsg}`);
    outputChannel.appendLine(`[EchoLog] Export error: ${errMsg}`);
  }
}

// ─────────────────────────────────────────────
// Status Bar Helper
// ─────────────────────────────────────────────

function setStatusBar(
  state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'error',
  attempt?: number
): void {
  switch (state) {
    case 'connected':
      statusBarItem.text = '$(radio-tower) EchoLog: Live';
      statusBarItem.tooltip = 'EchoLog — Connected to Gateway. Click to manage.';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.command = 'echolog.disconnectGateway';
      break;
    case 'connecting':
      statusBarItem.text = '$(sync~spin) EchoLog: Connecting...';
      statusBarItem.tooltip = 'EchoLog — Connecting to Gateway...';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.command = undefined;
      break;
    case 'reconnecting':
      statusBarItem.text = `$(sync~spin) EchoLog: Reconnecting (${attempt})...`;
      statusBarItem.tooltip = `EchoLog — Reconnecting (attempt ${attempt})`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.command = 'echolog.connectGateway';
      break;
    case 'disconnected':
      statusBarItem.text = '$(debug-disconnect) EchoLog: Offline';
      statusBarItem.tooltip = 'EchoLog — Not connected. Click to connect.';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.command = 'echolog.connectGateway';
      break;
    case 'error':
      statusBarItem.text = '$(error) EchoLog: Error';
      statusBarItem.tooltip = 'EchoLog — Connection failed. Click to retry.';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      statusBarItem.command = 'echolog.connectGateway';
      break;
  }
}

// ─────────────────────────────────────────────
// Webview Panel Provider (Feature A)
// ─────────────────────────────────────────────

class EchoLogPanelProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'export':
          vscode.commands.executeCommand('echolog.exportDecisions');
          break;
        case 'clear':
          vscode.commands.executeCommand('echolog.clearDecisions');
          break;
        case 'connect':
          vscode.commands.executeCommand('echolog.connectGateway');
          break;
        case 'open_file':
          if (message.filename) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
              // Search for the file in the workspace
              vscode.workspace.findFiles(`**/${message.filename}`, '**/node_modules/**', 1).then((uris) => {
                if (uris.length > 0) {
                  vscode.window.showTextDocument(uris[0]);
                } else {
                  vscode.window.showWarningMessage(`EchoLog: File "${message.filename}" not found in workspace.`);
                }
              });
            }
          }
          break;
        case 'ready':
          // Webview is ready — send all existing decisions
          if (sessionDecisions.length > 0) {
            this._view?.webview.postMessage({
              type: 'bulk_decisions',
              decisions: sessionDecisions,
            });
          }
          break;
      }
    });
  }

  public addDecision(decision: DecisionExtraction): void {
    if (this._view) {
      this._view.webview.postMessage({ type: 'decision', decision });
      // Reveal panel on first decision
      if (sessionDecisions.length === 1) {
        this._view.show(true);
      }
    }
  }

  public refresh(decisions: DecisionExtraction[]): void {
    if (this._view) {
      this._view.webview.postMessage({ type: 'bulk_decisions', decisions });
    }
  }

  public notifyExport(filepath: string): void {
    if (this._view) {
      this._view.webview.postMessage({ type: 'export_done', filepath });
    }
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>EchoLog Panel</title>
  <style>
    /* ── Reset & Base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --gap: 10px;
      --radius: 8px;
      --radius-sm: 4px;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0;
      overflow-x: hidden;
    }

    /* ── Header ── */
    .header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      padding: 10px 12px 8px;
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.02em;
      color: var(--vscode-editor-foreground);
    }

    .logo-icon { font-size: 16px; }

    .badge {
      background: var(--vscode-badge-background, #0078d4);
      color: var(--vscode-badge-foreground, #fff);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 10px;
      min-width: 18px;
      text-align: center;
      display: inline-block;
    }

    /* ── Status Pill ── */
    .status-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 10px;
      border: 1px solid;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      transition: all 0.3s ease;
    }

    .status-pill.connected {
      background: rgba(81, 207, 102, 0.12);
      color: #51CF66;
      border-color: rgba(81, 207, 102, 0.3);
    }

    .status-pill.connecting {
      background: rgba(255, 212, 59, 0.12);
      color: #FFD43B;
      border-color: rgba(255, 212, 59, 0.3);
    }

    .status-pill.disconnected {
      background: rgba(255, 107, 107, 0.12);
      color: #FF6B6B;
      border-color: rgba(255, 107, 107, 0.3);
    }

    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .connected .status-dot {
      animation: pulse-dot 1.5s ease infinite;
      box-shadow: 0 0 0 0 rgba(81, 207, 102, 0.5);
    }

    @keyframes pulse-dot {
      0% { box-shadow: 0 0 0 0 rgba(81, 207, 102, 0.5); }
      70% { box-shadow: 0 0 0 6px rgba(81, 207, 102, 0); }
      100% { box-shadow: 0 0 0 0 rgba(81, 207, 102, 0); }
    }

    /* ── Action Buttons ── */
    .actions {
      display: flex;
      gap: 6px;
    }

    .btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--vscode-button-border, transparent);
      font-family: var(--vscode-font-family);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s ease, transform 0.1s ease, opacity 0.2s ease;
      white-space: nowrap;
    }

    .btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
    .btn:active { transform: translateY(0); filter: brightness(0.9); }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.07));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
    }

    /* ── Stats Bar ── */
    .stats-bar {
      display: flex;
      gap: 12px;
      padding: 6px 12px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.04));
      border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
      font-size: 10px;
      letter-spacing: 0.02em;
    }

    .stat-item {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
    }

    .stat-item span.value {
      color: var(--vscode-editor-foreground);
      font-weight: 700;
    }

    /* ── Decision Feed ── */
    .feed {
      padding: 8px;
      overflow-y: auto;
    }

    /* ── Empty State ── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 40px 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .empty-icon { font-size: 40px; opacity: 0.6; }
    .empty-title { font-size: 13px; font-weight: 700; color: var(--vscode-editor-foreground); }
    .empty-desc { font-size: 11px; line-height: 1.5; opacity: 0.8; }

    /* ── Decision Card ── */
    .card {
      border-radius: var(--radius);
      border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
      background: var(--vscode-editor-background);
      margin-bottom: 8px;
      overflow: hidden;
      transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.3s ease;
      animation: card-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }

    @keyframes card-in {
      from { opacity: 0; transform: translateY(12px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    }

    /* ── Card Header ── */
    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-left: 3px solid var(--cat-color);
    }

    .category-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 6px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--cat-color) 15%, transparent);
      color: var(--cat-color);
      border: 1px solid color-mix(in srgb, var(--cat-color) 30%, transparent);
      white-space: nowrap;
    }

    .card-topic {
      flex: 1;
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-editor-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .confidence-bar-wrap {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 52px;
    }

    .confidence-track {
      flex: 1;
      height: 3px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px;
      overflow: hidden;
    }

    .confidence-fill {
      height: 100%;
      border-radius: 2px;
      background: var(--cat-color);
      transition: width 0.6s ease;
    }

    .confidence-label {
      font-size: 9px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      min-width: 24px;
      text-align: right;
    }

    /* ── Card Body ── */
    .card-body {
      padding: 8px 10px;
    }

    .summary-text {
      font-size: 11px;
      line-height: 1.5;
      color: var(--vscode-editor-foreground);
      margin-bottom: 6px;
    }

    .decision-box {
      background: color-mix(in srgb, var(--cat-color) 8%, var(--vscode-editor-background));
      border-left: 2px solid var(--cat-color);
      padding: 6px 8px;
      border-radius: 0 4px 4px 0;
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--vscode-editor-foreground);
      margin-bottom: 6px;
    }

    .decision-label {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--cat-color);
      margin-bottom: 2px;
    }

    /* ── Card Footer ── */
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 10px;
      background: rgba(0,0,0,0.1);
      border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
    }

    .file-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      transition: background 0.15s ease;
    }

    .file-chip:hover {
      background: rgba(255,255,255,0.08);
      text-decoration: underline;
    }

    .timestamp {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }

    /* ── Toast ── */
    .toast {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(40px);
      background: var(--vscode-notificationCenterHeader-background, #1e1e1e);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius);
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      z-index: 1000;
      pointer-events: none;
      white-space: nowrap;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div class="header-top">
      <div class="logo">
        <span class="logo-icon">🎙️</span>
        <span>EchoLog</span>
        <span class="badge" id="decision-count">0</span>
      </div>
      <div class="status-pill disconnected" id="status-pill">
        <div class="status-dot"></div>
        <span id="status-label">Offline</span>
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" id="btn-export" onclick="exportMd()">
        📄 Export MD
      </button>
      <button class="btn btn-secondary" id="btn-clear" onclick="clearAll()">
        🗑️ Clear
      </button>
    </div>
  </div>

  <!-- Stats Bar -->
  <div class="stats-bar" id="stats-bar" style="display:none">
    <div class="stat-item">🏗️ Arch: <span class="value" id="stat-arch">0</span></div>
    <div class="stat-item">🐛 Bugs: <span class="value" id="stat-bug">0</span></div>
    <div class="stat-item">🔒 Sec: <span class="value" id="stat-sec">0</span></div>
    <div class="stat-item">⚡ Perf: <span class="value" id="stat-perf">0</span></div>
    <div class="stat-item">✅ Act: <span class="value" id="stat-action">0</span></div>
  </div>

  <!-- Decision Feed -->
  <div class="feed" id="feed">
    <div class="empty-state" id="empty-state">
      <div class="empty-icon">🎙️</div>
      <div class="empty-title">Listening for conversations...</div>
      <div class="empty-desc">
        EchoLog will display architectural decisions here<br/>
        as they are extracted from your verbal team discussions.
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ── State ──
    const decisions = [];
    const stats = { Architecture: 0, Bug: 0, Security: 0, Performance: 0, 'Action Item': 0 };

    // ── Category Config ──
    const CAT_CONFIG = {
      'Architecture': { color: '#74C0FC', emoji: '🏗️' },
      'Bug':          { color: '#FF6B6B', emoji: '🐛' },
      'Security':     { color: '#FFD43B', emoji: '🔒' },
      'Performance':  { color: '#FF922B', emoji: '⚡' },
      'Action Item':  { color: '#51CF66', emoji: '✅' },
    };

    function getCatColor(cat) {
      return CAT_CONFIG[cat]?.color || '#9775FA';
    }

    function getCatEmoji(cat) {
      return CAT_CONFIG[cat]?.emoji || '💡';
    }

    // ── Render Decision Card ──
    function renderCard(d) {
      const catColor = getCatColor(d.category);
      const catEmoji = getCatEmoji(d.category);
      const confPct = Math.round((d.confidence || 0.85) * 100);
      const timeStr = new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const fileFooter = d.target_file
        ? \`<span class="file-chip" onclick="openFile('\${escapeHtml(d.target_file)}')">
              📄 \${escapeHtml(d.target_file)}
           </span>\`
        : \`<span class="file-chip" style="opacity:0.4; cursor:default;">📄 No target file</span>\`;

      const card = document.createElement('div');
      card.className = 'card';
      card.id = 'card-' + d.id;
      card.style.setProperty('--cat-color', catColor);
      card.innerHTML = \`
        <div class="card-header">
          <span class="category-badge">\${catEmoji} \${escapeHtml(d.category)}</span>
          <span class="card-topic" title="\${escapeHtml(d.topic)}">\${escapeHtml(d.topic)}</span>
          <div class="confidence-bar-wrap">
            <div class="confidence-track">
              <div class="confidence-fill" style="width:\${confPct}%"></div>
            </div>
            <span class="confidence-label">\${confPct}%</span>
          </div>
        </div>
        <div class="card-body">
          <p class="summary-text">\${escapeHtml(d.summary)}</p>
          <div class="decision-box">
            <div class="decision-label">Decision</div>
            \${escapeHtml(d.decision)}
          </div>
        </div>
        <div class="card-footer">
          \${fileFooter}
          <span class="timestamp">\${timeStr}</span>
        </div>
      \`;
      return card;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function updateStatsBar() {
      const total = decisions.length;
      document.getElementById('decision-count').textContent = total;
      document.getElementById('stat-arch').textContent = stats['Architecture'] || 0;
      document.getElementById('stat-bug').textContent = stats['Bug'] || 0;
      document.getElementById('stat-sec').textContent = stats['Security'] || 0;
      document.getElementById('stat-perf').textContent = stats['Performance'] || 0;
      document.getElementById('stat-action').textContent = stats['Action Item'] || 0;

      const statsBar = document.getElementById('stats-bar');
      statsBar.style.display = total > 0 ? 'flex' : 'none';
    }

    function hideEmptyState() {
      const empty = document.getElementById('empty-state');
      if (empty) empty.remove();
    }

    function addDecisionToFeed(d, prepend = true) {
      hideEmptyState();

      // Track in local array
      if (prepend) {
        decisions.unshift(d);
      } else {
        decisions.push(d);
      }

      // Update stats
      if (d.category in stats) {
        stats[d.category]++;
      }

      // Render card
      const card = renderCard(d);
      const feed = document.getElementById('feed');
      if (prepend) {
        feed.insertBefore(card, feed.firstChild);
      } else {
        feed.appendChild(card);
      }

      updateStatsBar();
    }

    function openFile(filename) {
      vscode.postMessage({ type: 'open_file', filename });
    }

    function exportMd() {
      vscode.postMessage({ type: 'export' });
    }

    function clearAll() {
      decisions.length = 0;
      Object.keys(stats).forEach(k => stats[k] = 0);

      const feed = document.getElementById('feed');
      feed.innerHTML = '';
      feed.innerHTML = \`
        <div class="empty-state" id="empty-state">
          <div class="empty-icon">🎙️</div>
          <div class="empty-title">Listening for conversations...</div>
          <div class="empty-desc">EchoLog will display architectural decisions here<br/>as they are extracted from your verbal team discussions.</div>
        </div>\`;

      updateStatsBar();
      vscode.postMessage({ type: 'clear' });
    }

    // ── Toast ──
    let toastTimeout;
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // ── Status Pill ──
    function setStatus(state) {
      const pill = document.getElementById('status-pill');
      const label = document.getElementById('status-label');
      pill.className = 'status-pill ' + state;
      const labels = {
        connected: 'Live',
        connecting: 'Connecting',
        disconnected: 'Offline',
        reconnecting: 'Reconnecting',
        error: 'Error',
      };
      label.textContent = labels[state] || state;
    }

    // ── Message Handler ──
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'decision':
          addDecisionToFeed(msg.decision, true);
          showToast(\`💡 \${msg.decision.category}: \${msg.decision.topic}\`);
          break;
        case 'bulk_decisions':
          msg.decisions.forEach(d => addDecisionToFeed(d, false));
          break;
        case 'status':
          setStatus(msg.state);
          break;
        case 'export_done':
          showToast('✅ Exported to .echolog-history.md');
          break;
      }
    });

    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
