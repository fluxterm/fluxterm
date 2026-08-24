/**
 * 输入缓冲辅助工具。
 * 职责：
 * 1. 维护联想面板使用的“本地输入缓冲”。
 * 2. 提供历史命令项 id 与列表裁剪等通用工具。
 */
import type { CommandHistoryItem, CommandHistorySource } from "@/types";

export type TrackedCommandCommit = {
  command: string;
  source: CommandHistorySource;
};

type InputBufferUpdateResult = {
  buffer: string;
  commits: TrackedCommandCommit[];
};

export type TerminalCursorDirection = "up" | "down" | "left" | "right";

const TERMINAL_CURSOR_SEQUENCES: Record<string, TerminalCursorDirection> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\u001bOC": "right",
  "\u001bOD": "left",
};

const TERMINAL_ESCAPE_SEQUENCE_PATTERN =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|O[ -~]|[^\u001b])/g;

// X10/DEFAULT 鼠标报告在 CSI M 后携带三个坐标字节，必须先于普通 CSI 序列整体移除。
const TERMINAL_X10_MOUSE_SEQUENCE_PATTERN = /\u001b\[M[\u0020-\u00ff]{3}/g;

/** 清理终端输入中的控制序列，同时保留同一批数据里的真实文本。 */
function stripTerminalControlSequences(data: string) {
  return data
    .replace(TERMINAL_X10_MOUSE_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_ESCAPE_SEQUENCE_PATTERN, "");
}

/** 解析普通光标模式（CSI）与应用光标模式（SS3）的方向键序列。 */
export function resolveTerminalCursorDirection(data: string) {
  return TERMINAL_CURSOR_SEQUENCES[data] ?? null;
}

/** 判断终端输入是否可能修改 shell 当前命令行。 */
export function isTerminalAutocompleteEditingInput(data: string) {
  const cleaned = stripTerminalControlSequences(data);
  if (!cleaned || cleaned === "\r" || cleaned === "\n") {
    return false;
  }
  return [...cleaned].some(
    (char) =>
      char >= " " ||
      char === "\t" ||
      char === "\b" ||
      char === "\u007f" ||
      char === "\u000b" ||
      char === "\u0015" ||
      char === "\u0017",
  );
}

/** 创建稳定命令 id，便于 React 列表和持久化复用。 */
export function createCommandHistoryItemId(command: string, timestamp: number) {
  return `${timestamp}-${command}`;
}

/**
 * 根据键盘输入流更新当前输入缓冲。
 * 该缓冲只用于联想输入跟踪，不代表 shell 最终执行的真实命令。
 */
export function updateCommandInputBuffer(buffer: string, data: string) {
  const cleaned = stripTerminalControlSequences(data);
  let nextBuffer = buffer;
  const commits: TrackedCommandCommit[] = [];

  for (const char of cleaned) {
    if (char === "\r" || char === "\n") {
      const command = nextBuffer.trim();
      if (command) {
        commits.push({ command, source: "typed" });
      }
      nextBuffer = "";
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }
    if (char >= " ") {
      nextBuffer += char;
    }
  }

  return {
    buffer: nextBuffer,
    commits,
  } satisfies InputBufferUpdateResult;
}

/** 按最近使用时间裁剪命令历史，避免单个作用域无限增长。 */
export function trimHistoryItems(
  items: CommandHistoryItem[],
  limit: number,
): CommandHistoryItem[] {
  return [...items]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, Math.max(limit, 1));
}
