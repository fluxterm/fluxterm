import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

let gitHash: string | undefined;
let buildTime: string | undefined;
const getGitHash = () => {
  if (gitHash !== undefined) return gitHash;
  try {
    gitHash = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    gitHash = "";
  }
  return gitHash;
};

const getBuildTime = () => {
  if (buildTime !== undefined) return buildTime;
  buildTime = new Date().toISOString();
  return buildTime;
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_GIT_HASH": JSON.stringify(getGitHash()),
    "import.meta.env.VITE_BUILD_TIME": JSON.stringify(getBuildTime()),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/crates/**"],
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom)(?:[\\/]|$)/,
              priority: 30,
            },
            {
              name: "vendor-markdown",
              test: /node_modules[\\/](react-markdown|remark-gfm)(?:[\\/]|$)/,
              priority: 20,
            },
            {
              name: "vendor-tauri",
              test: /node_modules[\\/]@tauri-apps[\\/](api|plugin-log|plugin-window-state)(?:[\\/]|$)/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
}));
