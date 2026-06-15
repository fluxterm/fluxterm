import pkg from "../package.json";
import { formatBuildTime } from "@/utils/format";

type PackageJson = {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageJson = pkg as PackageJson;
const deps = packageJson.dependencies ?? {};
const devDeps = packageJson.devDependencies ?? {};

const getVersion = (source: Record<string, string>, name: string) =>
  source[name] ?? "unknown";

/** 提取 WebView 内核的主版本信息。 */
const detectWebViewVersion = () => {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  const chrome = ua.match(/Chrome\/([0-9.]+)/i);
  if (chrome?.[1]) return `Chrome/${chrome[1]}`;
  const appleWebKit = ua.match(/AppleWebKit\/([0-9.]+)/i);
  if (appleWebKit?.[1]) return `AppleWebKit/${appleWebKit[1]}`;
  return "unknown";
};

export const APP_VERSION = packageJson.version ?? "unknown";
const envGitHash: unknown = import.meta.env.VITE_GIT_HASH;
const envBuildTime: unknown = import.meta.env.VITE_BUILD_TIME;

export const COMMIT_HASH =
  typeof envGitHash === "string" ? envGitHash : "unknown";
export const BUILD_TIME = formatBuildTime(envBuildTime);
export const PLATFORM_ARCH = "unknown";
export const RUNTIME_INFO = `WebView ${detectWebViewVersion()}`;
export const TECH_STACK_INFO = [
  `Tauri ${getVersion(deps, "@tauri-apps/api")}`,
  `Vite ${getVersion(devDeps, "vite")}`,
  `React ${getVersion(deps, "react")}`,
  `TypeScript ${getVersion(devDeps, "typescript")}`,
].join(" · ");
