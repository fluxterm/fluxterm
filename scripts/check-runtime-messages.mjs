import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const errorCodeLiterals = [];
const errorCodeConstants = [];
const rustStringConstants = [];
const messageKeyConstantReferences = [];
const rustTranslationKeys = new Set();
const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  "i18n",
]);
const sourceExtensions = new Set([".rs", ".ts", ".tsx"]);
const hanPattern = /\p{Script=Han}/u;
const errorCodePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const messageKeyPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...walk(join(directory, entry.name)));
      }
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isFile() && sourceExtensions.has(extname(path))) files.push(path);
  }
  return files;
}

function stripComments(source, allowSingleQuote = true) {
  let output = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || (allowSingleQuote && current === "'")) {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function runtimeSource(path, source) {
  if (path.endsWith(".rs")) {
    const testModule = source.search(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/u);
    if (testModule >= 0) return source.slice(0, testModule);
  }
  return source;
}

function findCallBlocks(source, calleePattern, allowSingleQuote = true) {
  const blocks = [];
  const pattern = new RegExp(`\\b(?:${calleePattern})\\s*\\(`, "gu");
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = open; index < source.length; index += 1) {
      const current = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) quote = null;
        continue;
      }
      if (current === '"' || (allowSingleQuote && current === "'")) {
        quote = current;
        continue;
      }
      if (current === "(") depth += 1;
      if (current === ")") {
        depth -= 1;
        if (depth === 0) {
          blocks.push({
            index: match.index,
            text: source.slice(match.index, index + 1),
          });
          break;
        }
      }
    }
  }
  return blocks;
}

function splitTopLevelArguments(callText) {
  const open = callText.indexOf("(");
  const close = callText.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const argumentsSource = callText.slice(open + 1, close);
  const argumentsList = [];
  const delimiters = [];
  let quote = null;
  let escaped = false;
  let argumentStart = 0;
  const closingDelimiter = { "(": ")", "[": "]", "{": "}" };

  for (let index = 0; index < argumentsSource.length; index += 1) {
    const current = argumentsSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }
    if (Object.hasOwn(closingDelimiter, current)) {
      delimiters.push(closingDelimiter[current]);
      continue;
    }
    if (delimiters.at(-1) === current) {
      delimiters.pop();
      continue;
    }
    if (current === "," && delimiters.length === 0) {
      argumentsList.push(argumentsSource.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }

  const finalArgument = argumentsSource.slice(argumentStart).trim();
  if (finalArgument) argumentsList.push(finalArgument);
  return argumentsList;
}

function parseStringLiteral(argument) {
  const trimmed = argument?.trim() ?? "";
  if (!/^"(?:\\.|[^"])*"$/u.test(trimmed)) return null;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function registerRustMessageKey(key, location) {
  if (!messageKeyPattern.test(key)) {
    failures.push(`${location} invalid message key: ${key}`);
    return;
  }
  rustTranslationKeys.add(key);
}

function registerMessageKeyArgument(argument, location) {
  const literal = parseStringLiteral(argument);
  if (literal !== null) {
    registerRustMessageKey(literal, location);
    return;
  }
  if (
    /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Z][A-Z0-9_]*_KEY)$/u.test(
      argument?.trim() ?? "",
    )
  ) {
    const name = argument.trim().split("::").at(-1);
    messageKeyConstantReferences.push({ name, location });
    return;
  }
  failures.push(
    `${location} message key argument must be a string literal or _KEY constant`,
  );
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/u).length;
}

function checkFixtures() {
  const allowed = stripComments(`
    // EngineError::new("fixture", "允许中文注释");
    EngineError::new("fixture", "English runtime fallback");
  `);
  const rejected = stripComments(
    `EngineError::new("fixture", "不允许中文运行时错误");`,
  );
  const allowedBlock = findCallBlocks(allowed, "EngineError::new")[0];
  const rejectedBlock = findCallBlocks(rejected, "EngineError::new")[0];
  if (!allowedBlock || hanPattern.test(allowedBlock.text)) {
    throw new Error("runtime message checker rejected an allowed fixture");
  }
  if (!rejectedBlock || !hanPattern.test(rejectedBlock.text)) {
    throw new Error("runtime message checker accepted a forbidden fixture");
  }
  const localizedBlock = findCallBlocks(
    `EngineError::localized(
      "tunnel_open_failed",
      format!("Failed to open tunnel for {}", host),
      "tunnel.error.openFailed",
    )`,
    "EngineError::localized",
    false,
  )[0];
  const localizedArguments = localizedBlock
    ? splitTopLevelArguments(localizedBlock.text)
    : [];
  if (
    localizedArguments.length !== 3 ||
    parseStringLiteral(localizedArguments[2]) !== "tunnel.error.openFailed"
  ) {
    throw new Error(
      "runtime message checker failed to parse localized arguments",
    );
  }
  registerMessageKeyArgument(localizedArguments[2], "fixture:1");
  if (!rustTranslationKeys.delete("tunnel.error.openFailed")) {
    throw new Error(
      "runtime message checker failed to register a new namespace",
    );
  }
  if (
    !messageKeyPattern.test("tunnel.error.openFailed") ||
    messageKeyPattern.test("tunnel_error_open_failed")
  ) {
    throw new Error(
      "runtime message checker has an invalid message key pattern",
    );
  }
}

function checkFile(path) {
  const original = readFileSync(path, "utf8");
  const isRust = path.endsWith(".rs");
  const source = stripComments(runtimeSource(path, original), !isRust);
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const callPatterns = isRust
    ? [
        "EngineError::new",
        "EngineError::with_detail",
        "EngineError::localized",
        "RuntimeError::new",
        "OpenAiError::[A-Za-z_]+",
      ]
    : ["new\\s+AppError", "logDebug", "logInfo", "logWarn", "logError"];

  for (const callee of callPatterns) {
    for (const block of findCallBlocks(source, callee, !isRust)) {
      if (hanPattern.test(block.text)) {
        failures.push(
          `${relativePath}:${lineOf(source, block.index)} runtime error/log call contains hardcoded Chinese`,
        );
      }
    }
  }

  for (const match of source.matchAll(
    /["']message["']\s*:\s*["']([^"']*\p{Script=Han}[^"']*)["']/gu,
  )) {
    failures.push(
      `${relativePath}:${lineOf(source, match.index)} structured log message must be English`,
    );
  }

  if (!isRust) {
    if (
      relativePath !== "src/shared/tauri/commands.ts" &&
      /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["']/su.test(
        source,
      )
    ) {
      failures.push(
        `${relativePath} must call Tauri through invokeTauriCommand`,
      );
    }
    return;
  }
  for (const block of findCallBlocks(
    source,
    "EngineError::(?:new|with_detail|localized)",
    false,
  )) {
    const codeMatch = block.text.match(
      /EngineError::(?:new|with_detail|localized)\s*\(\s*"([^"]+)"/u,
    );
    if (!codeMatch) continue;
    const code = codeMatch[1];
    if (!errorCodePattern.test(code)) {
      failures.push(
        `${relativePath}:${lineOf(source, block.index)} invalid EngineError code: ${code}`,
      );
    }
    errorCodeLiterals.push({
      code,
      location: `${relativePath}:${lineOf(source, block.index)}`,
    });
  }

  for (const match of source.matchAll(
    /\bconst\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]+)"/gu,
  )) {
    const [, name, value] = match;
    const location = `${relativePath}:${lineOf(source, match.index)}`;
    rustStringConstants.push({ name, value, location });
    const expectedCodeName = `${value.toUpperCase()}_CODE`;
    const isErrorCodeConstant =
      name.endsWith("_CODE") ||
      (errorCodePattern.test(value) && name === value.toUpperCase());
    if (isErrorCodeConstant) {
      if (!errorCodePattern.test(value)) {
        failures.push(
          `${location} invalid error code constant value: ${value}`,
        );
        continue;
      }
      if (name !== expectedCodeName) {
        failures.push(
          `${location} error code constant must be named ${expectedCodeName}`,
        );
      }
      errorCodeConstants.push({ code: value, location });
    }

    if (name.endsWith("_KEY") && messageKeyPattern.test(value)) {
      registerRustMessageKey(value, location);
    }
  }

  for (const block of findCallBlocks(source, "EngineError::localized", false)) {
    const argumentsList = splitTopLevelArguments(block.text);
    registerMessageKeyArgument(
      argumentsList[2],
      `${relativePath}:${lineOf(source, block.index)}`,
    );
  }

  if (relativePath !== "crates/engine/src/error.rs") {
    for (const block of findCallBlocks(source, "with_message_key", false)) {
      const argumentsList = splitTopLevelArguments(block.text);
      registerMessageKeyArgument(
        argumentsList[0],
        `${relativePath}:${lineOf(source, block.index)}`,
      );
    }
  }
}

function groupLocations(items) {
  const groups = new Map();
  for (const item of items) {
    const locations = groups.get(item.code) ?? [];
    locations.push(item.location);
    groups.set(item.code, locations);
  }
  return groups;
}

function readTranslationEntries(path) {
  const source = readFileSync(path, "utf8");
  const entries = new Map();
  const pattern =
    /^\s*"([^"]+)"\s*:\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')/gmu;
  for (const match of source.matchAll(pattern)) {
    entries.set(match[1], match[2] ?? match[3] ?? "");
  }
  return entries;
}

function placeholders(message) {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)]
    .map((match) => match[1])
    .sort();
}

const roots = [
  join(root, "crates"),
  join(root, "src-tauri", "src"),
  join(root, "src"),
];
checkFixtures();
for (const sourceRoot of roots) {
  for (const file of walk(sourceRoot)) checkFile(file);
}

const literalGroups = groupLocations(errorCodeLiterals);
const constantGroups = groupLocations(errorCodeConstants);
for (const [code, locations] of literalGroups) {
  if (locations.length > 1) {
    failures.push(
      `duplicate EngineError code literal ${code}: ${locations.join(", ")}`,
    );
  }
  if (constantGroups.has(code)) {
    failures.push(
      `EngineError code ${code} must use its constant at ${locations.join(", ")}`,
    );
  }
}
for (const [code, locations] of constantGroups) {
  if (locations.length > 1) {
    failures.push(
      `duplicate EngineError code constant ${code}: ${locations.join(", ")}`,
    );
  }
}

for (const reference of messageKeyConstantReferences) {
  const declarations = rustStringConstants.filter(
    (constant) => constant.name === reference.name,
  );
  if (declarations.length === 0) {
    failures.push(
      `${reference.location} message key constant is not declared: ${reference.name}`,
    );
    continue;
  }
  for (const declaration of declarations) {
    registerRustMessageKey(declaration.value, declaration.location);
  }
}

const zhTranslations = readTranslationEntries(
  join(root, "src", "i18n", "zh.ts"),
);
const enTranslations = readTranslationEntries(
  join(root, "src", "i18n", "en.ts"),
);
for (const key of rustTranslationKeys) {
  const zhMessage = zhTranslations.get(key);
  const enMessage = enTranslations.get(key);
  if (zhMessage === undefined || enMessage === undefined) {
    failures.push(`Rust translation key is missing from a locale: ${key}`);
    continue;
  }
  const zhVars = placeholders(zhMessage);
  const enVars = placeholders(enMessage);
  if (zhVars.join("\0") !== enVars.join("\0")) {
    failures.push(
      `translation variables differ for ${key}: zh=[${zhVars.join(", ")}] en=[${enVars.join(", ")}]`,
    );
  }
}

if (failures.length) {
  console.error("Runtime message check failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Runtime message check passed.");
