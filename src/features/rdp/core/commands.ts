import { createOperationId } from "@/shared/logging";
import { invokeTauriCommand } from "@/shared/tauri/commands";
import type { RdpInputEvent, RdpProfile, RdpSessionSnapshot } from "@/types";

type RdpCommandOptions = {
  operationId?: string;
};

function resolveOperationId(options?: RdpCommandOptions) {
  return options?.operationId ?? createOperationId();
}

/** 读取 RDP Profile 列表。 */
export function listRdpProfiles(options?: RdpCommandOptions) {
  return invokeTauriCommand<RdpProfile[]>("rdp_profile_list", {
    operationId: resolveOperationId(options),
  });
}

/** 读取 RDP 分组列表。 */
export function listRdpProfileGroups(options?: RdpCommandOptions) {
  return invokeTauriCommand<string[]>("rdp_profile_groups_list", {
    operationId: resolveOperationId(options),
  });
}

/** 保存 RDP 分组列表。 */
export function saveRdpProfileGroups(
  groups: string[],
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<string[]>("rdp_profile_groups_save", {
    groups,
    operationId: resolveOperationId(options),
  });
}

/** 保存 RDP Profile。 */
export function saveRdpProfile(
  profile: RdpProfile,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<RdpProfile>("rdp_profile_save", {
    profile,
    operationId: resolveOperationId(options),
  });
}

/** 删除 RDP Profile。 */
export function deleteRdpProfile(
  profileId: string,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<boolean>("rdp_profile_delete", {
    profileId,
    operationId: resolveOperationId(options),
  });
}

/** 创建 RDP 会话。 */
export function createRdpSession(
  profileId: string,
  initialSize?: { width: number; height: number },
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<RdpSessionSnapshot>("rdp_session_create", {
    profileId,
    width: initialSize?.width,
    height: initialSize?.height,
    operationId: resolveOperationId(options),
  });
}

/** 建立 RDP 会话桥接。 */
export function connectRdpSession(
  sessionId: string,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<RdpSessionSnapshot>("rdp_session_connect", {
    sessionId,
    operationId: resolveOperationId(options),
  });
}

/** 断开 RDP 会话。 */
export function disconnectRdpSession(
  sessionId: string,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<RdpSessionSnapshot>("rdp_session_disconnect", {
    sessionId,
    operationId: resolveOperationId(options),
  });
}

/** 发送 RDP 输入事件。 */
export function sendRdpInput(
  sessionId: string,
  input: RdpInputEvent,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<void>("rdp_session_send_input", {
    sessionId,
    input,
    operationId: options?.operationId,
  });
}

/** 更新 RDP 分辨率。 */
export function resizeRdpSession(
  sessionId: string,
  width: number,
  height: number,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<RdpSessionSnapshot>("rdp_session_resize", {
    sessionId,
    width,
    height,
    operationId: resolveOperationId(options),
  });
}

/** 设置 RDP 剪贴板内容。 */
export function setRdpClipboard(
  sessionId: string,
  text: string,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<void>("rdp_session_set_clipboard", {
    sessionId,
    text,
    operationId: resolveOperationId(options),
  });
}

/** 设置 RDP 会话静音状态。 */
export function setRdpAudioMuted(
  sessionId: string,
  muted: boolean,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<void>("rdp_session_set_audio_muted", {
    sessionId,
    muted,
    operationId: resolveOperationId(options),
  });
}

/** 响应 RDP 证书确认。 */
export function decideRdpCertificate(
  sessionId: string,
  accept: boolean,
  options?: RdpCommandOptions,
) {
  return invokeTauriCommand<RdpSessionSnapshot>("rdp_session_cert_decide", {
    sessionId,
    accept,
    operationId: resolveOperationId(options),
  });
}
