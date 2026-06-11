/**
 * 工作区面板懒加载入口。
 * 职责：将低频或可延后加载的面板组件拆成独立异步 chunk。
 */
import { lazy } from "react";

export const HostWidget = lazy(
  () => import("@/widgets/profiles/components/HostWidget"),
);
export const RdpWidget = lazy(
  () => import("@/widgets/rdp/components/RdpWidget"),
);
export const TransfersWidget = lazy(
  () => import("@/widgets/transfers/components/TransfersWidget"),
);
export const SftpWidget = lazy(
  () => import("@/widgets/files/components/SftpWidget"),
);
export const EventsWidget = lazy(
  () => import("@/widgets/events/components/EventsWidget"),
);
export const CommandHistoryWidget = lazy(
  () => import("@/widgets/history/components/CommandHistoryWidget"),
);
export const AiWidget = lazy(() => import("@/widgets/ai/components/AiWidget"));
export const TunnelWidget = lazy(
  () => import("@/widgets/tunnels/components/TunnelWidget"),
);
