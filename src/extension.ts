import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { parseReports, StReport } from "./stParser";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ReportsProvider();
  const reportsView = vscode.window.createTreeView("stacktale.reports", { treeDataProvider: provider });
  provider.bindView(reportsView);
  context.subscriptions.push(
    reportsView,
    vscode.commands.registerCommand("stacktale.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("stacktale.openReport", (report: StReport) => openCulprit(report)),
    vscode.commands.registerCommand("stacktale.copyForAI", (item?: ReportItem) => copyForAI(item)),
  );

  // Live updates: the report file changes on every new error (and on rotation).
  const watcher = vscode.workspace.createFileSystemWatcher("**/errors-ai.log");
  watcher.onDidChange(() => provider.refresh());
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  // nothing to tear down — all disposables are in context.subscriptions
}

/** The configured path (relative to the workspace) or the first errors-ai.log in the workspace. */
async function locateLogFile(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  const configured = vscode.workspace.getConfiguration("stacktale").get<string>("file");
  if (configured && configured.trim() && folders && folders.length > 0) {
    return path.join(folders[0].uri.fsPath, configured.trim());
  }
  const found = await vscode.workspace.findFiles("**/errors-ai.log", "**/node_modules/**", 1);
  return found.length > 0 ? found[0].fsPath : undefined;
}

class ReportsProvider implements vscode.TreeDataProvider<ReportItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  private view?: vscode.TreeView<ReportItem>;
  readonly onDidChangeTreeData = this.changed.event;

  bindView(view: vscode.TreeView<ReportItem>): void {
    this.view = view;
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: ReportItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ReportItem[]> {
    const file = await locateLogFile();
    if (!file || !fs.existsSync(file)) {
      this.setDescription(undefined);
      return [ReportItem.note("No errors-ai.log in this workspace yet.")];
    }
    this.setDescription(vscode.workspace.asRelativePath(file, false));
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return [ReportItem.note("Could not read errors-ai.log.")];
    }
    const reports = parseReports(content).reverse(); // newest first
    if (reports.length === 0) {
      return [ReportItem.note("No error reports yet — the file has none.")];
    }
    return reports.map((r) => ReportItem.report(r));
  }

  private setDescription(description: string | undefined): void {
    if (this.view) {
      this.view.description = description;
    }
  }
}

class ReportItem extends vscode.TreeItem {
  readonly report?: StReport;

  private constructor(label: string, report?: StReport) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.report = report;
  }

  static note(text: string): ReportItem {
    const item = new ReportItem(text);
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }

  static report(report: StReport): ReportItem {
    const item = new ReportItem(report.headline || `#${report.id}`, report);
    item.description = report.timestamp;
    item.tooltip = report.culprit
      ? `#${report.id}\n${report.culprit.text}`
      : `#${report.id}`;
    item.contextValue = "report";
    item.iconPath = new vscode.ThemeIcon("bug");
    item.command = {
      command: "stacktale.openReport",
      title: "Open report",
      arguments: [report],
    };
    return item;
  }
}

/** Opens the culprit frame's source file at its line — the report already knows which line matters. */
async function openCulprit(report: StReport): Promise<void> {
  const culprit = report.culprit;
  if (!culprit) {
    vscode.window.showInformationMessage(`stacktale: report #${report.id} has no source frame to open.`);
    return;
  }
  // the report carries only "File.java:line", so resolve the file by name within the workspace
  const matches = await vscode.workspace.findFiles(`**/${culprit.file}`, "**/node_modules/**", 2);
  if (matches.length === 0) {
    vscode.window.showWarningMessage(`stacktale: could not find ${culprit.file} in this workspace.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(matches[0]);
  const editor = await vscode.window.showTextDocument(doc);
  const line = Math.max(0, culprit.line - 1);
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

/** Copies the full report block to the clipboard — ready to paste to an AI assistant. */
async function copyForAI(item?: ReportItem): Promise<void> {
  if (!item?.report) {
    return;
  }
  await vscode.env.clipboard.writeText(item.report.block);
  vscode.window.showInformationMessage(`stacktale: report #${item.report.id} copied — paste it to your AI.`);
}
