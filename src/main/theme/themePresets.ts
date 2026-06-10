/**
 * 主题预设定义。
 * 职责：集中维护结构化主题 token，作为编译 CSS 变量与终端主题的唯一来源。
 */
import type { ThemeId } from "@/types";
import type { ThemePreset } from "@/main/theme/themeContracts";

type CatppuccinFlavor = {
  rosewater: string;
  flamingo: string;
  pink: string;
  mauve: string;
  red: string;
  maroon: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  sapphire: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
};

const fontFamilyBody = '"IBM Plex Sans", "Segoe UI", sans-serif';
const fontFamilyMono =
  '"Ubuntu Mono", "JetBrains Mono", "Cascadia Mono", "Noto Sans Mono CJK SC", "Source Han Sans SC", "DejaVu Sans Mono", monospace';

const catppuccinLatte: CatppuccinFlavor = {
  rosewater: "#dc8a78",
  flamingo: "#dd7878",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  maroon: "#e64553",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  sky: "#04a5e5",
  sapphire: "#209fb5",
  blue: "#1e66f5",
  lavender: "#7287fd",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  overlay2: "#7c7f93",
  overlay1: "#8c8fa1",
  overlay0: "#9ca0b0",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
};

const catppuccinFrappe: CatppuccinFlavor = {
  rosewater: "#f2d5cf",
  flamingo: "#eebebe",
  pink: "#f4b8e4",
  mauve: "#ca9ee6",
  red: "#e78284",
  maroon: "#ea999c",
  peach: "#ef9f76",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  sky: "#99d1db",
  sapphire: "#85c1dc",
  blue: "#8caaee",
  lavender: "#babbf1",
  text: "#c6d0f5",
  subtext1: "#b5bfe2",
  subtext0: "#a5adce",
  overlay2: "#949cbb",
  overlay1: "#838ba7",
  overlay0: "#737994",
  surface2: "#626880",
  surface1: "#51576d",
  surface0: "#414559",
  base: "#303446",
  mantle: "#292c3c",
  crust: "#232634",
};

const catppuccinMacchiato: CatppuccinFlavor = {
  rosewater: "#f4dbd6",
  flamingo: "#f0c6c6",
  pink: "#f5bde6",
  mauve: "#c6a0f6",
  red: "#ed8796",
  maroon: "#ee99a0",
  peach: "#f5a97f",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  sky: "#91d7e3",
  sapphire: "#7dc4e4",
  blue: "#8aadf4",
  lavender: "#b7bdf8",
  text: "#cad3f5",
  subtext1: "#b8c0e0",
  subtext0: "#a5adcb",
  overlay2: "#939ab7",
  overlay1: "#8087a2",
  overlay0: "#6e738d",
  surface2: "#5b6078",
  surface1: "#494d64",
  surface0: "#363a4f",
  base: "#24273a",
  mantle: "#1e2030",
  crust: "#181926",
};

const catppuccinMocha: CatppuccinFlavor = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
};

/** Catppuccin 系列主题仅复用其公开配色。*/
function rgbaFromHex(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function createCatppuccinPreset(input: {
  labelKey:
    | "theme.catppuccinLatte"
    | "theme.catppuccinFrappe"
    | "theme.catppuccinMacchiato"
    | "theme.catppuccinMocha";
  flavor: CatppuccinFlavor;
  mode: "light" | "dark";
}): ThemePreset {
  const { labelKey, flavor, mode } = input;
  const isLight = mode === "light";
  return {
    labelKey,
    foundation: {
      typography: {
        fontFamilyBody,
        fontFamilyMono,
        textPrimary: flavor.text,
        textSecondary: flavor.subtext1,
        textTertiary: flavor.subtext0,
        textMuted: isLight ? flavor.overlay1 : flavor.overlay0,
        textSoft: isLight ? flavor.subtext1 : flavor.text,
        textQuiet: flavor.overlay1,
      },
      accent: {
        default: flavor.blue,
        strong: flavor.lavender,
        contrast: isLight ? flavor.base : flavor.crust,
        soft: rgbaFromHex(flavor.blue, isLight ? 0.2 : 0.24),
        subtle: rgbaFromHex(flavor.blue, isLight ? 0.1 : 0.14),
      },
      effects: {
        shadowStrong: isLight
          ? "0 18px 38px rgba(76, 79, 105, 0.12)"
          : "0 18px 38px rgba(17, 17, 27, 0.42)",
        brandGlow: `0 0 18px ${rgbaFromHex(flavor.blue, isLight ? 0.2 : 0.18)}`,
      },
    },
    semantic: {
      background: {
        appBase: flavor.base,
        appGradient: isLight
          ? `linear-gradient(160deg, ${flavor.base} 0%, ${flavor.mantle} 52%, ${flavor.crust} 100%)`
          : `linear-gradient(160deg, ${flavor.crust} 0%, ${flavor.base} 48%, ${flavor.mantle} 100%)`,
        appImage: "none",
        appOverlay: "none",
      },
      surface: {
        canvas: isLight ? flavor.mantle : flavor.crust,
        base: flavor.mantle,
        strong: isLight ? flavor.crust : flavor.mantle,
        alt: flavor.crust,
        panel: flavor.mantle,
        elevated: flavor.base,
        header: flavor.mantle,
        headerStrong: isLight ? flavor.crust : flavor.mantle,
        menu: flavor.base,
      },
      border: {
        weak: rgbaFromHex(flavor.overlay2, isLight ? 0.16 : 0.18),
        soft: rgbaFromHex(flavor.overlay1, isLight ? 0.12 : 0.14),
        strong: rgbaFromHex(flavor.overlay2, isLight ? 0.24 : 0.26),
        input: rgbaFromHex(flavor.overlay2, isLight ? 0.22 : 0.24),
        focus: flavor.blue,
      },
      feedback: {
        success: flavor.green,
        successSoft: rgbaFromHex(flavor.green, isLight ? 0.14 : 0.18),
        warning: flavor.yellow,
        warningSoft: rgbaFromHex(flavor.yellow, isLight ? 0.14 : 0.18),
        info: flavor.sky,
        infoSoft: rgbaFromHex(flavor.sky, isLight ? 0.14 : 0.18),
        danger: flavor.red,
        dangerSoft: rgbaFromHex(flavor.red, isLight ? 0.14 : 0.18),
      },
    },
    component: {
      button: {
        bg: isLight ? flavor.base : flavor.surface0,
        bgStrong: isLight ? flavor.surface0 : flavor.surface1,
        text: flavor.text,
      },
      input: {
        bg: isLight ? flavor.base : flavor.surface0,
        text: flavor.text,
      },
      tabs: {
        bg: isLight ? flavor.base : flavor.surface0,
        border: rgbaFromHex(flavor.overlay2, isLight ? 0.18 : 0.22),
      },
      layout: {
        resizerBg: rgbaFromHex(flavor.overlay1, isLight ? 0.12 : 0.1),
      },
      progress: {
        gradient: `linear-gradient(120deg, ${flavor.blue}, ${flavor.mauve})`,
      },
    },
    terminal: {
      background: flavor.base,
      foreground: flavor.text,
      selectionBackground: rgbaFromHex(flavor.blue, isLight ? 0.18 : 0.24),
      selectionForeground: isLight ? flavor.crust : flavor.text,
      cursor: flavor.rosewater,
      cursorAccent: flavor.base,
      searchMatchBackground: rgbaFromHex(flavor.yellow, isLight ? 0.18 : 0.22),
      searchMatchBorder: flavor.yellow,
      searchMatchOverviewRuler: flavor.yellow,
      searchActiveMatchBackground: rgbaFromHex(
        flavor.blue,
        isLight ? 0.16 : 0.22,
      ),
      searchActiveMatchBorder: flavor.blue,
      searchActiveMatchOverviewRuler: flavor.blue,
      ansi: {
        black: flavor.surface1,
        red: flavor.red,
        green: flavor.green,
        yellow: flavor.yellow,
        blue: flavor.blue,
        magenta: flavor.pink,
        cyan: flavor.teal,
        white: flavor.subtext1,
        brightBlack: flavor.surface2,
        brightRed: flavor.maroon,
        brightGreen: flavor.green,
        brightYellow: flavor.peach,
        brightBlue: flavor.lavender,
        brightMagenta: flavor.mauve,
        brightCyan: flavor.sky,
        brightWhite: flavor.text,
      },
    },
  };
}

/**
 * 内置主题预设集合。
 * 每个预设都必须完整实现标准主题结构，以便被 CSS 与终端编译器直接消费。
 */
export const themePresets: Record<ThemeId, ThemePreset> = {
  dark: {
    labelKey: "theme.dark",
    foundation: {
      typography: {
        fontFamilyBody,
        fontFamilyMono,
        textPrimary: "#f8fafc",
        textSecondary: "#cbd5e1",
        textTertiary: "#94a3b8",
        textMuted: "#aab8cb",
        textSoft: "#d7e0ec",
        textQuiet: "#7b8aa0",
      },
      accent: {
        default: "#3794ff",
        strong: "#5aa8ff",
        contrast: "#1e1e1e",
        soft: "rgba(55, 148, 255, 0.26)",
        subtle: "rgba(55, 148, 255, 0.14)",
      },
      effects: {
        shadowStrong: "0 18px 38px rgba(0, 0, 0, 0.38)",
        brandGlow: "0 0 16px rgba(55, 148, 255, 0.16)",
      },
    },
    semantic: {
      background: {
        appBase: "#1e1e1e",
        appGradient:
          "linear-gradient(160deg, #1b1b1b 0%, #202020 48%, #1f1f1f 100%)",
        appImage: "none",
        appOverlay: "none",
      },
      surface: {
        canvas: "#161616",
        base: "#252526",
        strong: "#1f1f1f",
        alt: "#2a2d2e",
        panel: "#252526",
        elevated: "#313335",
        header: "#252526",
        headerStrong: "#1f1f1f",
        menu: "#252526",
      },
      border: {
        weak: "rgba(255, 255, 255, 0.09)",
        soft: "rgba(255, 255, 255, 0.06)",
        strong: "rgba(255, 255, 255, 0.16)",
        input: "rgba(255, 255, 255, 0.14)",
        focus: "#3794ff",
      },
      feedback: {
        success: "#4ade80",
        successSoft: "rgba(74, 222, 128, 0.18)",
        warning: "#fbbf24",
        warningSoft: "rgba(251, 191, 36, 0.18)",
        info: "#60a5fa",
        infoSoft: "rgba(96, 165, 250, 0.18)",
        danger: "#f87171",
        dangerSoft: "rgba(248, 113, 113, 0.18)",
      },
    },
    component: {
      button: {
        bg: "#2a2d2e",
        bgStrong: "#333639",
        text: "#f8fafc",
      },
      input: {
        bg: "#1f1f1f",
        text: "#f8fafc",
      },
      tabs: {
        bg: "#2a2d2e",
        border: "rgba(255, 255, 255, 0.12)",
      },
      layout: {
        resizerBg: "rgba(255, 255, 255, 0.06)",
      },
      progress: {
        gradient: "linear-gradient(120deg, #3794ff, #4ade80)",
      },
    },
    terminal: {
      background: "#1e1e1e",
      foreground: "#edf2f7",
      selectionBackground: "rgba(38, 79, 120, 0.48)",
      selectionForeground: "#f8fbff",
      cursor: "#f8fafc",
      cursorAccent: "#1e1e1e",
      searchMatchBackground: "rgba(251, 191, 36, 0.22)",
      searchMatchBorder: "#fbbf24",
      searchMatchOverviewRuler: "#fbbf24",
      searchActiveMatchBackground: "rgba(55, 148, 255, 0.22)",
      searchActiveMatchBorder: "#3794ff",
      searchActiveMatchOverviewRuler: "#3794ff",
      ansi: {
        black: "#2d2d2d",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#3794ff",
        magenta: "#c084fc",
        cyan: "#45c1cf",
        white: "#cbd5e1",
        brightBlack: "#808080",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#5aa8ff",
        brightMagenta: "#d8b4fe",
        brightCyan: "#8dd9e2",
        brightWhite: "#f8fafc",
      },
    },
  },
  light: {
    labelKey: "theme.light",
    foundation: {
      typography: {
        fontFamilyBody,
        fontFamilyMono,
        textPrimary: "#0f172a",
        textSecondary: "#334155",
        textTertiary: "#64748b",
        textMuted: "#526277",
        textSoft: "#1f2937",
        textQuiet: "#7b8798",
      },
      accent: {
        default: "#2563eb",
        strong: "#1d4ed8",
        contrast: "#f8fafc",
        soft: "rgba(37, 99, 235, 0.24)",
        subtle: "rgba(37, 99, 235, 0.12)",
      },
      effects: {
        shadowStrong: "0 18px 38px rgba(15, 23, 42, 0.12)",
        brandGlow: "0 0 18px rgba(37, 99, 235, 0.16)",
      },
    },
    semantic: {
      background: {
        appBase: "#f3f7fb",
        appGradient:
          "linear-gradient(160deg, #f7fafc 0%, #edf3f9 52%, #e8eef6 100%)",
        appImage: "none",
        appOverlay: "none",
      },
      surface: {
        canvas: "#edf2f7",
        base: "#ffffff",
        strong: "#f8fbff",
        alt: "#eef3f9",
        panel: "#f6f9fd",
        elevated: "#ffffff",
        header: "#f1f5f9",
        headerStrong: "#e8eef6",
        menu: "#ffffff",
      },
      border: {
        weak: "rgba(51, 65, 85, 0.14)",
        soft: "rgba(51, 65, 85, 0.1)",
        strong: "rgba(51, 65, 85, 0.22)",
        input: "rgba(51, 65, 85, 0.2)",
        focus: "#2563eb",
      },
      feedback: {
        success: "#15803d",
        successSoft: "rgba(21, 128, 61, 0.14)",
        warning: "#b45309",
        warningSoft: "rgba(180, 83, 9, 0.14)",
        info: "#1d4ed8",
        infoSoft: "rgba(29, 78, 216, 0.14)",
        danger: "#dc2626",
        dangerSoft: "rgba(220, 38, 38, 0.14)",
      },
    },
    component: {
      button: {
        bg: "#e9f0f8",
        bgStrong: "#dce8f6",
        text: "#0f172a",
      },
      input: {
        bg: "#ffffff",
        text: "#0f172a",
      },
      tabs: {
        bg: "#eef4fb",
        border: "rgba(51, 65, 85, 0.18)",
      },
      layout: {
        resizerBg: "rgba(51, 65, 85, 0.1)",
      },
      progress: {
        gradient: "linear-gradient(120deg, #2563eb, #15803d)",
      },
    },
    terminal: {
      background: "#f5f7fb",
      foreground: "#0f172a",
      selectionBackground: "rgba(37, 99, 235, 0.18)",
      selectionForeground: "#0b1324",
      cursor: "#0f172a",
      cursorAccent: "#f5f7fb",
      searchMatchBackground: "rgba(180, 83, 9, 0.16)",
      searchMatchBorder: "#b45309",
      searchMatchOverviewRuler: "#b45309",
      searchActiveMatchBackground: "rgba(37, 99, 235, 0.16)",
      searchActiveMatchBorder: "#2563eb",
      searchActiveMatchOverviewRuler: "#2563eb",
      ansi: {
        black: "#334155",
        red: "#dc2626",
        green: "#15803d",
        yellow: "#a16207",
        blue: "#2563eb",
        magenta: "#9333ea",
        cyan: "#0f766e",
        white: "#64748b",
        brightBlack: "#475569",
        brightRed: "#ef4444",
        brightGreen: "#16a34a",
        brightYellow: "#ca8a04",
        brightBlue: "#1d4ed8",
        brightMagenta: "#a855f7",
        brightCyan: "#0891b2",
        brightWhite: "#0f172a",
      },
    },
  },
  "catppuccin-latte": createCatppuccinPreset({
    labelKey: "theme.catppuccinLatte",
    flavor: catppuccinLatte,
    mode: "light",
  }),
  "catppuccin-frappe": createCatppuccinPreset({
    labelKey: "theme.catppuccinFrappe",
    flavor: catppuccinFrappe,
    mode: "dark",
  }),
  "catppuccin-macchiato": createCatppuccinPreset({
    labelKey: "theme.catppuccinMacchiato",
    flavor: catppuccinMacchiato,
    mode: "dark",
  }),
  "catppuccin-mocha": createCatppuccinPreset({
    labelKey: "theme.catppuccinMocha",
    flavor: catppuccinMocha,
    mode: "dark",
  }),
};
