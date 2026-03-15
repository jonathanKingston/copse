/**
 * View and edit .copserc configuration.
 *
 * Usage:
 *   copse config              Show current config with file path
 *   copse config get <key>    Get a specific config value
 *   copse config set <key> <value>  Set a config value (writes back to file)
 *   copse config path         Show config file location
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { initializeRuntime } from "../lib/runtime-init.js";

initializeRuntime();

const CONFIG_FILENAME = ".copserc";

function findConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve("/");
  while (dir !== root) {
    const p = join(dir, CONFIG_FILENAME);
    if (existsSync(p)) return p;
    dir = resolve(dir, "..");
  }
  return null;
}

function resolveConfigPath(): string | null {
  // Check global first (matches loadConfig order in lib/config.ts)
  const homeConfig = join(homedir(), CONFIG_FILENAME);
  if (existsSync(homeConfig)) return homeConfig;

  // Then walk up from cwd
  return findConfigPath(process.cwd());
}

function loadConfigRaw(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config: expected a JSON object in ${configPath}`);
  }
  return parsed as Record<string, unknown>;
}

function showConfig(): void {
  const configPath = resolveConfigPath();
  if (!configPath) {
    console.log("No .copserc found. Run 'copse init' to create one.");
    process.exit(1);
  }

  const config = loadConfigRaw(configPath);
  console.log(`Config file: ${configPath}\n`);
  console.log(JSON.stringify(config, null, 2));
}

function getKey(key: string): void {
  const configPath = resolveConfigPath();
  if (!configPath) {
    console.error("No .copserc found. Run 'copse init' to create one.");
    process.exit(1);
  }

  const config = loadConfigRaw(configPath);
  if (!(key in config)) {
    console.error(`Key "${key}" not found in config.`);
    process.exit(1);
  }

  const value = config[key];
  if (typeof value === "string") {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function setKey(key: string, rawValue: string): void {
  const configPath = resolveConfigPath();
  if (!configPath) {
    console.error("No .copserc found. Run 'copse init' to create one.");
    process.exit(1);
  }

  const config = loadConfigRaw(configPath);

  // Try to parse as JSON first (for arrays, numbers, booleans, etc.)
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    // Treat as plain string
    value = rawValue;
  }

  config[key] = value;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`Set "${key}" in ${configPath}`);
}

function showPath(): void {
  const configPath = resolveConfigPath();
  if (!configPath) {
    console.log("No .copserc found. Run 'copse init' to create one.");
    process.exit(1);
  }
  console.log(configPath);
}

function main(): void {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand) {
    showConfig();
    return;
  }

  switch (subcommand) {
    case "path":
      showPath();
      break;

    case "get": {
      const key = args[1];
      if (!key) {
        console.error("Usage: copse config get <key>");
        process.exit(1);
      }
      getKey(key);
      break;
    }

    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error("Usage: copse config set <key> <value>");
        process.exit(1);
      }
      setKey(key, value);
      break;
    }

    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error("Usage: copse config [path|get <key>|set <key> <value>]");
      process.exit(1);
  }
}

main();
