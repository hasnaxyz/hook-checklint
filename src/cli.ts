#!/usr/bin/env bun

/**
 * @hasnaxyz/hook-checklint CLI
 *
 * Usage:
 *   hook-checklint install           Auto-detect location, configure options
 *   hook-checklint install --global  Force global install
 *   hook-checklint install /path     Install to specific path
 *   hook-checklint config            Update configuration
 *   hook-checklint uninstall         Remove hook
 *   hook-checklint run               Execute hook (called by Claude Code)
 *   hook-checklint status            Show installation status
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import * as readline from "readline";

const PACKAGE_NAME = "@hasnaxyz/hook-checklint";
const CONFIG_KEY = "checkLintConfig";

// Colors
const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface CheckLintConfig {
  taskListId?: string;
  lintCommand?: string;
  editThreshold?: number;
  keywords?: string[];
  enabled?: boolean;
  createTasks?: boolean;
}

function printUsage() {
  console.log(`
${c.bold("hook-checklint")} - Runs linting after file edits and creates tasks for errors

${c.bold("USAGE:")}
  hook-checklint install [path]     Install the hook
  hook-checklint config [path]      Update configuration
  hook-checklint uninstall [path]   Remove the hook
  hook-checklint status             Show hook status
  hook-checklint run                Execute hook ${c.dim("(called by Claude Code)")}

${c.bold("OPTIONS:")}
  ${c.dim("(no args)")}               Auto-detect: if in git repo → install there, else → prompt
  --global, -g            Apply to ~/.claude/settings.json
  --task-list-id, -t <id> Task list ID (non-interactive)
  --keywords, -k <k1,k2>  Keywords, comma-separated (non-interactive)
  --threshold, -n <num>   Edit threshold 3-7 (non-interactive)
  --yes, -y               Non-interactive mode, use defaults
  /path/to/repo           Apply to specific project path

${c.bold("EXAMPLES:")}
  hook-checklint install              ${c.dim("# Install with config prompts")}
  hook-checklint install --global     ${c.dim("# Global install")}
  hook-checklint install -t myproject-bugfixes -n 5 -y  ${c.dim("# Non-interactive")}
  hook-checklint config               ${c.dim("# Update lint command, threshold")}
  hook-checklint status               ${c.dim("# Check what's installed")}

${c.bold("CONFIGURATION:")}
  editThreshold  Run lint after this many edits (3-7, default: 3)
  lintCommand    Custom lint command (auto-detected if not set)
  taskListId     Task list for lint error tasks (auto-detected if not set)
  keywords       Only run for sessions matching keywords (default: dev)
  createTasks    Create tasks for lint errors (default: true)

${c.bold("GLOBAL CLI INSTALL:")}
  bun add -g ${PACKAGE_NAME}
`);
}

function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function getSettingsPath(targetPath: string | "global"): string {
  if (targetPath === "global") {
    return join(homedir(), ".claude", "settings.json");
  }
  return join(targetPath, ".claude", "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(path: string, settings: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function getHookCommand(): string {
  return `bunx ${PACKAGE_NAME}@latest run`;
}

function hookExists(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.PostToolUse) return false;
  const postToolHooks = hooks.PostToolUse as Array<{ hooks?: Array<{ command?: string }> }>;
  return postToolHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes(PACKAGE_NAME))
  );
}

function getConfig(settings: Record<string, unknown>): CheckLintConfig {
  return (settings[CONFIG_KEY] as CheckLintConfig) || {};
}

function setConfig(settings: Record<string, unknown>, config: CheckLintConfig): Record<string, unknown> {
  settings[CONFIG_KEY] = config;
  return settings;
}

function addHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hookConfig = {
    type: "command",
    command: getHookCommand(),
    timeout: 120,
  };

  // Match only Edit, Write, NotebookEdit tools
  const matcher = {
    tool_name: "^(Edit|Write|NotebookEdit)$",
  };

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  if (!hooks.PostToolUse) {
    hooks.PostToolUse = [{ matcher, hooks: [hookConfig] }];
  } else {
    const postToolHooks = hooks.PostToolUse as Array<{ matcher?: unknown; hooks?: unknown[] }>;
    // Check if there's already a group for our matcher
    const existingGroup = postToolHooks.find((g) =>
      JSON.stringify(g.matcher) === JSON.stringify(matcher)
    );
    if (existingGroup?.hooks) {
      existingGroup.hooks.push(hookConfig);
    } else {
      postToolHooks.push({ matcher, hooks: [hookConfig] });
    }
  }
  return settings;
}

function removeHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.PostToolUse) return settings;

  const postToolHooks = hooks.PostToolUse as Array<{ hooks?: Array<{ command?: string }> }>;
  for (const group of postToolHooks) {
    if (group.hooks) {
      group.hooks = group.hooks.filter((h) => !h.command?.includes(PACKAGE_NAME));
    }
  }
  hooks.PostToolUse = postToolHooks.filter((g) => g.hooks && g.hooks.length > 0);
  if (hooks.PostToolUse.length === 0) delete hooks.PostToolUse;

  // Also remove config
  delete settings[CONFIG_KEY];

  return settings;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getAllTaskLists(): string[] {
  const tasksDir = join(homedir(), ".claude", "tasks");
  if (!existsSync(tasksDir)) return [];
  try {
    return readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function getProjectTaskLists(projectPath: string): string[] {
  const allLists = getAllTaskLists();
  const dirName = projectPath.split("/").filter(Boolean).pop() || "";

  return allLists.filter((list) => {
    const listLower = list.toLowerCase();
    const dirLower = dirName.toLowerCase();
    if (listLower.startsWith(dirLower + "-")) return true;
    if (listLower.includes(dirLower)) return true;
    return false;
  });
}

interface InstallOptions {
  global?: boolean;
  taskListId?: string;
  keywords?: string[];
  threshold?: number;
  yes?: boolean;
  path?: string;
}

function parseInstallArgs(args: string[]): InstallOptions {
  const options: InstallOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--global" || arg === "-g") {
      options.global = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--task-list-id" || arg === "-t") {
      options.taskListId = args[++i];
    } else if (arg === "--keywords" || arg === "-k") {
      options.keywords = args[++i]?.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
    } else if (arg === "--threshold" || arg === "-n") {
      const num = parseInt(args[++i], 10);
      if (!isNaN(num) && num >= 3 && num <= 7) {
        options.threshold = num;
      }
    } else if (!arg.startsWith("-")) {
      options.path = arg;
    }
  }

  return options;
}

function detectLintCommand(cwd: string): string | null {
  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const scripts = pkg.scripts || {};
      if (scripts.lint) return "bun lint";
      if (scripts["lint:check"]) return "bun lint:check";
    } catch {
      // Ignore
    }
  }

  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    return "bunx @biomejs/biome check .";
  }
  if (existsSync(join(cwd, ".eslintrc.json")) || existsSync(join(cwd, "eslint.config.js"))) {
    return "bunx eslint .";
  }

  return null;
}

async function resolveTarget(
  args: string[]
): Promise<{ path: string | "global"; label: string } | null> {
  if (args.includes("--global") || args.includes("-g")) {
    return { path: "global", label: "global (~/.claude/settings.json)" };
  }

  const pathArg = args.find((a) => !a.startsWith("-"));
  if (pathArg) {
    const fullPath = resolve(pathArg);
    if (!existsSync(fullPath)) {
      console.log(c.red("X"), `Path does not exist: ${fullPath}`);
      return null;
    }
    return { path: fullPath, label: `project (${fullPath})` };
  }

  const cwd = process.cwd();
  if (isGitRepo(cwd)) {
    console.log(c.green("V"), `Detected git repo: ${c.cyan(cwd)}`);
    return { path: cwd, label: `project (${cwd})` };
  }

  console.log(c.yellow("!"), `Current directory: ${c.cyan(cwd)}`);
  console.log(c.dim("   (not a git repository)\n"));
  console.log("Where would you like to install?\n");
  console.log("  1. Here", c.dim(`(${cwd})`));
  console.log("  2. Global", c.dim("(~/.claude/settings.json)"));
  console.log("  3. Enter a different path\n");

  const choice = await prompt("Choice (1/2/3): ");

  if (choice === "1") {
    return { path: cwd, label: `project (${cwd})` };
  } else if (choice === "2") {
    return { path: "global", label: "global (~/.claude/settings.json)" };
  } else if (choice === "3") {
    const inputPath = await prompt("Path: ");
    if (!inputPath) {
      console.log(c.red("X"), "No path provided");
      return null;
    }
    const fullPath = resolve(inputPath);
    if (!existsSync(fullPath)) {
      console.log(c.red("X"), `Path does not exist: ${fullPath}`);
      return null;
    }
    return { path: fullPath, label: `project (${fullPath})` };
  } else {
    console.log(c.red("X"), "Invalid choice");
    return null;
  }
}

async function promptForConfig(existingConfig: CheckLintConfig = {}, projectPath?: string): Promise<CheckLintConfig> {
  const config: CheckLintConfig = { ...existingConfig };

  console.log(`\n${c.bold("Configuration")}\n`);

  // Edit threshold
  const currentThreshold = config.editThreshold || 3;
  console.log(c.bold("Edit Threshold:"));
  console.log(c.dim("  Run lint after this many file edits (3-7)"));
  const thresholdInput = await prompt(`Threshold [${c.cyan(currentThreshold.toString())}]: `);

  if (thresholdInput) {
    const num = parseInt(thresholdInput, 10);
    if (!isNaN(num) && num >= 3 && num <= 7) {
      config.editThreshold = num;
    } else {
      console.log(c.yellow("!"), "Invalid threshold, using default (3)");
      config.editThreshold = 3;
    }
  } else if (!existingConfig.editThreshold) {
    config.editThreshold = 3;
  }

  // Lint command
  const detectedCommand = projectPath ? detectLintCommand(projectPath) : null;
  const currentCommand = config.lintCommand || detectedCommand || "(auto-detect)";
  console.log();
  console.log(c.bold("Lint Command:"));
  if (detectedCommand) {
    console.log(c.dim(`  Detected: ${detectedCommand}`));
  }
  console.log(c.dim("  Leave empty to auto-detect"));
  const commandInput = await prompt(`Command [${c.cyan(currentCommand)}]: `);

  if (commandInput) {
    config.lintCommand = commandInput;
  } else if (!existingConfig.lintCommand) {
    config.lintCommand = undefined; // Auto-detect at runtime
  }

  // Task list
  const availableLists = projectPath ? getProjectTaskLists(projectPath) : getAllTaskLists();
  const bugfixLists = availableLists.filter((l) => l.toLowerCase().includes("bugfix"));

  console.log();
  console.log(c.bold("Task List ID:"));
  if (bugfixLists.length > 0) {
    console.log(c.dim("  Bugfix lists for this project:"));
    bugfixLists.forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  } else if (availableLists.length > 0) {
    console.log(c.dim("  Available lists:"));
    availableLists.slice(0, 5).forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  }
  console.log(c.dim("  Leave empty to auto-detect (prefers *-bugfixes list)"));

  const currentList = config.taskListId || "(auto-detect)";
  const listInput = await prompt(`Task list ID [${c.cyan(currentList)}]: `);

  if (listInput) {
    const num = parseInt(listInput, 10);
    const selectableLists = bugfixLists.length > 0 ? bugfixLists : availableLists;
    if (!isNaN(num) && num > 0 && num <= selectableLists.length) {
      config.taskListId = selectableLists[num - 1];
    } else {
      config.taskListId = listInput;
    }
  } else if (!existingConfig.taskListId) {
    config.taskListId = undefined;
  }

  // Keywords
  const currentKeywords = config.keywords?.join(", ") || "dev";
  console.log();
  console.log(c.bold("Keywords:"));
  console.log(c.dim("  Only run lint for sessions matching these keywords"));
  const keywordsInput = await prompt(`Keywords (comma-separated) [${c.cyan(currentKeywords)}]: `);

  if (keywordsInput) {
    config.keywords = keywordsInput.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  } else if (!existingConfig.keywords) {
    config.keywords = ["dev"];
  }

  // Create tasks
  const currentCreateTasks = config.createTasks !== false;
  console.log();
  console.log(c.bold("Create Tasks:"));
  console.log(c.dim("  Create tasks for lint errors? (y/n)"));
  const createTasksInput = await prompt(`Create tasks [${c.cyan(currentCreateTasks ? "y" : "n")}]: `);

  if (createTasksInput) {
    config.createTasks = createTasksInput.toLowerCase() === "y";
  } else if (existingConfig.createTasks === undefined) {
    config.createTasks = true;
  }

  config.enabled = true;

  return config;
}

async function install(args: string[]) {
  console.log(`\n${c.bold("hook-checklint install")}\n`);

  const options = parseInstallArgs(args);

  // Resolve target path
  let target: { path: string | "global"; label: string } | null = null;

  if (options.global) {
    target = { path: "global", label: "global (~/.claude/settings.json)" };
  } else if (options.path) {
    const fullPath = resolve(options.path);
    if (!existsSync(fullPath)) {
      console.log(c.red("X"), `Path does not exist: ${fullPath}`);
      return;
    }
    target = { path: fullPath, label: `project (${fullPath})` };
  } else if (options.yes) {
    // Non-interactive mode: use current directory
    const cwd = process.cwd();
    target = { path: cwd, label: `project (${cwd})` };
  } else {
    target = await resolveTarget(args);
  }

  if (!target) return;

  const settingsPath = getSettingsPath(target.path);
  let settings = readSettings(settingsPath);

  if (hookExists(settings)) {
    console.log(c.yellow("!"), `Hook already installed in ${target.label}`);
    if (!options.yes) {
      const update = await prompt("Update configuration? (y/n): ");
      if (update.toLowerCase() !== "y") return;
    }
  } else {
    settings = addHook(settings);
  }

  // Configure
  const existingConfig = getConfig(settings);
  let config: CheckLintConfig;

  if (options.yes || options.taskListId || options.keywords || options.threshold) {
    // Non-interactive mode
    config = {
      ...existingConfig,
      taskListId: options.taskListId || existingConfig.taskListId,
      keywords: options.keywords || existingConfig.keywords || ["dev"],
      editThreshold: options.threshold || existingConfig.editThreshold || 3,
      createTasks: existingConfig.createTasks !== false ? true : existingConfig.createTasks,
      enabled: true,
    };
  } else {
    // Interactive mode
    const projectPath = target.path === "global" ? undefined : target.path;
    config = await promptForConfig(existingConfig, projectPath);
  }

  settings = setConfig(settings, config);
  writeSettings(settingsPath, settings);

  console.log();
  console.log(c.green("V"), `Installed to ${target.label}`);
  console.log();
  console.log(c.bold("Configuration:"));
  console.log(`  Threshold:    ${config.editThreshold || 3} edits`);
  console.log(`  Lint command: ${config.lintCommand || c.cyan("(auto-detect)")}`);
  console.log(`  Task list:    ${config.taskListId || c.cyan("(auto-detect)")}`);
  console.log(`  Keywords:     ${config.keywords?.join(", ") || "dev"}`);
  console.log(`  Create tasks: ${config.createTasks !== false ? "yes" : "no"}`);
  console.log();
}

async function configure(args: string[]) {
  console.log(`\n${c.bold("hook-checklint config")}\n`);

  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);

  if (!existsSync(settingsPath)) {
    console.log(c.red("X"), `No settings file at ${settingsPath}`);
    console.log(c.dim("  Run 'hook-checklint install' first"));
    return;
  }

  let settings = readSettings(settingsPath);

  if (!hookExists(settings)) {
    console.log(c.red("X"), `Hook not installed in ${target.label}`);
    console.log(c.dim("  Run 'hook-checklint install' first"));
    return;
  }

  const existingConfig = getConfig(settings);
  const projectPath = target.path === "global" ? undefined : target.path;
  const config = await promptForConfig(existingConfig, projectPath);
  settings = setConfig(settings, config);

  writeSettings(settingsPath, settings);

  console.log();
  console.log(c.green("V"), `Configuration updated`);
  console.log();
  console.log(c.bold("New configuration:"));
  console.log(`  Threshold:    ${config.editThreshold || 3} edits`);
  console.log(`  Lint command: ${config.lintCommand || c.cyan("(auto-detect)")}`);
  console.log(`  Task list:    ${config.taskListId || c.cyan("(auto-detect)")}`);
  console.log(`  Keywords:     ${config.keywords?.join(", ") || "dev"}`);
  console.log(`  Create tasks: ${config.createTasks !== false ? "yes" : "no"}`);
  console.log();
}

async function uninstall(args: string[]) {
  console.log(`\n${c.bold("hook-checklint uninstall")}\n`);

  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);

  if (!existsSync(settingsPath)) {
    console.log(c.yellow("!"), `No settings file at ${settingsPath}`);
    return;
  }

  const settings = readSettings(settingsPath);

  if (!hookExists(settings)) {
    console.log(c.yellow("!"), `Hook not found in ${target.label}`);
    return;
  }

  const updated = removeHook(settings);
  writeSettings(settingsPath, updated);

  console.log(c.green("V"), `Removed from ${target.label}`);
}

function status() {
  console.log(`\n${c.bold("hook-checklint status")}\n`);

  // Global
  const globalPath = getSettingsPath("global");
  const globalSettings = readSettings(globalPath);
  const globalInstalled = hookExists(globalSettings);
  const globalConfig = getConfig(globalSettings);

  console.log(
    globalInstalled ? c.green("V") : c.red("X"),
    "Global:",
    globalInstalled ? "Installed" : "Not installed",
    c.dim(`(${globalPath})`)
  );
  if (globalInstalled) {
    console.log(c.dim(`    Threshold: ${globalConfig.editThreshold || 3}, Command: ${globalConfig.lintCommand || "(auto)"}`));
  }

  // Current directory
  const cwd = process.cwd();
  const projectPath = getSettingsPath(cwd);
  if (existsSync(projectPath)) {
    const projectSettings = readSettings(projectPath);
    const projectInstalled = hookExists(projectSettings);
    const projectConfig = getConfig(projectSettings);

    console.log(
      projectInstalled ? c.green("V") : c.red("X"),
      "Project:",
      projectInstalled ? "Installed" : "Not installed",
      c.dim(`(${projectPath})`)
    );
    if (projectInstalled) {
      console.log(c.dim(`    Threshold: ${projectConfig.editThreshold || 3}, Command: ${projectConfig.lintCommand || "(auto)"}`));
    }
  } else {
    console.log(c.dim("."), "Project:", c.dim("No .claude/settings.json"));
  }

  // Detected lint command
  const detectedCommand = detectLintCommand(cwd);
  if (detectedCommand) {
    console.log();
    console.log(c.bold("Detected lint command:"), detectedCommand);
  }

  // Available task lists
  const projectLists = getProjectTaskLists(cwd);
  const bugfixLists = projectLists.filter((l) => l.toLowerCase().includes("bugfix"));
  if (bugfixLists.length > 0) {
    console.log();
    console.log(c.bold("Bugfix task lists:"));
    bugfixLists.forEach((list) => console.log(c.dim(`  - ${list}`)));
  }

  console.log();
}

// Main
const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

switch (command) {
  case "install":
    install(commandArgs);
    break;
  case "config":
    configure(commandArgs);
    break;
  case "uninstall":
    uninstall(commandArgs);
    break;
  case "run":
    import("./hook.js").then((m) => m.run());
    break;
  case "status":
    status();
    break;
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(c.red(`Unknown command: ${command}`));
    printUsage();
    process.exit(1);
}
