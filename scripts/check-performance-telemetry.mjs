import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const root = process.cwd();
const failures = [];
const catalog = JSON.parse(
  readFileSync(join(root, "docs", "performance-metrics.json"), "utf8"),
);
let metricsSource = "";
try {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
  const protocolPackage = metadata.packages.find(
    (candidate) => candidate.name === "fluxterm-pulse-protocol",
  );
  if (!protocolPackage) {
    failures.push("Pulse Protocol package is missing from Cargo metadata");
  } else {
    metricsSource = readFileSync(
      join(dirname(protocolPackage.manifest_path), "src", "v1", "metric.rs"),
      "utf8",
    );
  }
} catch {
  failures.push("Pulse Protocol metric catalog could not be loaded");
}
const crateSource = readFileSync(
  join(root, "crates", "performance_telemetry", "src", "lib.rs"),
  "utf8",
);
const configSource = readFileSync(
  join(root, "src-tauri", "src", "config_paths.rs"),
  "utf8",
);
const frontendSource = readFileSync(
  join(root, "src", "subapps", "rdp", "performanceTelemetry.ts"),
  "utf8",
);

function fail(message) {
  failures.push(message);
}

if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.metrics)) {
  fail("performance metric catalog schema is invalid");
}

const catalogNames = new Set();
for (const metric of catalog.metrics ?? []) {
  if (
    typeof metric.name !== "string" ||
    !/^fluxterm\.(?:sftp|rdp)\.[a-z0-9_.]+$/u.test(metric.name)
  ) {
    fail(`invalid metric name: ${String(metric.name)}`);
  }
  if (catalogNames.has(metric.name)) {
    fail(`duplicate metric: ${metric.name}`);
  }
  catalogNames.add(metric.name);
  if (!["gauge", "counterDelta", "histogram"].includes(metric.kind)) {
    fail(`invalid metric kind: ${metric.name}`);
  }
}

const sourceNames = new Set(
  [...metricsSource.matchAll(/metric!\(\s*"([^"]+)"/gu)].map(
    (match) => match[1],
  ),
);
for (const name of catalogNames) {
  if (!sourceNames.has(name)) fail(`catalog metric missing in Rust: ${name}`);
}
for (const name of sourceNames) {
  if (!catalogNames.has(name)) fail(`Rust metric missing in catalog: ${name}`);
}

if (/fluxterm[_-]logging|log_event!/u.test(crateSource)) {
  fail("performance telemetry crate must not depend on structured logging");
}
if (!/app_config_dir\(\)/u.test(configSource)) {
  fail("performance telemetry config must use app_config_dir");
}
if (
  !/performance-telemetry-device\.json/u.test(configSource) ||
  !/StreamTarget/u.test(crateSource) ||
  !/StreamCorrelation/u.test(crateSource)
) {
  fail("performance telemetry device and connection identity contract is missing");
}
if (
  /resolve_performance_telemetry_config_path[\s\S]*?app_data_dir\(\)/u.test(
    configSource,
  )
) {
  fail("performance telemetry config must not use app_data_dir");
}
if (/\bsetInterval\s*\(|\brequestAnimationFrame\s*\(/u.test(frontendSource)) {
  fail("RDP telemetry collector must reuse the existing RAF");
}

if (failures.length > 0) {
  process.stderr.write(
    `Performance telemetry check failed:\n- ${failures.join("\n- ")}\n`,
  );
  process.exit(1);
}

process.stdout.write("Performance telemetry check passed.\n");
