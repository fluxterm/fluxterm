import type { SubAppId } from "@/subapps/types";
import type { Locale } from "@/i18n";
import type { ThemeId } from "@/types";
import type {
  BackgroundMediaType,
  BackgroundRenderMode,
  BackgroundVideoReplayMode,
} from "@/constants/backgroundMedia";

/** 主窗口与子应用窗口共享的生命周期通道名。 */
export const SUBAPP_LIFECYCLE_CHANNEL = "fluxterm-subapp-lifecycle";

/** 子应用窗口 label 前缀。 */
export const SUBAPP_WINDOW_LABEL_PREFIX = "subapp-";

/** 生成子应用窗口 label。 */
export function createSubAppWindowLabel(id: SubAppId) {
  return `${SUBAPP_WINDOW_LABEL_PREFIX}${id}`;
}

/** 从 hash 中提取子应用 ID。 */
export function parseSubAppIdFromHash(hash: string): SubAppId | null {
  const match = hash.match(/subapp=([a-z-]+)/i);
  if (!match) return null;
  const raw = match[1]?.toLowerCase();
  if (raw === "proxy") return "proxy";
  return null;
}

/** 子应用生命周期消息。 */
export type SubAppLifecycleMessage =
  | {
      type: "subapp:launch";
      id: SubAppId;
      label: string;
      source: "main";
      context?: Record<string, unknown>;
    }
  | {
      type: "subapp:ready";
      id: SubAppId;
      label: string;
      source: "subapp";
    }
  | {
      type: "subapp:focused";
      id: SubAppId;
      label: string;
      source: "main";
    }
  | {
      type: "subapp:close-request";
      id: SubAppId;
      label: string;
      source: "main" | "subapp";
      reason?: "menu" | "window-close" | "main-shutdown";
    }
  | {
      type: "subapp:closed";
      id: SubAppId;
      label: string;
      source: "subapp";
    }
  | {
      type: "subapp:main-shutdown";
      source: "main";
    }
  | {
      type: "subapp:devtools-open";
      source: "main";
      target?: {
        id: SubAppId;
        label: string;
      };
    }
  | {
      type: "subapp:appearance-sync";
      source: "main";
      target?: {
        id: SubAppId;
        label: string;
      };
      locale: Locale;
      themeId: ThemeId;
      backgroundImageEnabled: boolean;
      backgroundImageAsset: string;
      backgroundImageSurfaceAlpha: number;
      backgroundMediaType: BackgroundMediaType;
      backgroundRenderMode: BackgroundRenderMode;
      backgroundVideoReplayMode: BackgroundVideoReplayMode;
      backgroundVideoReplayIntervalSec: number;
    };
