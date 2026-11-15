// 运行：bun test
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态目录在模块加载时确定，所以先指到临时目录再加载。
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bridge-test-"));
const { Session } = await import("./session");
const { readLastEmitted, takeDecision, writeDecision, writeLastEmitted } = await import("./state");

const log = spyOn(console, "log").mockImplementation(() => {});
const events = () => log.mock.calls.map(([line]) => JSON.parse(line as string));
afterEach(() => log.mockClear());

const doneTurn = (id: string) => ({ id, status: "completed", items: [{ type: "agentMessage", text: `report ${id}` }] });
const fakeClient = (turns: unknown[]) =>
  ({ request: async (method: string) => (method === "thread/read" ? { thread: { turns } } : {}), respond() {}, respondError() {} }) as any;

test("watch 补发上次上报之后完成的轮次，已上报的不重放", async () => {
  writeLastEmitted("thread-a", "t1");
  const client = fakeClient([doneTurn("t1"), doneTurn("t2"), doneTurn("t3")]);
  const session = new Session("thread-a", readLastEmitted("thread-a"));
  session.attach(client);
  await session.resume(client);

  expect(events().map(e => [e.event, e.turnId, e.text])).toEqual([
    ["turn_completed", "t2", "report t2"],
    ["turn_completed", "t3", "report t3"],
  ]);
  expect(readLastEmitted("thread-a")).toBe("t3");
});

test("残留的审批决定不会落到同 ID 的新请求上", () => {
  writeDecision("thread-b", "7", "accept");
  const client = fakeClient([]);
  const session = new Session("thread-b", null);
  session.attach(client);
  client.onServerRequest({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm -rf x" } });

  expect(events().map(e => e.event)).toEqual(["approval_requested"]);
  expect(takeDecision("thread-b", "7")).toBeUndefined();
});
