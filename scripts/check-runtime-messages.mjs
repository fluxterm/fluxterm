import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  "i18n",
]);
const sourceExtensions = new Set([".rs", ".ts", ".tsx"]);
const hanPattern = /\p{Script=Han}/u;

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

if (failures.length) {
  console.error("Runtime message check failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Runtime message check passed.");
