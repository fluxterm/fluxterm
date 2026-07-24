import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const sourceRoots = ["src", "src-tauri", "crates"];
const textExtensions = new Set([".rs", ".ts", ".tsx", ".js", ".mjs"]);
const ignoredDirs = new Set([".git", "node_modules", "dist", "target"]);
const eventNamePattern = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/u;
const legacyApiNames = [
  ["Telemetry", "Level"].join(""),
  ["log", "Telemetry"].join(""),
  ["log_", "telemetry"].join(""),
  ["fluxterm_", "telemetry"].join(""),
];
const legacyModuleNames = [
  ["fluxterm-", "telemetry"].join(""),
  ["shared/logging/", "telemetry"].join(""),
];
const legacyApiPattern = new RegExp(
  `\\b(?:${legacyApiNames.join("|")})\\b|${legacyModuleNames.join("|")}`,
  "u",
);
const directConsolePattern = /\bconsole\.(?:log|debug|info|warn|error)\s*\(/gu;
const forbiddenFieldPattern =
  /["']?(?:password|passphrase|privateKey|private_key|apiKey|api_key|token|cookie|authorization|path|fileName|filename|terminalOutput|recentTerminalOutput|selectionText|clipboardText|messages|prompt|response)["']?\s*:/gu;
const performanceEventPattern =
  /^(?:[a-z0-9]+\.)*(?:perf|performance|fps|throughput)(?:\.[a-z0-9]+)*$/u;
const levelNames = new Set(["debug", "info", "warn", "error"]);
const nestedErrorFields = new Set(["code", "message", "detail", "details"]);
const catalogPath = join(root, "docs", "logging-events.json");

function fail(file, line, message) {
  failures.push(`${file}${line ? `:${line}` : ""} ${message}`);
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...walk(join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function rel(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function findCallBlocks(text, calleePattern) {
  const blocks = [];
  for (const match of text.matchAll(calleePattern)) {
    const start = match.index;
    const open = text.indexOf("(", start);
    if (open < 0) continue;
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          blocks.push({ start, text: text.slice(start, index + 1) });
          break;
        }
      }
    }
  }
  return blocks;
}

function ownerForFile(name) {
  if (name.startsWith("src-tauri/")) return "tauri";
  if (name.startsWith("src/")) return "webview";
  const crate = name.match(/^crates\/([^/]+)\//u)?.[1];
  return crate ?? "unknown";
}

function messageFromEvent(event) {
  const acronyms = new Map([
    ["ai", "AI"],
    ["api", "API"],
    ["rdp", "RDP"],
    ["sftp", "SFTP"],
    ["ssh", "SSH"],
    ["tls", "TLS"],
    ["ui", "UI"],
  ]);
  return event
    .split(".")
    .map((segment) => acronyms.get(segment) ?? segment)
    .join(" ");
}

function extractFields(block) {
  const fields = new Set();
  const keyPattern =
    /(?:["']([A-Za-z][A-Za-z0-9_]*)["']|(?:^|[,{]\s*)([A-Za-z][A-Za-z0-9_]*))\s*:/gmu;
  for (const match of block.matchAll(keyPattern)) {
    const field = match[1] ?? match[2];
    if (
      field &&
      !nestedErrorFields.has(field) &&
      field !== "event" &&
      field !== "message" &&
      field !== "component" &&
      field !== "truncated"
    ) {
      fields.add(field);
    }
  }
  if (/\boperation_?id\b|\boperationId\b/u.test(block)) {
    fields.add("operationId");
  }
  return fields;
}

function sourceLogCalls(name, text) {
  const calls = [];
  if (name.startsWith("src/") && !name.startsWith("src/shared/logging/")) {
    const directLevels = {
      logDebug: "debug",
      logInfo: "info",
      logWarn: "warn",
      logError: "error",
    };
    for (const block of findCallBlocks(
      text,
      /\b(?:logDebug|logInfo|logWarn|logError)\s*\(/gu,
    )) {
      const parsed = block.text.match(
        /^\s*(logDebug|logInfo|logWarn|logError)\s*\(\s*["']([a-z0-9]+(?:\.[a-z0-9]+)+)["']/u,
      );
      calls.push({
        ...block,
        level: parsed ? directLevels[parsed[1]] : null,
        event: parsed?.[2] ?? null,
      });
    }
    for (const block of findCallBlocks(text, /\blogRdpSubAppEvent\s*\(/gu)) {
      if (
        /function\s*$/u.test(
          text.slice(Math.max(0, block.start - 20), block.start),
        )
      ) {
        continue;
      }
      const parsed = block.text.match(
        /^\s*logRdpSubAppEvent\s*\(\s*["'](debug|info|warn|error)["']\s*,\s*["']([a-z0-9]+(?:\.[a-z0-9]+)+)["']/u,
      );
      calls.push({
        ...block,
        level: parsed?.[1] ?? null,
        event: parsed?.[2] ?? null,
      });
    }
  }

  if (name.endsWith(".rs") && !name.startsWith("crates/logging/")) {
    for (const block of findCallBlocks(text, /\blog_event!\s*\(/gu)) {
      const parsed = block.text.match(
        /^\s*log_event!\s*\(\s*LogLevel::(Debug|Info|Warn|Error)\s*,\s*["']([a-z0-9]+(?:\.[a-z0-9]+)+)["']/u,
      );
      calls.push({
        ...block,
        level: parsed?.[1]?.toLowerCase() ?? null,
        event: parsed?.[2] ?? null,
      });
    }
  }
  return calls;
}

function collectSources() {
  const sources = [];
  for (const sourceRoot of sourceRoots) {
    const absolute = join(root, sourceRoot);
    if (!statSync(absolute).isDirectory()) continue;
    for (const file of walk(absolute)) {
      const name = rel(file);
      const text = readFileSync(file, "utf8");
      sources.push({
        file,
        name,
        text,
        calls: sourceLogCalls(name, text),
      });
    }
  }
  return sources;
}

function validateCatalog() {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.events)) {
    throw new Error("logging event catalog has an invalid schema");
  }
  const byName = new Map();
  for (const entry of catalog.events) {
    if (!eventNamePattern.test(entry.name ?? "")) {
      fail("docs/logging-events.json", 0, `invalid event name: ${entry.name}`);
    }
    if (!levelNames.has(entry.level)) {
      fail(
        "docs/logging-events.json",
        0,
        `invalid level for event ${entry.name}`,
      );
    }
    if (
      typeof entry.message !== "string" ||
      entry.message !== messageFromEvent(entry.name)
    ) {
      fail(
        "docs/logging-events.json",
        0,
        `event ${entry.name} must use its static canonical English message`,
      );
    }
    if (
      typeof entry.owner !== "string" ||
      !Array.isArray(entry.requiredFields) ||
      !Array.isArray(entry.allowedFields)
    ) {
      fail(
        "docs/logging-events.json",
        0,
        `event ${entry.name} has an incomplete catalog entry`,
      );
    }
    if (byName.has(entry.name)) {
      fail("docs/logging-events.json", 0, `duplicate event: ${entry.name}`);
    }
    byName.set(entry.name, entry);
  }
  return byName;
}

function writeCatalog(sources) {
  const existing = JSON.parse(readFileSync(catalogPath, "utf8"));
  const infrastructure = existing.events.filter((entry) =>
    entry.name.startsWith("logging."),
  );
  const discovered = new Map(
    infrastructure.map((entry) => [
      entry.name,
      {
        ...entry,
        message: messageFromEvent(entry.name),
        requiredFields: [...entry.requiredFields],
        allowedFields: new Set(entry.allowedFields),
      },
    ]),
  );

  for (const source of sources) {
    for (const call of source.calls) {
      if (!call.event || !call.level) continue;
      const fields = extractFields(call.text);
      const current = discovered.get(call.event);
      if (current && current.level !== call.level) {
        fail(
          source.name,
          lineOf(source.text, call.start),
          `event ${call.event} uses conflicting levels`,
        );
        continue;
      }
      if (current && current.owner !== ownerForFile(source.name)) {
        fail(
          source.name,
          lineOf(source.text, call.start),
          `event ${call.event} has multiple owners`,
        );
        continue;
      }
      const entry = current ?? {
        name: call.event,
        level: call.level,
        owner: ownerForFile(source.name),
        message: messageFromEvent(call.event),
        requiredFields: call.event.endsWith(".failed") ? ["error"] : [],
        allowedFields: new Set(),
      };
      for (const field of fields) entry.allowedFields.add(field);
      if (call.event.endsWith(".failed")) entry.allowedFields.add("error");
      discovered.set(call.event, entry);
    }
  }

  if (failures.length > 0) return;
  const events = [...discovered.values()]
    .map((entry) => ({
      ...entry,
      requiredFields: [...new Set(entry.requiredFields)].sort(),
      allowedFields: [...entry.allowedFields].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  writeFileSync(
    catalogPath,
    `${JSON.stringify({ schemaVersion: 1, events }, null, 2)}\n`,
    "utf8",
  );
}

function checkSource(source, catalog) {
  const { name, text, calls } = source;
  if (legacyApiPattern.test(text)) {
    fail(name, 0, "legacy telemetry logging API is forbidden");
  }
  if (name.startsWith("src/")) {
    for (const match of text.matchAll(directConsolePattern)) {
      fail(name, lineOf(text, match.index), "console logging is forbidden");
    }
  }
  if (
    name.startsWith("crates/") &&
    !name.startsWith("crates/logging/") &&
    /\b(?:debug|info|warn|error)!\s*\(/u.test(text)
  ) {
    fail(name, 0, "Rust crates must use fluxterm-logging");
  }

  for (const call of calls) {
    const line = lineOf(text, call.start);
    if (!call.event || !call.level) {
      fail(name, line, "log level and event must be string literals");
      continue;
    }
    if (performanceEventPattern.test(call.event)) {
      fail(name, line, "continuous performance data must not be logged");
    }
    const entry = catalog.get(call.event);
    if (!entry) {
      fail(name, line, `unregistered event: ${call.event}`);
      continue;
    }
    if (entry.level !== call.level) {
      fail(
        name,
        line,
        `event ${call.event} must use ${entry.level}, found ${call.level}`,
      );
    }
    if (entry.owner !== ownerForFile(name)) {
      fail(
        name,
        line,
        `event ${call.event} is owned by ${entry.owner}, not ${ownerForFile(name)}`,
      );
    }
    for (const field of call.text.matchAll(forbiddenFieldPattern)) {
      fail(
        name,
        lineOf(text, call.start + field.index),
        `forbidden log field: ${field[0]}`,
      );
    }
    const fields = extractFields(call.text);
    for (const field of fields) {
      if (!entry.allowedFields.includes(field)) {
        fail(name, line, `event ${call.event} does not allow field ${field}`);
      }
    }
    for (const field of entry.requiredFields) {
      if (!fields.has(field) && !/\bfields\b/u.test(call.text)) {
        fail(name, line, `event ${call.event} requires field ${field}`);
      }
    }
    if (
      call.event.endsWith(".failed") &&
      /(?:json!\s*\(|\{\s*)/u.test(call.text) &&
      !fields.has("error")
    ) {
      fail(name, line, `failed event ${call.event} requires standard error`);
    }
  }
}

const sources = collectSources();
if (process.argv.includes("--write-catalog")) {
  writeCatalog(sources);
}
const catalog = validateCatalog();
for (const source of sources) {
  checkSource(source, catalog);
}

if (failures.length > 0) {
  process.stderr.write(`Logging check failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}

process.stdout.write("Logging check passed.\n");
