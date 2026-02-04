#!/usr/bin/env bun

/**
 * Claude Code Hook: check-lint
 *
 * Runs linting after every N file edits and creates tasks for errors.
 *
 * Configuration priority:
 * 1. settings.json checkLintConfig (project or global)
 * 2. Environment variables (legacy)
 *
 * Config options:
 * - taskListId: task list for creating lint error tasks (default: auto-detect bugfixes list)
 * - lintCommand: lint command to run (default: auto-detect)
 * - editThreshold: run lint after this many edits (default: 3, range: 3-7)
 * - keywords: keywords that trigger the check (default: ["dev"])
 * - enabled: enable/disable the hook
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface CheckLintConfig {
  taskListId?: string;
  lintCommand?: string;
  editThreshold?: number;
  keywords?: string[];
  enabled?: boolean;
  createTasks?: boolean;
}

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
}

interface LintError {
  file: string;
  line: number;
  column: number;
  message: string;
  rule?: string;
  severity: "error" | "warning";
}

interface SessionState {
  editCount: number;
  editedFiles: string[];
  lastLintRun: number;
}

const CONFIG_KEY = "checkLintConfig";
const STATE_DIR = join(homedir(), ".claude", "hook-state");
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Allowed lint commands - whitelist approach for security
const ALLOWED_LINT_COMMANDS = [
  "bun lint",
  "bun lint:check",
  "bun eslint",
  "bun biome check",
  "bunx @biomejs/biome check .",
  "bunx eslint .",
  "npm run lint",
  "npm run lint:check",
  "npx eslint .",
  "npx @biomejs/biome check .",
];

/**
 * Sanitize ID to prevent path traversal and injection attacks
 */
function sanitizeId(id: string): string {
  if (!id || typeof id !== 'string') return 'default';
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'default';
}

/**
 * Validate lint command against whitelist to prevent command injection
 */
function isValidLintCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== 'string') return false;
  return ALLOWED_LINT_COMMANDS.some(allowed =>
    cmd === allowed || cmd.startsWith(allowed + " ")
  );
}

function isValidRepoPattern(cwd: string): boolean {
  const dirName = cwd.split("/").filter(Boolean).pop() || "";
  // Match: hook-checklint, skill-installhook, iapp-mail, etc.
  return /^[a-z]+-[a-z0-9-]+$/i.test(dirName);
}

function readStdinJson(): HookInput | null {
  try {
    const stdin = readFileSync(0, "utf-8");
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function getConfig(cwd: string): CheckLintConfig {
  // Try project settings first
  const projectSettings = readSettings(join(cwd, ".claude", "settings.json"));
  if (projectSettings[CONFIG_KEY]) {
    return projectSettings[CONFIG_KEY] as CheckLintConfig;
  }

  // Fall back to global settings
  const globalSettings = readSettings(join(homedir(), ".claude", "settings.json"));
  if (globalSettings[CONFIG_KEY]) {
    return globalSettings[CONFIG_KEY] as CheckLintConfig;
  }

  // Default config
  return {
    editThreshold: 3,
    keywords: ["dev"],
    enabled: true,
    createTasks: true,
  };
}

function getStateFile(sessionId: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const safeSessionId = sanitizeId(sessionId);
  return join(STATE_DIR, `checklint-${safeSessionId}.json`);
}

function getSessionState(sessionId: string): SessionState {
  const stateFile = getStateFile(sessionId);
  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8"));
    } catch {
      // Corrupted state, reset
    }
  }
  return { editCount: 0, editedFiles: [], lastLintRun: 0 };
}

function saveSessionState(sessionId: string, state: SessionState): void {
  const stateFile = getStateFile(sessionId);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function detectLintCommand(cwd: string): string | null {
  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const scripts = pkg.scripts || {};

      // Check for common lint script names
      if (scripts.lint) return "bun lint";
      if (scripts["lint:check"]) return "bun lint:check";
      if (scripts.eslint) return "bun eslint";
      if (scripts.biome) return "bun biome check";
    } catch {
      // Ignore parse errors
    }
  }

  // Check for config files
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    return "bunx @biomejs/biome check .";
  }
  if (existsSync(join(cwd, ".eslintrc.json")) || existsSync(join(cwd, ".eslintrc.js")) || existsSync(join(cwd, "eslint.config.js"))) {
    return "bunx eslint .";
  }

  return null;
}

function runLint(cwd: string, command: string): { success: boolean; output: string } {
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000, // 60s timeout
    });
    return { success: true, output };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    const output = (execError.stdout || "") + (execError.stderr || "");
    return { success: false, output };
  }
}

function parseLintOutput(output: string): LintError[] {
  const errors: LintError[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // ESLint format: /path/file.ts:10:5: error Message [rule-name]
    // Biome format: path/file.ts:10:5 lint/rule ERROR message
    // Common format: file:line:col: message

    // Try ESLint/common format
    const eslintMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)(?:\s+\[(.+?)\])?$/i);
    if (eslintMatch) {
      errors.push({
        file: eslintMatch[1],
        line: parseInt(eslintMatch[2], 10),
        column: parseInt(eslintMatch[3], 10),
        severity: eslintMatch[4].toLowerCase() as "error" | "warning",
        message: eslintMatch[5].trim(),
        rule: eslintMatch[6],
      });
      continue;
    }

    // Try Biome format
    const biomeMatch = line.match(/^(.+?):(\d+):(\d+)\s+(\w+\/\w+)\s+(ERROR|WARNING|WARN)\s+(.+)$/i);
    if (biomeMatch) {
      errors.push({
        file: biomeMatch[1],
        line: parseInt(biomeMatch[2], 10),
        column: parseInt(biomeMatch[3], 10),
        rule: biomeMatch[4],
        severity: biomeMatch[5].toUpperCase().startsWith("ERR") ? "error" : "warning",
        message: biomeMatch[6].trim(),
      });
      continue;
    }

    // Generic file:line:col format
    const genericMatch = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
    if (genericMatch && !genericMatch[1].startsWith(" ")) {
      errors.push({
        file: genericMatch[1],
        line: parseInt(genericMatch[2], 10),
        column: parseInt(genericMatch[3], 10),
        severity: line.toLowerCase().includes("error") ? "error" : "warning",
        message: genericMatch[4].trim(),
      });
    }
  }

  return errors;
}

function getProjectTaskList(cwd: string): string | null {
  const tasksDir = join(homedir(), ".claude", "tasks");
  if (!existsSync(tasksDir)) return null;

  const dirName = cwd.split("/").filter(Boolean).pop() || "";

  try {
    const lists = readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Look for a bugfixes list for this project
    const bugfixList = lists.find((list) => {
      const listLower = list.toLowerCase();
      const dirLower = dirName.toLowerCase();
      return listLower.startsWith(dirLower) && listLower.includes("bugfix");
    });

    if (bugfixList) return bugfixList;

    // Fall back to dev list
    const devList = lists.find((list) => {
      const listLower = list.toLowerCase();
      const dirLower = dirName.toLowerCase();
      return listLower.startsWith(dirLower) && listLower.includes("dev");
    });

    return devList || null;
  } catch {
    return null;
  }
}

function createTask(taskListId: string, error: LintError): void {
  const tasksDir = join(homedir(), ".claude", "tasks", taskListId);
  mkdirSync(tasksDir, { recursive: true });

  const taskId = `lint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const severity = error.severity === "error" ? "MEDIUM" : "LOW";
  const ruleInfo = error.rule ? ` (${error.rule})` : "";

  const task = {
    id: taskId,
    subject: `BUG: ${severity} - Fix lint ${error.severity} in ${error.file}:${error.line}`,
    description: `Fix lint ${error.severity} at ${error.file}:${error.line}:${error.column}\n\n**Error:** ${error.message}${ruleInfo}\n\n**File:** ${error.file}\n**Line:** ${error.line}\n**Column:** ${error.column}${error.rule ? `\n**Rule:** ${error.rule}` : ""}\n\n**Acceptance criteria:**\n- Lint error is fixed\n- No new lint errors introduced`,
    status: "pending",
    createdAt: new Date().toISOString(),
    metadata: {
      source: "hook-checklint",
      file: error.file,
      line: error.line,
      column: error.column,
      rule: error.rule,
      severity: error.severity,
    },
  };

  const taskFile = join(tasksDir, `${taskId}.json`);
  writeFileSync(taskFile, JSON.stringify(task, null, 2));
}

function getSessionName(transcriptPath: string): string | null {
  if (!existsSync(transcriptPath)) return null;

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    let lastTitle: string | null = null;
    let searchStart = 0;

    while (true) {
      const titleIndex = content.indexOf('"custom-title"', searchStart);
      if (titleIndex === -1) break;

      const lineStart = content.lastIndexOf("\n", titleIndex) + 1;
      const lineEnd = content.indexOf("\n", titleIndex);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

      try {
        const entry = JSON.parse(line);
        if (entry.type === "custom-title" && entry.customTitle) {
          lastTitle = entry.customTitle;
        }
      } catch {
        // Skip malformed lines
      }

      searchStart = titleIndex + 1;
    }

    return lastTitle;
  } catch {
    return null;
  }
}

function approve() {
  console.log(JSON.stringify({ decision: "approve" }));
  process.exit(0);
}

export function run() {
  const hookInput = readStdinJson();
  if (!hookInput) {
    approve();
    return;
  }

  const { session_id, cwd, tool_name, tool_input, transcript_path } = hookInput;

  // Only process edit tools
  if (!EDIT_TOOLS.includes(tool_name)) {
    approve();
    return;
  }

  // Check repo pattern - only run for [prefix]-[name] folders
  if (!isValidRepoPattern(cwd)) {
    approve();
    return;
  }

  const config = getConfig(cwd);

  // Check if hook is disabled
  if (config.enabled === false) {
    approve();
    return;
  }

  // Check keywords match
  const sessionName = transcript_path ? getSessionName(transcript_path) : null;
  const nameToCheck = sessionName || config.taskListId || "";
  const keywords = config.keywords || ["dev"];

  const matchesKeyword = keywords.some((keyword) =>
    nameToCheck.toLowerCase().includes(keyword.toLowerCase())
  );

  // If keywords are configured and we have a session name, check for match
  if (keywords.length > 0 && nameToCheck && !matchesKeyword) {
    approve();
    return;
  }

  // Get edited file path
  const filePath = (tool_input.file_path || tool_input.notebook_path) as string | undefined;
  if (!filePath) {
    approve();
    return;
  }

  // Update session state
  const state = getSessionState(session_id);
  state.editCount++;

  if (!state.editedFiles.includes(filePath)) {
    state.editedFiles.push(filePath);
  }

  const threshold = Math.min(7, Math.max(3, config.editThreshold || 3));

  // Check if we should run lint
  if (state.editCount >= threshold) {
    // Detect or use configured lint command
    const lintCommand = config.lintCommand || detectLintCommand(cwd);

    // Validate lint command against whitelist to prevent command injection
    if (lintCommand && isValidLintCommand(lintCommand)) {
      const { success, output } = runLint(cwd, lintCommand);

      if (!success) {
        const errors = parseLintOutput(output);

        // Filter to errors in files we edited (optional - could check all)
        const relevantErrors = errors.filter((e) =>
          state.editedFiles.some((f) => f.endsWith(e.file) || e.file.endsWith(f.split("/").pop() || ""))
        );

        // Create tasks for lint errors if enabled
        if (config.createTasks !== false && relevantErrors.length > 0) {
          const taskListId = config.taskListId || getProjectTaskList(cwd);

          if (taskListId) {
            // Limit to first 5 errors to avoid task spam
            const errorsToReport = relevantErrors.slice(0, 5);
            for (const error of errorsToReport) {
              createTask(taskListId, error);
            }

            // Log summary
            console.error(
              `[hook-checklint] Created ${errorsToReport.length} task(s) for lint errors in "${taskListId}"`
            );
            if (relevantErrors.length > 5) {
              console.error(`[hook-checklint] (${relevantErrors.length - 5} more errors not reported)`);
            }
          }
        }
      }
    }

    // Reset counter after lint run
    state.editCount = 0;
    state.lastLintRun = Date.now();
  }

  saveSessionState(session_id, state);
  approve();
}

// Allow direct execution
if (import.meta.main) {
  run();
}
