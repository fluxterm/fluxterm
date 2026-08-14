/**
 * 浮动面板同步通用 Hook。
 * 职责：
 * 1. 统一管理 BroadcastChannel 的生命周期。
 * 2. 抽象主窗口快照广播与浮动窗口请求/接收快照的骨架。
 */
import { useCallback, useEffect, useRef } from "react";
import type { DependencyList } from "react";
import type { WidgetKey } from "@/types";

type UseFloatingWidgetSnapshotSyncOptions<Message> = {
  channelName: string;
  floatingWidgetKey: WidgetKey | null;
  isFloatingWidget: boolean;
  broadcastSnapshot?: (channel: BroadcastChannel) => void;
  onMainWindowMessage?: (message: Message, channel: BroadcastChannel) => void;
  onFloatingWindowMessage?: (message: Message) => void;
  requestSnapshot: (channel: BroadcastChannel) => void;
  deps: DependencyList;
};

const floatingSyncDepIds = new WeakMap<object, number>();
let nextFloatingSyncDepId = 1;

function getFloatingSyncDepToken(value: unknown) {
  if (typeof value === "object" && value !== null) {
    let id = floatingSyncDepIds.get(value);
    if (!id) {
      id = nextFloatingSyncDepId;
      nextFloatingSyncDepId += 1;
      floatingSyncDepIds.set(value, id);
    }
    return `object:${id}`;
  }
  if (typeof value === "function") {
    const fn = value as object;
    let id = floatingSyncDepIds.get(fn);
    if (!id) {
      id = nextFloatingSyncDepId;
      nextFloatingSyncDepId += 1;
      floatingSyncDepIds.set(fn, id);
    }
    return `function:${id}`;
  }
  return `${typeof value}:${String(value)}`;
}

/** 管理浮动面板动作消息通道，并返回稳定的发送函数。 */
export function useFloatingWidgetMessagePoster<Message>(
  channelName: string,
  enabled: boolean,
) {
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined" || !enabled) {
      channelRef.current?.close();
      channelRef.current = null;
      return;
    }
    const channel = new BroadcastChannel(channelName);
    channelRef.current = channel;
    return () => {
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      channel.close();
    };
  }, [channelName, enabled]);

  return useCallback((message: Message) => {
    channelRef.current?.postMessage(message);
  }, []);
}

/** 管理主窗口与浮动窗口之间的快照同步骨架。 */
export function useFloatingWidgetSnapshotSync<Message>({
  channelName,
  floatingWidgetKey,
  isFloatingWidget,
  broadcastSnapshot,
  onMainWindowMessage,
  onFloatingWindowMessage,
  requestSnapshot,
  deps,
}: UseFloatingWidgetSnapshotSyncOptions<Message>) {
  const broadcastSnapshotRef = useRef(broadcastSnapshot);
  const onMainWindowMessageRef = useRef(onMainWindowMessage);
  const onFloatingWindowMessageRef = useRef(onFloatingWindowMessage);
  const requestSnapshotRef = useRef(requestSnapshot);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const depsSignature = deps.map(getFloatingSyncDepToken).join("|");

  useEffect(() => {
    broadcastSnapshotRef.current = broadcastSnapshot;
    onMainWindowMessageRef.current = onMainWindowMessage;
    onFloatingWindowMessageRef.current = onFloatingWindowMessage;
    requestSnapshotRef.current = requestSnapshot;
  }, [
    broadcastSnapshot,
    onMainWindowMessage,
    onFloatingWindowMessage,
    requestSnapshot,
  ]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    if (floatingWidgetKey && !isFloatingWidget) return;
    const channel = new BroadcastChannel(channelName);
    channelRef.current = channel;

    if (!floatingWidgetKey) {
      channel.onmessage = (event) => {
        const message = event.data as Message | undefined;
        if (!message) return;
        onMainWindowMessageRef.current?.(message, channel);
      };
      return () => {
        if (channelRef.current === channel) {
          channelRef.current = null;
        }
        channel.close();
      };
    }

    channel.onmessage = (event) => {
      const message = event.data as Message | undefined;
      if (!message) return;
      onFloatingWindowMessageRef.current?.(message);
    };
    requestSnapshotRef.current(channel);
    return () => {
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      channel.close();
    };
  }, [channelName, floatingWidgetKey, isFloatingWidget]);

  // 主窗口的数据更新只触发快照广播，不重建消息频道，避免高频进度更新造成动作消息丢失。
  useEffect(() => {
    if (floatingWidgetKey) return;
    const channel = channelRef.current;
    if (!channel) return;
    broadcastSnapshotRef.current?.(channel);
  }, [channelName, floatingWidgetKey, depsSignature]);
}
