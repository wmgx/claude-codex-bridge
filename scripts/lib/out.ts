// 输出约定：stdout 每行一个 JSON，便于 Claude Code 的 Monitor 当作事件流。

export class BridgeError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export const out = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
