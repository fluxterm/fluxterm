import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LOG_RECORD_BYTES,
  MAX_LOG_STRING_BYTES,
  buildLogRecord,
  encodeLogRecord,
} from "./record.ts";

void test("保留连接字段并保护系统字段", () => {
  const record = buildLogRecord(
    "ssh.session.connect.succeeded",
    {
      event: "overridden",
      component: "overridden",
      host: "10.0.0.8",
      user: "root",
    },
    "operation-1",
  );
  assert.equal(record.event, "ssh.session.connect.succeeded");
  assert.equal(record.component, "webview");
  assert.equal(record.operationId, "operation-1");
  assert.equal(record.host, "10.0.0.8");
  assert.equal(record.user, "root");
});

void test("删除路径、文件名、凭据与内容字段", () => {
  const record = buildLogRecord("settings.persist.failed", {
    password: "secret",
    localPath: "C:\\Users\\someone\\settings.json",
    fileName: "settings.json",
    terminalOutput: "private output",
    prompt: "private prompt",
  });
  assert.equal(record.password, undefined);
  assert.equal(record.localPath, undefined);
  assert.equal(record.fileName, undefined);
  assert.equal(record.terminalOutput, undefined);
  assert.equal(record.prompt, undefined);
});

void test("清理循环引用和非法数值", () => {
  const cyclic: Record<string, unknown> = { value: 1 };
  cyclic.self = cyclic;
  const record = buildLogRecord("logging.record.sanitized", {
    cyclic,
    invalidNumber: Number.NaN,
  });
  assert.deepEqual(record.cyclic, { value: 1 });
  assert.equal(record.invalidNumber, undefined);
});

void test("按 UTF-8 字节截断字符串和整条记录", () => {
  const record = buildLogRecord("logging.record.large", {
    text: "终".repeat(MAX_LOG_STRING_BYTES),
    a: "a".repeat(MAX_LOG_STRING_BYTES),
    b: "b".repeat(MAX_LOG_STRING_BYTES),
    c: "c".repeat(MAX_LOG_STRING_BYTES),
    d: "d".repeat(MAX_LOG_STRING_BYTES),
    e: "e".repeat(MAX_LOG_STRING_BYTES),
    f: "f".repeat(MAX_LOG_STRING_BYTES),
    g: "g".repeat(MAX_LOG_STRING_BYTES),
    h: "h".repeat(MAX_LOG_STRING_BYTES),
  });
  assert.ok(
    new TextEncoder().encode(JSON.stringify(record)).byteLength <=
      MAX_LOG_RECORD_BYTES,
  );
  assert.equal(record.truncated, true);
});

void test("非法事件和编码异常返回安全记录", () => {
  const line = encodeLogRecord("ssh_connect:start", {});
  const record = JSON.parse(line) as { event: string };
  assert.equal(record.event, "logging.record.invalid");
});

void test("错误消息固定为事件语义并将运行期文本降级为详情", () => {
  const record = buildLogRecord("ssh.authentication.failed", {
    error: {
      code: "ssh_authentication_failed",
      message: "Authentication failed for C:\\Users\\someone\\key.pem",
    },
  });
  assert.deepEqual(record.error, {
    code: "ssh_authentication_failed",
    message: "SSH authentication failed",
    detail: "Authentication failed for [REDACTED_PATH]",
  });
});
