#!/usr/bin/env bun
/**
 * @description Incremental watch script for tsgo until official --watch support is fixed
 * @see https://github.com/microsoft/typescript-go/issues/937
 */
import { spawn } from "child_process";
import { watch } from "fs";
import path from "path";

// Configuration
const DEBOUNCE_MS = 300;
const TSGO_ARGS = ["--noEmit", "--pretty"];

// Watch configuration
type WatchTarget = {
  paths: readonly string[];
  extensions: readonly string[];
  recursive: boolean;
  ignorePatterns?: readonly string[];
  filenamePattern?: (filename: string) => boolean;
};

const WATCH_TARGETS: readonly WatchTarget[] = [
  {
    paths: ["src", "lib", "index.ts", "script", "frontend.tsx"],
    extensions: [".ts", ".tsx"],
    recursive: true,
    ignorePatterns: ["node_modules", ".next", "dist"],
  },
  {
    paths: ["."],
    extensions: [".json"],
    recursive: false,
    filenamePattern: (filename: string) => filename.startsWith("tsconfig"),
  },
];

// State
let debounceTimer: NodeJS.Timeout | null = null;
let isRunning = false;

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

/**
 * Format timestamp for console output
 */
function getTimestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/**
 * Log with color and timestamp
 */
function log(message: string, color: keyof typeof colors = "reset") {
  console.log(
    `${colors.dim}[${getTimestamp()}]${colors.reset} ${colors[color]}${message}${colors.reset}`,
  );
}

/**
 * Run tsgo type checking
 */
function runTypeCheck() {
  if (isRunning) {
    return;
  }

  isRunning = true;
  const now = Date.now();

  // Clear console to show only current build logs
  console.clear();
  log("Type checking...", "cyan");

  const tsgo = spawn("tsgo", TSGO_ARGS, {
    stdio: "inherit",
    shell: true,
  });

  tsgo.on("close", (code) => {
    isRunning = false;
    const duration = ((Date.now() - now) / 1000).toFixed(2);

    if (code === 0) {
      log(`✓ Type check passed in ${duration}s`, "green");
    } else {
      log(`✗ Type check failed in ${duration}s`, "red");
    }

    log("Watching for changes...", "dim");
  });

  tsgo.on("error", (error) => {
    isRunning = false;
    log(`Error running tsgo: ${error.message}`, "red");
  });
}

/**
 * Debounced type check
 */
function scheduleTypeCheck() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    runTypeCheck();
  }, DEBOUNCE_MS);
}

/**
 * Initialize file watcher
 */
async function startWatching() {
  log("Starting incremental type checking with tsgo...", "cyan");

  // Log watch targets
  for (const target of WATCH_TARGETS) {
    for (const watchPath of target.paths) {
      const resolvedPath = path.resolve(process.cwd(), watchPath);
      const extensions = target.extensions
        .map((ext) => ext.replace(/^\./, ""))
        .join(",");
      const pattern = target.recursive
        ? `${resolvedPath}/**/*.{${extensions}}`
        : target.filenamePattern
          ? `${resolvedPath}/tsconfig*.json`
          : `${resolvedPath}/*.{${extensions}}`;
      log(`Watching: ${pattern}`, "dim");
    }
  }
  log("", "reset");

  // Initial type check
  runTypeCheck();

  // Store all watchers for cleanup
  const watchers: ReturnType<typeof watch>[] = [];

  // Create watchers for each target
  for (const target of WATCH_TARGETS) {
    for (const watchPath of target.paths) {
      const resolvedPath = path.resolve(process.cwd(), watchPath);
      const watcher = watch(
        resolvedPath,
        { recursive: target.recursive },
        (_eventType: string, filename: string | null) => {
          if (!filename) return;

          // Check file extension
          const matchesExtension = target.extensions.some((ext) =>
            filename.endsWith(ext),
          );
          if (!matchesExtension) {
            return;
          }

          // Check filename pattern if specified
          if (target.filenamePattern && !target.filenamePattern(filename)) {
            return;
          }

          // Check ignore patterns
          if (
            target.ignorePatterns &&
            target.ignorePatterns.some((pattern: string) =>
              filename.includes(pattern),
            )
          ) {
            return;
          }

          log(`Changed: ${filename}`, "yellow");
          scheduleTypeCheck();
        },
      );

      watchers.push(watcher);
    }
  }

  // Handle termination
  const cleanup = () => {
    log("Stopping watcher...", "yellow");
    for (const watcher of watchers) {
      watcher.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Start the watcher
startWatching().catch((error) => {
  console.error("Failed to start watcher:", error);
  process.exit(1);
});
