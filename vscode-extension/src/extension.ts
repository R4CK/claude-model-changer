import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface RouterStatus {
  timestamp: string;
  lastModel: string;
  score: number;
  level: string;
  confidence: number;
  category: string;
  contextUsage: number | null;
  budgetStatus: string;
  anomalyCount: number;
  anomalies: string[];
  apiLimitPercent: number | null;
  override: boolean;
  autoRouted: boolean;
  sessionModelCounts?: Record<string, number>;
  sessionPromptCount?: number;
}

interface SessionState {
  modelCounts?: Record<string, number>;
  subagentCounts?: Record<string, number>;
  promptCount?: number;
  sessionStart?: string;
}

let statusBarItem: vscode.StatusBarItem;
let watcher: fs.FSWatcher | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBarItem.command = 'claudeModelRouter.showDetails';
  statusBarItem.tooltip = 'Claude Model Router - Click for details';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeModelRouter.showDetails', showDetails),
    vscode.commands.registerCommand('claudeModelRouter.refresh', () => updateStatus())
  );

  // Initial update
  updateStatus();

  // Set up file watcher
  setupWatcher();

  // Periodic refresh as fallback
  const config = vscode.workspace.getConfiguration('claudeModelRouter');
  const interval = config.get<number>('refreshInterval', 2000);
  refreshInterval = setInterval(updateStatus, interval);

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeModelRouter')) {
        setupWatcher();
        if (refreshInterval) clearInterval(refreshInterval);
        const newInterval = vscode.workspace.getConfiguration('claudeModelRouter')
          .get<number>('refreshInterval', 2000);
        refreshInterval = setInterval(updateStatus, newInterval);
      }
    })
  );
}

function getStatusFilePath(): string | null {
  const config = vscode.workspace.getConfiguration('claudeModelRouter');
  const customPath = config.get<string>('statusFilePath', '');

  if (customPath) return customPath;

  // Look in workspace folders
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const statusPath = path.join(folder.uri.fsPath, 'logs', 'status.json');
      if (fs.existsSync(statusPath)) return statusPath;
    }
  }

  return null;
}

function setupWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  const statusPath = getStatusFilePath();
  if (!statusPath) return;

  const dir = path.dirname(statusPath);
  if (!fs.existsSync(dir)) return;

  try {
    watcher = fs.watch(dir, (event, filename) => {
      if (filename === 'status.json') {
        updateStatus();
      }
    });
  } catch (err) {
    // Fallback to interval-based polling
  }
}

function readStatus(): RouterStatus | null {
  const statusPath = getStatusFilePath();
  if (!statusPath || !fs.existsSync(statusPath)) return null;

  try {
    const content = fs.readFileSync(statusPath, 'utf8');
    return JSON.parse(content) as RouterStatus;
  } catch {
    return null;
  }
}

function updateStatus() {
  const status = readStatus();

  if (!status) {
    statusBarItem.text = '$(symbol-misc) Router: idle';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = '#888888';
    return;
  }

  // Check if status is stale (older than 5 minutes)
  const age = Date.now() - new Date(status.timestamp).getTime();
  if (age > 300000) {
    statusBarItem.text = '$(symbol-misc) Router: idle';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = '#888888';
    return;
  }

  // Model icon and color
  const modelColors: Record<string, string> = {
    haiku: '#10b981',   // green
    sonnet: '#3b82f6',  // blue
    opus: '#8b5cf6'     // purple
  };

  const color = modelColors[status.lastModel] || '#888888';
  let icon = '$(symbol-misc)';

  // Build status text
  let text = `${icon} ${status.lastModel}`;

  // Add score
  text += ` | ${status.score}/10`;

  // Add context usage if available
  if (status.contextUsage !== null) {
    text += ` | ${status.contextUsage}% ctx`;
  }

  // Add confidence
  text += ` | ${status.confidence}%`;

  // Add subagent count from session state
  const sessionState = readSessionState();
  if (sessionState && sessionState.subagentCounts) {
    const subTotal = (sessionState.subagentCounts.haiku || 0) +
      (sessionState.subagentCounts.sonnet || 0) +
      (sessionState.subagentCounts.opus || 0);
    if (subTotal > 0) text += ` | ${subTotal} sub`;
  }

  statusBarItem.text = text;
  statusBarItem.color = color;

  // Red background for anomalies
  if (status.anomalyCount > 0) {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (status.budgetStatus === 'warning') {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBarItem.backgroundColor = undefined;
  }
}

function readSessionState(): SessionState | null {
  const statusPath = getStatusFilePath();
  if (!statusPath) return null;
  const sessionPath = path.join(path.dirname(statusPath), 'session-state.json');
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

function showDetails() {
  const status = readStatus();

  if (!status) {
    vscode.window.showInformationMessage('Claude Model Router: No status data available. Run a prompt to generate status.');
    return;
  }

  const sessionState = readSessionState();
  const age = Math.round((Date.now() - new Date(status.timestamp).getTime()) / 1000);

  const subCounts = sessionState?.subagentCounts || {};
  const subTotal = (subCounts.haiku || 0) + (subCounts.sonnet || 0) + (subCounts.opus || 0);
  const subLine = subTotal > 0
    ? `Subagents: ${subTotal} (H:${subCounts.haiku || 0} S:${subCounts.sonnet || 0} O:${subCounts.opus || 0})`
    : 'Subagents: None';

  const details = [
    `Model: ${status.lastModel.toUpperCase()}`,
    `Score: ${status.score}/10 (${status.level})`,
    `Confidence: ${status.confidence}%`,
    `Category: ${status.category}`,
    `Context: ${status.contextUsage !== null ? status.contextUsage + '%' : 'N/A'}`,
    `Budget: ${status.budgetStatus}`,
    subLine,
    `Anomalies: ${status.anomalyCount > 0 ? status.anomalies.join(', ') : 'None'}`,
    `API Limits: ${status.apiLimitPercent !== null ? status.apiLimitPercent + '%' : 'N/A'}`,
    `Auto-routed: ${status.autoRouted ? 'Yes' : 'No'}`,
    `Session: ${sessionState?.promptCount || 0} prompts`,
    `Updated: ${age}s ago`
  ];

  vscode.window.showInformationMessage(
    `Claude Model Router Status\n${details.join(' | ')}`,
    'OK'
  );
}

export function deactivate() {
  if (watcher) watcher.close();
  if (refreshInterval) clearInterval(refreshInterval);
}
