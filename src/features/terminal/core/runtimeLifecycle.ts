/** 终端显示宿主与异步创建的生命周期约束，不管理连接和输出内容。 */
export type TerminalSurface = {
  container: HTMLDivElement | null;
  runtime: HTMLDivElement;
  mountVersion: number;
};

/** 迁移同一个终端 DOM；布局卸载仅解除挂载，不销毁终端。 */
export function attachTerminalSurface(
  surface: TerminalSurface,
  container: HTMLDivElement | null,
) {
  if (surface.container === container) return;
  surface.mountVersion += 1;
  surface.container = container;
  if (container) container.replaceChildren(surface.runtime);
  else surface.runtime.remove();
}

/** 判断延迟布局操作是否仍属于当前可见宿主。 */
export function isTerminalSurfaceVisible(
  surface: TerminalSurface,
  version = surface.mountVersion,
) {
  const container = surface.container;
  return Boolean(
    surface.mountVersion === version &&
    container?.isConnected &&
    container.clientWidth > 0 &&
    container.clientHeight > 0,
  );
}

/** 合并每个会话的创建请求，并使关闭前发出的异步请求失效。 */
export function createTerminalCreationGate() {
  const pending = new Map<string, { promise: Promise<void> }>();
  return {
    /** 加载完成后使用最新宿主，禁止向已关闭会话或失效请求创建实例。 */
    ensure<Modules, Container>(
      sessionId: string,
      load: () => Promise<Modules>,
      getContainer: () => Container | null,
      isLive: () => boolean,
      create: (modules: Modules, container: Container) => void,
    ): Promise<void> {
      const existing = pending.get(sessionId);
      if (existing) return existing.promise;
      const request = {
        promise: Promise.resolve()
          .then(load)
          .then((modules) => {
            if (pending.get(sessionId) !== request || !isLive()) return;
            const container = getContainer();
            if (container) create(modules, container);
          })
          .finally(() => {
            if (pending.get(sessionId) === request) pending.delete(sessionId);
          }),
      };
      pending.set(sessionId, request);
      return request.promise;
    },
    /** 取消指定会话的创建资格；不影响随后重新发起的请求。 */
    cancel(sessionId: string) {
      pending.delete(sessionId);
    },
    /** 运行时退出时使全部未完成请求失效。 */
    clear() {
      pending.clear();
    },
  };
}
