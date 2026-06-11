/** 终端字体选择模式。 */
export type TerminalFontFamilyMode =
  | "system"
  | "jetbrains-mono"
  | "cascadia-mono"
  | "sf-mono"
  | "menlo"
  | "consolas"
  | "ubuntu-mono"
  | "dejavu-sans-mono";

/** 终端默认系统优先字体栈。 */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Cascadia Mono", "SF Mono", Menlo, Consolas, "Ubuntu Mono", "DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Source Han Sans SC", "JetBrains Mono", monospace';

/** 默认终端字体选择模式。 */
export const DEFAULT_TERMINAL_FONT_FAMILY_MODE: TerminalFontFamilyMode =
  "system";

/** 终端字体选项定义。 */
export const TERMINAL_FONT_FAMILY_OPTIONS: Array<{
  mode: TerminalFontFamilyMode;
  fontFamily: string;
}> = [
  {
    mode: "system",
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  },
  {
    mode: "jetbrains-mono",
    fontFamily:
      '"JetBrains Mono", "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
  {
    mode: "cascadia-mono",
    fontFamily:
      '"Cascadia Mono", "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
  {
    mode: "sf-mono",
    fontFamily:
      '"SF Mono", Menlo, "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
  {
    mode: "menlo",
    fontFamily:
      'Menlo, "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
  {
    mode: "consolas",
    fontFamily:
      'Consolas, "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
  {
    mode: "ubuntu-mono",
    fontFamily:
      '"Ubuntu Mono", "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
  {
    mode: "dejavu-sans-mono",
    fontFamily:
      '"DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Source Han Sans SC", monospace',
  },
];

/** 归一化终端字体模式。 */
export function normalizeTerminalFontFamilyMode(
  value: unknown,
): TerminalFontFamilyMode | null {
  if (
    value === "system" ||
    value === "jetbrains-mono" ||
    value === "cascadia-mono" ||
    value === "sf-mono" ||
    value === "menlo" ||
    value === "consolas" ||
    value === "ubuntu-mono" ||
    value === "dejavu-sans-mono"
  ) {
    return value;
  }
  return null;
}

/** 解析 xterm 最终使用的 fontFamily。 */
export function resolveTerminalFontFamily(mode: TerminalFontFamilyMode) {
  return (
    TERMINAL_FONT_FAMILY_OPTIONS.find((item) => item.mode === mode)
      ?.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY
  );
}
