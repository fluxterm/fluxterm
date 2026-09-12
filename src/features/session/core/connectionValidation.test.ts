import assert from "node:assert/strict";
import test from "node:test";
import type { HostProfile } from "../../../types.ts";
import { getMissingSshConnectionFields } from "./connectionValidation.ts";

function createSshProfile(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    id: "ssh-profile",
    name: "SSH",
    host: "server.example.com",
    port: 22,
    username: "user",
    authType: "password",
    passwordRef: "secret",
    ...overrides,
  };
}

void test("SSH 密码认证一次返回全部缺失字段", () => {
  assert.deepEqual(
    getMissingSshConnectionFields(
      createSshProfile({ host: " ", username: " ", passwordRef: "" }),
    ),
    ["host", "username", "password"],
  );
});

void test("SSH 私钥和 Agent 按各自认证方式校验", () => {
  assert.deepEqual(
    getMissingSshConnectionFields(
      createSshProfile({
        authType: "privateKey",
        passwordRef: null,
        privateKeyPath: " ",
      }),
    ),
    ["privateKeyPath"],
  );
  assert.deepEqual(
    getMissingSshConnectionFields(
      createSshProfile({ authType: "agent", passwordRef: null }),
    ),
    [],
  );
});

void test("动态凭据只在前端校验主机", () => {
  assert.deepEqual(
    getMissingSshConnectionFields(
      createSshProfile({
        host: " ",
        username: "",
        passwordRef: null,
        credentialId: "ssh-credential",
      }),
    ),
    ["host"],
  );
});
