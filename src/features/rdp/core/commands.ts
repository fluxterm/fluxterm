import { callTauri } from "@/shared/tauri/commands";
import {
  createTraceId,
  logTelemetry,
  type TelemetryLevel,
} from "@/shared/logging/telemetry";
import type { RdpInputEvent, RdpProfile, RdpSessionSnapshot } from "@/types";

type RdpCommandOptions = {
  traceId?: string;
};

function resolveTraceId(options?: RdpCommandOptions) {
  return options?.traceId ?? createTraceId();
}

function getErrorFields(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return {
    message: String(error),
  };
}

async function logRdpCommandResult(
  level: TelemetryLevel,
  event: string,
  traceId: string,
  fields?: Record<string, unknown>,
) {
  await logTelemetry(level, event, {
    traceId,
    ...(fields ?? {}),
  });
}

/** 读取 RDP Profile 列表。 */
export async function listRdpProfiles(options?: RdpCommandOptions) {
  const traceId = resolveTraceId(options);
  try {
    const profiles = await callTauri<RdpProfile[]>("rdp_profile_list", {
      traceId,
    });
    await logRdpCommandResult("debug", "rdp.profile.list.success", traceId, {
      count: profiles.length,
    });
    return profiles;
  } catch (error) {
    await logRdpCommandResult("warn", "rdp.profile.list.failed", traceId, {
      error: getErrorFields(error),
    });
    throw error;
  }
}

/** 读取 RDP 分组列表。 */
export async function listRdpProfileGroups(options?: RdpCommandOptions) {
  const traceId = resolveTraceId(options);
  try {
    const groups = await callTauri<string[]>("rdp_profile_groups_list", {
      traceId,
    });
    await logRdpCommandResult(
      "debug",
      "rdp.profile.group.list.success",
      traceId,
      {
        count: groups.length,
      },
    );
    return groups;
  } catch (error) {
    await logRdpCommandResult(
      "warn",
      "rdp.profile.group.list.failed",
      traceId,
      {
        error: getErrorFields(error),
      },
    );
    throw error;
  }
}

/** 保存 RDP 分组列表。 */
export async function saveRdpProfileGroups(
  groups: string[],
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  try {
    const next = await callTauri<string[]>("rdp_profile_groups_save", {
      groups,
      traceId,
    });
    await logRdpCommandResult(
      "debug",
      "rdp.profile.group.save.success",
      traceId,
      {
        count: next.length,
      },
    );
    return next;
  } catch (error) {
    await logRdpCommandResult(
      "warn",
      "rdp.profile.group.save.failed",
      traceId,
      {
        requestedCount: groups.length,
        error: getErrorFields(error),
      },
    );
    throw error;
  }
}

/** 保存 RDP Profile。 */
export async function saveRdpProfile(
  profile: RdpProfile,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  try {
    const next = await callTauri<RdpProfile>("rdp_profile_save", {
      profile,
      traceId,
    });
    await logRdpCommandResult("debug", "rdp.profile.save.success", traceId, {
      profileId: next.id,
      resolutionMode: next.resolutionMode,
      displayStrategy: next.displayStrategy,
      ignoreCertificate: next.ignoreCertificate,
      tagCount: next.tags?.length ?? 0,
      hasPassword: Boolean(next.passwordRef),
    });
    return next;
  } catch (error) {
    await logRdpCommandResult("warn", "rdp.profile.save.failed", traceId, {
      profileId: profile.id || null,
      resolutionMode: profile.resolutionMode,
      displayStrategy: profile.displayStrategy,
      ignoreCertificate: profile.ignoreCertificate,
      tagCount: profile.tags?.length ?? 0,
      hasPassword: Boolean(profile.passwordRef),
      error: getErrorFields(error),
    });
    throw error;
  }
}

/** 删除 RDP Profile。 */
export async function deleteRdpProfile(
  profileId: string,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  try {
    const removed = await callTauri<boolean>("rdp_profile_delete", {
      profileId,
      traceId,
    });
    await logRdpCommandResult(
      "debug",
      removed ? "rdp.profile.delete.success" : "rdp.profile.delete.failed",
      traceId,
      {
        profileId,
        removed,
      },
    );
    return removed;
  } catch (error) {
    await logRdpCommandResult("warn", "rdp.profile.delete.failed", traceId, {
      profileId,
      error: getErrorFields(error),
    });
    throw error;
  }
}

/** 创建 RDP 会话。 */
export async function createRdpSession(
  profileId: string,
  initialSize?: { width: number; height: number },
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  await logRdpCommandResult("debug", "rdp.session.create.start", traceId, {
    profileId,
    width: initialSize?.width ?? null,
    height: initialSize?.height ?? null,
  });
  try {
    const session = await callTauri<RdpSessionSnapshot>("rdp_session_create", {
      profileId,
      width: initialSize?.width,
      height: initialSize?.height,
      traceId,
    });
    await logRdpCommandResult("debug", "rdp.session.create.success", traceId, {
      sessionId: session.sessionId,
      profileId: session.profileId,
      width: session.width,
      height: session.height,
      state: session.state,
    });
    return session;
  } catch (error) {
    await logRdpCommandResult("warn", "rdp.session.create.failed", traceId, {
      profileId,
      width: initialSize?.width ?? null,
      height: initialSize?.height ?? null,
      error: getErrorFields(error),
    });
    throw error;
  }
}

/** 建立 RDP 会话桥接。 */
export async function connectRdpSession(
  sessionId: string,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  await logRdpCommandResult("debug", "rdp.session.connect.start", traceId, {
    sessionId,
  });
  try {
    const session = await callTauri<RdpSessionSnapshot>("rdp_session_connect", {
      sessionId,
      traceId,
    });
    await logRdpCommandResult("debug", "rdp.session.connect.success", traceId, {
      sessionId: session.sessionId,
      state: session.state,
      width: session.width,
      height: session.height,
      hasWsUrl: Boolean(session.wsUrl),
    });
    return session;
  } catch (error) {
    await logRdpCommandResult("warn", "rdp.session.connect.failed", traceId, {
      sessionId,
      error: getErrorFields(error),
    });
    throw error;
  }
}

/** 断开 RDP 会话。 */
export async function disconnectRdpSession(
  sessionId: string,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  await logRdpCommandResult("debug", "rdp.session.disconnect.start", traceId, {
    sessionId,
  });
  try {
    const session = await callTauri<RdpSessionSnapshot>(
      "rdp_session_disconnect",
      {
        sessionId,
        traceId,
      },
    );
    await logRdpCommandResult(
      "debug",
      "rdp.session.disconnect.success",
      traceId,
      {
        sessionId: session.sessionId,
        state: session.state,
      },
    );
    return session;
  } catch (error) {
    await logRdpCommandResult(
      "warn",
      "rdp.session.disconnect.failed",
      traceId,
      {
        sessionId,
        error: getErrorFields(error),
      },
    );
    throw error;
  }
}

/** 发送 RDP 输入事件。 */
export function sendRdpInput(
  sessionId: string,
  input: RdpInputEvent,
  options?: RdpCommandOptions,
) {
  return callTauri<void>("rdp_session_send_input", {
    sessionId,
    input,
    traceId: options?.traceId,
  });
}

/** 更新 RDP 分辨率。 */
export async function resizeRdpSession(
  sessionId: string,
  width: number,
  height: number,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  await logRdpCommandResult("debug", "rdp.session.resize.start", traceId, {
    sessionId,
    width,
    height,
  });
  try {
    const session = await callTauri<RdpSessionSnapshot>("rdp_session_resize", {
      sessionId,
      width,
      height,
      traceId,
    });
    await logRdpCommandResult("debug", "rdp.session.resize.success", traceId, {
      sessionId: session.sessionId,
      width: session.width,
      height: session.height,
      state: session.state,
    });
    return session;
  } catch (error) {
    await logRdpCommandResult("warn", "rdp.session.resize.failed", traceId, {
      sessionId,
      width,
      height,
      error: getErrorFields(error),
    });
    throw error;
  }
}

/** 设置 RDP 剪贴板内容。 */
export function setRdpClipboard(
  sessionId: string,
  text: string,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  return callTauri<void>("rdp_session_set_clipboard", {
    sessionId,
    text,
    traceId,
  });
}

/** 设置 RDP 会话静音状态。 */
export function setRdpAudioMuted(
  sessionId: string,
  muted: boolean,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  return callTauri<void>("rdp_session_set_audio_muted", {
    sessionId,
    muted,
    traceId,
  });
}

/** 响应 RDP 证书确认。 */
export async function decideRdpCertificate(
  sessionId: string,
  accept: boolean,
  options?: RdpCommandOptions,
) {
  const traceId = resolveTraceId(options);
  await logRdpCommandResult("debug", "rdp.session.certificate.start", traceId, {
    sessionId,
    accept,
  });
  try {
    const session = await callTauri<RdpSessionSnapshot>(
      "rdp_session_cert_decide",
      {
        sessionId,
        accept,
        traceId,
      },
    );
    await logRdpCommandResult(
      "debug",
      "rdp.session.certificate.success",
      traceId,
      {
        sessionId: session.sessionId,
        accept,
        state: session.state,
      },
    );
    return session;
  } catch (error) {
    await logRdpCommandResult(
      "warn",
      "rdp.session.certificate.failed",
      traceId,
      {
        sessionId,
        accept,
        error: getErrorFields(error),
      },
    );
    throw error;
  }
}
