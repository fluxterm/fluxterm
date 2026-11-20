import assert from "node:assert/strict";
import test from "node:test";
import {
  canReuseWebdavPassword,
  getWebdavAddressIssue,
} from "./webdavSettings.ts";

void test("空地址即时提示必填，不与压缩包或凭据错误混淆", () => {
  assert.equal(getWebdavAddressIssue(""), "required");
  assert.equal(getWebdavAddressIssue("  "), "required");
  for (const url of [
    "not-a-url",
    "ftp://nas/",
    "http://user:pass@nas/",
    "https://nas/dav?query=1",
    "https://nas/#fragment",
  ])
    assert.equal(getWebdavAddressIssue(url), "invalid");
  assert.equal(getWebdavAddressIssue("http://nas/dav/backups/"), null);
  assert.equal(getWebdavAddressIssue("https://nas/配置/"), null);
});

void test("完整 URL 中的目录作为密码复用条件", () => {
  const settings = {
    url: "http://nas/dav/%E9%85%8D%E7%BD%AE/a%252Fb/",
    username: "user",
    hasPassword: true,
  };
  assert.equal(getWebdavAddressIssue(settings.url), null);
  assert.equal(canReuseWebdavPassword(settings, settings.url, "user"), true);
  assert.equal(
    canReuseWebdavPassword(settings, "http://nas/dav/other/", "user"),
    false,
  );
});

void test("地址或账号变更后不复用旧密码，清空配置后不再存在密码引用", () => {
  const settings = {
    url: "https://nas/dav/",
    username: "user",
    hasPassword: true,
  };
  assert.equal(
    canReuseWebdavPassword(settings, "https://other/dav/", "user"),
    false,
  );
  assert.equal(canReuseWebdavPassword(settings, settings.url, "other"), false);
  assert.equal(
    canReuseWebdavPassword(
      { ...settings, hasPassword: false },
      settings.url,
      "user",
    ),
    false,
  );
  assert.equal(canReuseWebdavPassword(null, "", "user"), false);
});
