import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];

const textExtensions = new Set([".rs", ".ts", ".tsx", ".js", ".mjs"]);
const ignoredDirs = new Set([".git", "node_modules", "dist", "target"]);

function fail(file, line, message) {
  const location = line ? `${file}:${line}` : file;
  failures.push(`${location} ${message}`);
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...walk(join(dir, entry.name)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const ext = path.slice(path.lastIndexOf("."));
    if (textExtensions.has(ext)) {
      files.push(path);
    }
  }
  return files;
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function rel(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function isTelemetryEventName(value) {
  return /^[a-z0-9]+(?:\.[a-z0-9]+)*$/u.test(value);
}

function hasCamelSegment(value) {
  return value.split(".").some((segment) => /[a-z][A-Z]|[A-Z][a-z]/u.test(segment));
}

function checkBuiltInFixtures() {
  const valid = ["ssh.connect.session.created", "rdp.runtime.frame.perf.snapshot"];
  const invalid = [
    "settings:loaded",
    "remote_edit.sync_failed",
    "ssh.connect.session-created",
    "proxy.closeAll.start",
  ];
  for (const event of valid) {
    if (!isTelemetryEventName(event)) {
      throw new Error(`telemetry checker fixture should accept ${event}`);
    }
  }
  for (const event of invalid) {
    if (isTelemetryEventName(event) && !hasCamelSegment(event)) {
      throw new Error(`telemetry checker fixture should reject ${event}`);
    }
  }
}

function checkEventNames(file, text) {
  const name = rel(file);
  const eventPatterns = [
    /\blogTelemetry\(\s*["'](?:debug|info|warn|error)["']\s*,\s*["']([^"']+)["']/gu,
    /\blogEvent\(\s*["'](?:debug|info|warn|error)["']\s*,\s*["']([^"']+)["']/gu,
    /\blog(?:Debug|Info|Warn|Error)\(\s*["']([^"']+)["']/gu,
    /log_telemetry\(\s*TelemetryLevel::[A-Za-z]+\s*,\s*"([^"]+)"/gu,
    /\bevent\s*:\s*["']([^"']+)["']/gu,
    /"event"\s*:\s*"([^"]+)"/gu,
  ];

  for (const pattern of eventPatterns) {
    for (const match of text.matchAll(pattern)) {
      const event = match[1];
      if (!isTelemetryEventName(event) || hasCamelSegment(event)) {
        fail(name, lineOf(text, match.index), `telemetry event name must be lowercase dot segments: ${event}`);
      }
    }
  }
}

function checkNoConsole(file, text) {
  const name = rel(file);
  if (!name.startsWith("src/")) return;
  for (const match of text.matchAll(/\bconsole\.(?:log|debug|info|warn|error)\s*\(/gu)) {
    fail(name, lineOf(text, match.index), "do not add console.* logging; use shared telemetry helpers");
  }
}

function checkPayloadSystemFields(file, text) {
  const name = rel(file);
  const targets = [
    "src/shared/logging/telemetry.ts",
    "src-tauri/src/telemetry.rs",
    "crates/engine/src/telemetry.rs",
    "crates/openai/src/telemetry.rs",
    "crates/rdp_core/src/telemetry.rs",
    "crates/telemetry/src/lib.rs",
  ];
  if (!targets.includes(name)) return;

  for (const match of text.matchAll(/["'](?:ts|source|level)["']\s*:/gu)) {
    fail(name, lineOf(text, match.index), "telemetry payload must not write ts/source/level");
  }
}

function findCallBlocks(text, callee) {
  const blocks = [];
  const callPattern = new RegExp(`\\b${callee}\\s*\\(`, "gu");
  for (const match of text.matchAll(callPattern)) {
    const start = match.index;
    const open = start + match[0].lastIndexOf("(");
    let depth = 0;
    let end = open;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          blocks.push({ start, text: text.slice(start, end + 1) });
          break;
        }
      }
    }
  }
  return blocks;
}

function checkSensitiveTelemetryFields(file, text) {
  const name = rel(file);
  if (!name.includes("crates/openai/src/") && name !== "src/hooks/useAiState.ts") {
    return;
  }
  const forbidden = [
    "messages",
    "selectionText",
    "recentTerminalOutput",
    "systemPromptSummary",
  ];
  const blocks = [
    ...findCallBlocks(text, "log_telemetry"),
    ...findCallBlocks(text, "logTelemetry"),
    ...findCallBlocks(text, "logDebug"),
    ...findCallBlocks(text, "logInfo"),
    ...findCallBlocks(text, "logWarn"),
    ...findCallBlocks(text, "logError"),
  ];

  for (const block of blocks) {
    for (const key of forbidden) {
      const pattern = new RegExp(`["']${key}["']\\s*:|\\b${key}\\s*:`, "u");
      if (pattern.test(block.text)) {
        fail(name, lineOf(text, block.start), `telemetry payload must not include full content field ${key}`);
      }
    }
    if (/["']message["']\s*:\s*&?message\b/u.test(block.text)) {
      fail(name, lineOf(text, block.start), "OpenAI telemetry must not include full response message");
    }
  }
}

function checkRdpCoreDirectLogging(file, text) {
  const name = rel(file);
  if (!name.startsWith("crates/rdp_core/src/") || name === "crates/rdp_core/src/telemetry.rs") return;
  for (const match of text.matchAll(/\b(?:use\s+tracing|tracing::|debug!|info!|warn!|error!)\b/gu)) {
    fail(name, lineOf(text, match.index), "rdp_core must log through crate::telemetry");
  }
}

checkBuiltInFixtures();

for (const file of walk(root)) {
  if (!statSync(file).isFile()) continue;
  const text = readFileSync(file, "utf8");
  checkEventNames(file, text);
  checkNoConsole(file, text);
  checkPayloadSystemFields(file, text);
  checkSensitiveTelemetryFields(file, text);
  checkRdpCoreDirectLogging(file, text);
}

if (failures.length > 0) {
  console.error("Telemetry check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Telemetry check passed.");
