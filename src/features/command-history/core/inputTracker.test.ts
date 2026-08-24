import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalAutocompleteEditingInput,
  resolveTerminalCursorDirection,
  updateCommandInputBuffer,
} from "./inputTracker.ts";

void test("仅将可能修改命令行的输入识别为联想编辑意图", () => {
  assert.equal(isTerminalAutocompleteEditingInput("git status"), true);
  assert.equal(isTerminalAutocompleteEditingInput("\u007f"), true);
  assert.equal(isTerminalAutocompleteEditingInput("\t"), true);
  assert.equal(isTerminalAutocompleteEditingInput("\u0015"), true);
  assert.equal(isTerminalAutocompleteEditingInput("\u001bOA"), false);
  assert.equal(isTerminalAutocompleteEditingInput("\u001b[A"), false);
  assert.equal(isTerminalAutocompleteEditingInput("\u001b[1;5D"), false);
  assert.equal(isTerminalAutocompleteEditingInput("\u001bOP"), false);
  assert.equal(isTerminalAutocompleteEditingInput("\u001bf"), false);
  assert.equal(
    isTerminalAutocompleteEditingInput("\u001b[200~git\u001b[201~"),
    true,
  );
  assert.equal(isTerminalAutocompleteEditingInput("\u001b"), false);
  assert.equal(isTerminalAutocompleteEditingInput("\r"), false);
});

void test("X10 与 SGR 鼠标报告不会被识别为命令编辑", () => {
  const x10MouseReport = `\u001b[M${String.fromCharCode(32, 40, 50)}`;
  assert.equal(isTerminalAutocompleteEditingInput(x10MouseReport), false);
  assert.equal(isTerminalAutocompleteEditingInput("\u001b[<0;8;18M"), false);
  assert.equal(
    isTerminalAutocompleteEditingInput(`${x10MouseReport}git`),
    true,
  );
  assert.deepEqual(updateCommandInputBuffer("git", x10MouseReport), {
    buffer: "git",
    commits: [],
  });
});

void test("解析 CSI 与 SS3 方向键序列", () => {
  assert.equal(resolveTerminalCursorDirection("\u001b[A"), "up");
  assert.equal(resolveTerminalCursorDirection("\u001b[B"), "down");
  assert.equal(resolveTerminalCursorDirection("\u001b[C"), "right");
  assert.equal(resolveTerminalCursorDirection("\u001b[D"), "left");
  assert.equal(resolveTerminalCursorDirection("\u001bOA"), "up");
  assert.equal(resolveTerminalCursorDirection("\u001bOB"), "down");
  assert.equal(resolveTerminalCursorDirection("\u001bOC"), "right");
  assert.equal(resolveTerminalCursorDirection("\u001bOD"), "left");
});

void test("方向键控制序列不会污染命令输入缓冲", () => {
  for (const sequence of [
    "\u001b[A",
    "\u001b[B",
    "\u001b[C",
    "\u001b[D",
    "\u001bOA",
    "\u001bOB",
    "\u001bOC",
    "\u001bOD",
  ]) {
    assert.deepEqual(updateCommandInputBuffer("git", sequence), {
      buffer: "git",
      commits: [],
    });
  }
});

void test("混合文本仅保留真实输入内容", () => {
  assert.deepEqual(
    updateCommandInputBuffer(
      "",
      "git\u001bOA status\u001b[1;5D\u001bOP\u001bf",
    ),
    {
      buffer: "git status",
      commits: [],
    },
  );
});

void test("保留文本、退格与命令提交语义", () => {
  assert.deepEqual(updateCommandInputBuffer("gi", "t\u007f status\r"), {
    buffer: "",
    commits: [{ command: "gi status", source: "typed" }],
  });
});
