interface InstallOptions {
  global?: boolean;
  taskListId?: string;
  keywords?: string[];
  editThreshold?: number;
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
      options.editThreshold = parseInt(args[++i], 10);
    } else if (!arg.startsWith("-")) {
      options.path = arg;
    }
  }

  return options;
}
