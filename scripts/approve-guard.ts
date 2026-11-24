#!/usr/bin/env bun
// PreToolUse hook：Claude 要执行 `bridge.ts approve` 时，强制弹出确认，让用户自己点头。
// 批准权不能只靠提示词约束：Codex / Antigravity (agy) 的汇报会进入 Claude 的上下文，可能诱导它自行批准。
// 其他命令（包括 deny，以及 send/start 正文里出现 approve 字样）不拦，直接放行。

const VALUE_FLAGS = new Set(["--agent", "--name", "--limit", "--max-quiet", "--file", "--model", "--effort"]);
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

type Token = { text: string; quoted: boolean };

// 按未转义/未引号包裹的 shell 分隔符拆分命令段，并保留每个 token 是否带引号。
function splitSegments(command: string): Token[][] {
  const segments: Token[][] = [];
  let curSeg: Token[] = [];
  let curText = "";
  let curQuoted = false;
  let hasToken = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (!hasToken) return;
    curSeg.push({ text: curText, quoted: curQuoted });
    curText = "";
    curQuoted = false;
    hasToken = false;
  };
  const pushSeg = () => {
    pushToken();
    if (curSeg.length > 0) {
      segments.push(curSeg);
      curSeg = [];
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else curText += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        curText += command[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        curText += ch;
      }
      continue;
    }
    // 非引号状态
    if (ch === "\\" && i + 1 < command.length) {
      hasToken = true;
      curText += command[++i];
    } else if (ch === "'" || ch === '"') {
      hasToken = true;
      curQuoted = true;
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (ch === "\n") pushSeg();
      else pushToken();
    } else if (ch === ";" || ch === "|" || ch === "&") {
      pushSeg();
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    } else if (ch === "(" || ch === ")") {
      pushSeg();
    } else {
      hasToken = true;
      curText += ch;
    }
  }
  pushSeg();
  return segments;
}

const isBridgeScript = (token: string) => /(?:^|[/\\])bridge\.ts$/.test(token);

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function segmentInvokesApprove(tokens: Token[], depth: number): boolean {
  if (depth > 4) return false;

  // 递归检查 sh -c "..." / eval "..." 等包装执行
  for (let i = 0; i < tokens.length; i++) {
    const bin = baseName(tokens[i].text);
    if (bin === "eval" && i + 1 < tokens.length) {
      const joined = tokens.slice(i + 1).map(t => t.text).join(" ");
      if (shouldAskApproval(joined, depth + 1)) return true;
    }
    if (SHELL_BINS.has(bin)) {
      for (let j = i + 1; j < tokens.length - 1; j++) {
        if (/^-[a-z]*c[a-z]*$/.test(tokens[j].text)) {
          if (shouldAskApproval(tokens[j + 1].text, depth + 1)) return true;
          break;
        }
      }
    }
  }

  // 查找 bridge.ts 后的首个位置参数（子命令），跳过前置 flag
  for (let i = 0; i < tokens.length; i++) {
    if (!isBridgeScript(tokens[i].text)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j].text;
      if (t === "--") {
        return tokens[j + 1]?.text === "approve";
      }
      if (t.startsWith("-")) {
        if (VALUE_FLAGS.has(t)) j++; // 跳过紧随的值参数
        continue;
      }
      // 首个位置参数即子命令；只有它是 approve 才拦截，避免误拦 send/start 正文里的 approve 字样
      if (t === "approve") return true;
      break;
    }
  }
  return false;
}

// 提取双引号或非引号区域内的 $(...) 与反引号 `...` 命令替换片段，防止通过子命令替换绕过检测。
function extractCommandSubstitutions(command: string): string[] {
  const subs: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i++;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      let innerQuote: "'" | '"' | null = null;
      for (; j < command.length && depth > 0; j++) {
        const c = command[j];
        if (innerQuote === "'") { if (c === "'") innerQuote = null; continue; }
        if (c === "\\" && j + 1 < command.length) { j++; continue; }
        if (innerQuote === '"') { if (c === '"') innerQuote = null; continue; }
        if (c === "'" || c === '"') { innerQuote = c; continue; }
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      subs.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
    } else if (ch === "`") {
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === "\\" && j + 1 < command.length) { j++; continue; }
        if (command[j] === "`") break;
      }
      subs.push(command.slice(i + 1, j));
      i = j;
    }
  }
  return subs;
}

export function shouldAskApproval(command: string, depth = 0): boolean {
  if (!command || depth > 4) return false;
  for (const sub of extractCommandSubstitutions(command)) {
    if (shouldAskApproval(sub, depth + 1)) return true;
  }
  for (const seg of splitSegments(command)) {
    if (segmentInvokesApprove(seg, depth)) return true;
  }
  return false;
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const command: string = input?.tool_input?.command ?? "";
    if (shouldAskApproval(command)) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "这会批准执行端（Codex / agy）的一个越权请求，需要你确认",
        },
      }));
    }
  } catch {
    // 读不懂输入就不干预，不影响其他命令。
  }
}
