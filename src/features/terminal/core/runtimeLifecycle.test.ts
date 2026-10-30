import assert from "node:assert/strict";
import test from "node:test";
import {
  attachTerminalSurface,
  createTerminalCreationGate,
  isTerminalSurfaceVisible,
  type TerminalSurface,
} from "./runtimeLifecycle.ts";

/** 最小 DOM 替身，用于验证节点迁移和旧父节点释放。 */
class ElementStub {
  isConnected = true;
  clientWidth = 800;
  clientHeight = 600;
  parent: ElementStub | null = null;
  children: ElementStub[] = [];

  /** 保持节点身份，将节点从旧宿主迁移到新宿主。 */
  replaceChildren(node: ElementStub) {
    this.children.forEach((child) => {
      child.parent = null;
    });
    node.remove();
    this.children = [node];
    node.parent = this;
  }

  /** 解除节点与父节点的关联。 */
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
      this.parent = null;
    }
  }
}

/** 将仅包含测试所需 DOM 能力的替身适配到宿主接口。 */
function element(node = new ElementStub()) {
  return node as unknown as HTMLDivElement;
}

/** 创建可控异步模块加载任务。 */
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

void test("多个会话在水平、垂直拆分与区域收缩后保留原实例和输出", () => {
  const surfaces = Array.from({ length: 3 }, (_, index) => ({
    container: null,
    runtime: element(),
    mountVersion: 0,
    terminal: { lines: [`session-${index}`], alternateScreen: index === 1 },
    outputQueue: ["before-split"],
    disposed: false,
  }));
  const terminals = surfaces.map((surface) => surface.terminal);
  const oldContainers = surfaces.map(() => new ElementStub());
  surfaces.forEach((surface, index) =>
    attachTerminalSurface(surface, element(oldContainers[index])),
  );
  for (const operation of ["horizontal", "vertical", "nested", "collapse"]) {
    surfaces.forEach((surface) => {
      attachTerminalSurface(surface, null);
      surface.outputQueue.push(operation);
      attachTerminalSurface(surface, element());
    });
  }
  surfaces.forEach((surface, index) => {
    assert.equal(surface.terminal, terminals[index]);
    assert.deepEqual(surface.terminal.lines, [`session-${index}`]);
    assert.equal(surface.terminal.alternateScreen, index === 1);
    assert.deepEqual(surface.outputQueue, [
      "before-split",
      "horizontal",
      "vertical",
      "nested",
      "collapse",
    ]);
    assert.equal(surface.disposed, false);
  });
  oldContainers.forEach((container) =>
    assert.deepEqual(container.children, []),
  );
});

void test("直接替换宿主及重复挂载保持 DOM 身份，并拒绝旧挂载代次", () => {
  const oldContainer = new ElementStub();
  const nextContainer = new ElementStub();
  const runtime = new ElementStub();
  const surface: TerminalSurface = {
    container: null,
    runtime: element(runtime),
    mountVersion: 0,
  };
  attachTerminalSurface(surface, element(oldContainer));
  const oldVersion = surface.mountVersion;
  attachTerminalSurface(surface, element(nextContainer));
  assert.deepEqual(oldContainer.children, []);
  assert.deepEqual(nextContainer.children, [runtime]);
  assert.equal(isTerminalSurfaceVisible(surface, oldVersion), false);
  const currentVersion = surface.mountVersion;
  attachTerminalSurface(surface, element(nextContainer));
  assert.equal(surface.mountVersion, currentVersion);
  attachTerminalSurface(surface, null);
  assert.deepEqual(nextContainer.children, []);
  assert.equal(isTerminalSurfaceVisible(surface), false);
});

void test("离线 DOM 和零尺寸宿主不允许布局操作，重新显示后恢复", () => {
  const container = new ElementStub();
  const surface: TerminalSurface = {
    container: element(container),
    runtime: element(),
    mountVersion: 1,
  };
  assert.equal(isTerminalSurfaceVisible(surface), true);
  container.isConnected = false;
  assert.equal(isTerminalSurfaceVisible(surface), false);
  container.isConnected = true;
  container.clientWidth = 0;
  assert.equal(isTerminalSurfaceVisible(surface), false);
  container.clientWidth = 800;
  container.clientHeight = 0;
  assert.equal(isTerminalSurfaceVisible(surface), false);
  container.clientHeight = 600;
  assert.equal(isTerminalSurfaceVisible(surface), true);
});

void test("并发创建只加载一次，并使用异步加载完成时的最新宿主", async () => {
  const gate = createTerminalCreationGate();
  const loading = deferred();
  let loadCount = 0;
  let container: string | null = "before";
  const created: string[] = [];
  const ensure = () =>
    gate.ensure(
      "ssh",
      () => {
        loadCount++;
        return loading.promise;
      },
      () => container,
      () => true,
      (modules, host) => created.push(`${modules}:${host}`),
    );
  const first = ensure();
  const second = ensure();
  assert.equal(first, second);
  await Promise.resolve();
  container = "after-split";
  loading.resolve("xterm");
  await first;
  assert.equal(loadCount, 1);
  assert.deepEqual(created, ["xterm:after-split"]);
});

void test("加载期间卸载宿主或关闭会话，不创建过期实例", async () => {
  for (const reason of ["detach", "close", "shutdown"]) {
    const gate = createTerminalCreationGate();
    const loading = deferred();
    let container: string | null = "host";
    let live = true;
    let created = 0;
    const request = gate.ensure(
      "ssh",
      () => loading.promise,
      () => container,
      () => live,
      () => {
        created++;
      },
    );
    if (reason === "detach") container = null;
    if (reason === "close") {
      live = false;
      gate.cancel("ssh");
    }
    if (reason === "shutdown") {
      live = false;
      gate.clear();
    }
    loading.resolve("xterm");
    await request;
    assert.equal(created, 0, reason);
  }
});

void test("关闭后的同名新请求不会被旧任务完成或清理操作覆盖", async () => {
  const gate = createTerminalCreationGate();
  const oldLoading = deferred();
  const newLoading = deferred();
  const created: string[] = [];
  const ensure = (loading: ReturnType<typeof deferred>) =>
    gate.ensure(
      "ssh",
      () => loading.promise,
      () => "host",
      () => true,
      (modules) => created.push(modules),
    );
  const oldRequest = ensure(oldLoading);
  gate.cancel("ssh");
  const newRequest = ensure(newLoading);
  oldLoading.resolve("old");
  await oldRequest;
  assert.equal(ensure(newLoading), newRequest);
  newLoading.resolve("new");
  await newRequest;
  assert.deepEqual(created, ["new"]);
});

void test("模块加载失败后允许重试，不残留创建锁", async () => {
  const gate = createTerminalCreationGate();
  const loading = deferred();
  const failed = gate.ensure(
    "ssh",
    () => loading.promise,
    () => "host",
    () => true,
    () => {},
  );
  loading.reject(new Error("load failed"));
  await assert.rejects(failed, /load failed/);
  let created = 0;
  await gate.ensure(
    "ssh",
    () => Promise.resolve("xterm"),
    () => "host",
    () => true,
    () => {
      created++;
    },
  );
  assert.equal(created, 1);
});
