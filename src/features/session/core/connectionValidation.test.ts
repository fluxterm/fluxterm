import assert from "node:assert/strict";
import test from "node:test";
import type { HostProfile, RdpProfile } from "../../../types.ts";
import {
  getMissingRdpConnectionFields,
  getMissingSshConnectionFields,
} from "./connectionValidation.ts";

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

function createRdpProfile(overrides: Partial<RdpProfile> = {}): RdpProfile {
  return {
    id: "rdp-profile",
    name: "RDP",
    host: "server.example.com",
    port: 3389,
    username: "user",
    passwordRef: "secret",
    ignoreCertificate: false,
    resolutionMode: "window_sync",
    displayStrategy: "fit",
    clipboardMode: "text",
    reconnectPolicy: {
      enabled: true,
      maxAttempts: 3,
    },
    performanceFlags: {
      wallpaper: true,
      fullWindowDrag: true,
      menuAnimations: true,
      theming: true,
      cursorShadow: true,
      cursorSettings: true,
      fontSmoothing: true,
      desktopComposition: true,
    },
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
  assert.deepEqual(
    getMissingRdpConnectionFields(
      createRdpProfile({
        username: "",
        passwordRef: null,
        credentialId: "rdp-credential",
      }),
    ),
    [],
  );
});

void test("RDP 一次返回全部缺失字段且保留空格密码语义", () => {
  assert.deepEqual(
    getMissingRdpConnectionFields(
      createRdpProfile({ host: " ", username: " ", passwordRef: "" }),
    ),
    ["host", "username", "password"],
  );
  assert.deepEqual(
    getMissingRdpConnectionFields(createRdpProfile({ passwordRef: " " })),
    [],
  );
});
