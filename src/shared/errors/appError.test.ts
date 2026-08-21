import assert from "node:assert/strict";
import test from "node:test";
import type { Translate } from "../../i18n/index.ts";
import {
  AppError,
  normalizeToAppError,
  translateAppError,
} from "./appError.ts";

const translate = ((key, vars) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key) satisfies Translate;

void test("归一化标准后端错误载荷并隔离诊断上下文", () => {
  const error = normalizeToAppError(
    {
      code: "ssh_auth_failed",
      message: "SSH authentication failed",
      messageKey: "error.ssh.auth.rejected",
      messageVars: { host: "127.0.0.1", attempt: 2 },
      details: "Permission denied",
    },
    {
      code: "tauri_invoke_error",
      source: "tauri",
      diagnostic: { command: "session_connect" },
    },
  );

  assert.equal(error.code, "ssh_auth_failed");
  assert.equal(error.message, "SSH authentication failed");
  assert.equal(error.details, "Permission denied");
  assert.deepEqual(error.messageVars, { host: "127.0.0.1", attempt: 2 });
  assert.deepEqual(error.diagnostic, {
    context: { command: "session_connect" },
    raw: {
      code: "ssh_auth_failed",
      message: "SSH authentication failed",
      messageKey: "error.ssh.auth.rejected",
      messageVars: { host: "127.0.0.1", attempt: 2 },
      details: "Permission denied",
    },
  });
});

void test("解析 JSON 字符串形式的后端错误", () => {
  const error = normalizeToAppError(
    JSON.stringify({
      code: "serial_open_failed",
      message: "Failed to open serial port",
      messageKey: "error.serial.operationFailed",
    }),
    { code: "tauri_invoke_error", source: "tauri" },
  );

  assert.equal(error.code, "serial_open_failed");
  assert.equal(error.messageKey, "error.serial.operationFailed");
});

void test("翻译有效键并向翻译函数传递变量", () => {
  const error = new AppError({
    code: "serial_port_in_use",
    message: "Serial port is already in use",
    messageKey: "error.serial.portInUse",
    messageVars: { portName: "COM3" },
  });

  assert.equal(
    translateAppError(error, translate),
    'error.serial.portInUse:{"portName":"COM3"}',
  );
});

void test("领域默认键仍按标准翻译键处理", () => {
  const error = new AppError({
    code: "ssh_connect_failed",
    message: "Failed to connect to target host",
    messageKey: "error.ssh.operationFailed",
  });

  assert.equal(
    translateAppError(error, translate),
    "error.ssh.operationFailed",
  );
});

void test("无效翻译键回退英文消息", () => {
  const error = new AppError({
    code: "unknown_error",
    message: "Operation failed",
    messageKey: "error.not.registered",
  });

  assert.equal(translateAppError(error, translate), "Operation failed");
});

void test("错误码与翻译键不能混用命名格式", () => {
  const mixedCode = normalizeToAppError(
    {
      code: "error.ssh.failed",
      message: "Invalid error code format",
    },
    { code: "tauri_invoke_error", source: "tauri" },
  );
  const mixedMessageKey = new AppError({
    code: "ssh_connect_failed",
    message: "Invalid message key format",
    messageKey: "error_ssh_connect_failed",
  });

  assert.equal(mixedCode.code, "tauri_invoke_error");
  assert.equal(mixedMessageKey.messageKey, undefined);
  assert.equal(
    translateAppError(mixedMessageKey, translate),
    "Invalid message key format",
  );
});

void test("拒绝包含非字符串或数字的翻译变量", () => {
  const error = normalizeToAppError(
    {
      code: "invalid_vars",
      message: "Invalid translation variables",
      messageVars: { enabled: true },
    },
    { code: "tauri_invoke_error", source: "tauri" },
  );

  assert.equal(error.messageVars, undefined);
});

void test("归一化普通 Error、未知对象和普通字符串", () => {
  const native = normalizeToAppError(new Error("Native failure"), {
    code: "frontend_error",
    source: "frontend",
  });
  const record = normalizeToAppError(
    { reason: "Record failure" },
    {
      code: "unknown_error",
      source: "frontend",
    },
  );
  const text = normalizeToAppError("Text failure", {
    code: "unknown_error",
    source: "frontend",
  });

  assert.equal(native.message, "Native failure");
  assert.equal(record.message, "Record failure");
  assert.equal(text.message, "Text failure");
});
