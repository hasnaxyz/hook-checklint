# @hasnaxyz/hook-checklint

Claude Code hook that runs linting after file edits and creates tasks for errors.

## Features

- **Automatic lint checking**: Runs lint after every N file edits (configurable, default: 3)
- **Task creation**: Creates bug tasks for lint errors so AI can fix them
- **Auto-detection**: Detects lint command and task lists automatically
- **Session-aware**: Only runs for sessions matching configured keywords
- **Multiple linters**: Supports ESLint, Biome, and custom lint commands

## Installation

### Global CLI

```bash
bun add -g @hasnaxyz/hook-checklint
hook-checklint install --global
```

### Project-specific

```bash
cd /path/to/your/project
bunx @hasnaxyz/hook-checklint install
```

## Usage

Once installed, the hook runs automatically after file edits (Edit, Write, NotebookEdit tools).

### Commands

```bash
hook-checklint install [path]     # Install the hook
hook-checklint config [path]      # Update configuration
hook-checklint uninstall [path]   # Remove the hook
hook-checklint status             # Show hook status
hook-checklint run                # Execute hook (called by Claude Code)
```

### Options

- `--global`, `-g`: Apply to global settings (`~/.claude/settings.json`)
- `/path/to/repo`: Apply to specific project path

## Configuration

Configuration is stored in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": {
        "tool_name": "^(Edit|Write|NotebookEdit)$"
      },
      "hooks": [{
        "type": "command",
        "command": "bunx @hasnaxyz/hook-checklint@latest run",
        "timeout": 120
      }]
    }]
  },
  "checkLintConfig": {
    "editThreshold": 3,
    "lintCommand": "bun lint",
    "taskListId": "myproject-bugfixes",
    "keywords": ["dev"],
    "createTasks": true,
    "enabled": true
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `editThreshold` | number | 3 | Run lint after this many edits (3-7) |
| `lintCommand` | string | auto | Lint command to run |
| `taskListId` | string | auto | Task list for error tasks |
| `keywords` | string[] | ["dev"] | Only run for matching sessions |
| `createTasks` | boolean | true | Create tasks for lint errors |
| `enabled` | boolean | true | Enable/disable the hook |

## How It Works

1. **Tracks file edits**: Monitors Edit, Write, and NotebookEdit tool calls
2. **Counts edits**: Maintains a per-session edit counter
3. **Triggers lint**: After N edits, runs the configured lint command
4. **Parses output**: Extracts errors from ESLint/Biome output
5. **Creates tasks**: For each error, creates a bug task in the configured task list
6. **Resets counter**: After lint run, resets the edit counter

## Auto-Detection

### Lint Command

The hook auto-detects the lint command by checking:

1. `package.json` scripts: `lint`, `lint:check`, `eslint`, `biome`
2. Config files: `biome.json`, `.eslintrc.json`, `eslint.config.js`

### Task List

The hook auto-detects the task list by:

1. Looking for `{project}-bugfixes` list
2. Falling back to `{project}-dev` list

## Task Format

Created tasks follow this format:

```
Subject: BUG: MEDIUM - Fix lint error in src/file.ts:42
Description:
  Fix lint error at src/file.ts:42:5

  **Error:** Unexpected console statement
  **Rule:** no-console
  **File:** src/file.ts
  **Line:** 42
  **Column:** 5

  **Acceptance criteria:**
  - Lint error is fixed
  - No new lint errors introduced
```

## Session State

The hook maintains session state in `~/.claude/hook-state/checklint-{session_id}.json`:

```json
{
  "editCount": 2,
  "editedFiles": ["src/file.ts", "src/other.ts"],
  "lastLintRun": 1706500000000
}
```

## License

MIT
