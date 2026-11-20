/** WebDAV 完整地址校验与已保存密码的复用规则。 */
type SavedSettings = {
  url: string;
  username: string;
  hasPassword: boolean;
};

/** 输入预检只负责即时提示，后端仍执行相同的完整地址校验。 */
export function getWebdavAddressIssue(
  url: string,
): "required" | "invalid" | null {
  if (!url.trim()) return "required";
  try {
    const address = new URL(url.trim());
    return ["http:", "https:"].includes(address.protocol) &&
      address.hostname &&
      !address.username &&
      !address.password &&
      !address.search &&
      !address.hash
      ? null
      : "invalid";
  } catch {
    return "invalid";
  }
}

/** 仅配置地址与账号未变更时复用旧密码，避免将旧密码发送到其他服务。 */
export function canReuseWebdavPassword(
  settings: SavedSettings | null,
  url: string,
  username: string,
): boolean {
  return (
    !!settings?.hasPassword &&
    settings.url === url.trim() &&
    settings.username === username
  );
}
