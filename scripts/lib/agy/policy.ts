// agy 权限策略引擎（Layer 1 硬规则 + Layer 2 防绕过白名单 + 原生 Auto 模式尊重 + 用户规则合并）。

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { type AcpPermissionRequest } from "./acp";

export type NormalizedPermission = {
  kind: "command" | "fileChange" | "read" | "other";
  title: string;
  command?: string;
  locations: string[];
  rawInput: Record<string, unknown>;
  signature: string;
};

export type PolicyAction = "allow" | "deny" | "ask_user" | "review";

export type PolicyDecision = {
  action: PolicyAction;
  stage: "hard_deny" | "hard_ask" | "user_policy" | "session_allow" | "allowlist" | "native_escalation" | "fallback_review";
  reason: string;
};

export type UserPolicyConfig = {
  denyCommands?: string[];
  askCommands?: string[];
  allowCommands?: string[];
};

export type EvaluateContext = {
  cwd: string;
  network: boolean;
  nativeAutoActive: boolean;
  policyMode?: "auto" | "bridge" | "strict";
  sessionAllows?: Set<string>;
  userConfig?: UserPolicyConfig;
};

const USER_POLICY_PATH = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude-codex-bridge", "agy-policy.json");

export function loadUserPolicy(): UserPolicyConfig {
  try {
    const raw = JSON.parse(readFileSync(USER_POLICY_PATH(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

// 从 ACP session/request_permission 规范提取工具类别、命令文本和目标路径。
export function normalizePermission(req: AcpPermissionRequest): NormalizedPermission {
  const tc = req.toolCall ?? {};
  const rawInput = (tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput : {}) as Record<string, unknown>;
  const rawKind = String(tc.kind ?? "").toLowerCase();
  const title = String(tc.title ?? rawKind ?? "tool");

  const commandCandidate =
    typeof rawInput.command === "string"
      ? rawInput.command
      : typeof rawInput.CommandLine === "string"
        ? rawInput.CommandLine
        : typeof rawInput.cmd === "string"
          ? rawInput.cmd
          : undefined;

  const locSet = new Set<string>();
  if (Array.isArray(tc.locations)) {
    for (const l of tc.locations) {
      if (typeof l?.path === "string" && l.path) locSet.add(l.path);
    }
  }
  for (const key of ["path", "filepath", "file_path", "filePath", "target", "TargetFile", "directory", "cwd"]) {
    const v = rawInput[key];
    if (typeof v === "string" && v) locSet.add(v);
  }
  const locations = [...locSet];

  let kind: NormalizedPermission["kind"] = "other";
  if (rawKind === "execute" || rawKind === "shell" || commandCandidate !== undefined) {
    kind = "command";
  } else if (rawKind === "edit" || rawKind === "write" || rawKind === "delete" || rawKind === "move") {
    kind = "fileChange";
  } else if (rawKind === "read" || rawKind === "search") {
    kind = "read";
  }

  const signature =
    kind === "command" && commandCandidate
      ? `cmd:${commandHead(commandCandidate)}`
      : `${kind}:${title}`;

  return { kind, title, command: commandCandidate?.trim(), locations, rawInput, signature };
}

function commandHead(cmd: string): string {
  const parts = cmd.trim().split(/\s+/);
  if (parts.length >= 2 && ["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "npx", "make"].includes(parts[0])) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0] ?? "";
}

// 仅在未加引号状态下检测 shell 复合/拼接/重定向元字符，防止前缀白名单被绕过。
export function hasShellControlOps(cmd: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && cmd[i + 1] === "(")) return true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`" || ch === "\n" || ch === "\r" || ch === ">" || ch === "<") {
      return true;
    }
    if (ch === "$" && cmd[i + 1] === "(") return true;
  }
  return quote !== null; // 未闭合引号视为不安全
}

const CATASTROPHIC_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$))/i, reason: "禁止删除根目录或家目录" },
  { re: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$))/i, reason: "禁止删除根目录或家目录" },
  { re: /\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|diskutil\s+erase)/i, reason: "禁止磁盘格式化命令" },
  { re: /\bdd\b[^;\n]*\bof=\/dev\//i, reason: "禁止直接写块设备" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "禁止 fork 炸弹" },
];

const SENSITIVE_PATH_PATTERNS = [
  /(?:^|[/\\~])\.(?:ssh|aws|gnupg|netrc|npmrc|pypirc|docker|kube)(?:[/\\]|$)/i,
  /(?:^|[/\\~])\.config[/\\](?:gh|gcloud|op)(?:[/\\]|$)/i,
  /(?:^|[/\\~])\.(?:codex|gemini|antigravity)(?:[/\\]|$)/i,
  /(?:^|[/\\])(?:\.env(?:\.[^/\s]*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials\.json)$/i,
  /(?:^|[/\\])[^/\s]+\.(?:pem|key|p12|keystore)$/i,
  /^\/etc\/(?:passwd|shadow|sudoers)/i,
  /Library\/Keychains/i,
];

const FORCE_ASK_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsudo\b|\bsu\s+-|\bdoas\b/, reason: "涉及提权命令" },
  { re: /\bgit\s+push\b/, reason: "涉及 git push 远端变更" },
  { re: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "涉及不可逆 Git 清理/重置" },
  { re: /\b(?:npm|pnpm|yarn|cargo|gem|twine)\s+publish\b|\bgh\s+(?:pr\s+merge|release\s+create)\b/, reason: "涉及对外发布或合并操作" },
  { re: /\bchmod\s+-R\b|\bchown\b/, reason: "涉及批量权限/属主变更" },
  { re: /\beval\b|\|\s*(?:ba|z|da|k)?sh\b|base64\s+(?:-d|--decode)[^;\n]*\|/i, reason: "涉及动态求值或管道脚本执行" },
  { re: /\b(?:curl|wget)\b[^;\n]*(?:\s(?:-d|--data|--data-raw|--data-binary|-F|--form|-T|--upload-file)\b|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b)/i, reason: "涉及对外发送数据请求" },
  { re: /\b(?:nc|ncat|netcat|socat)\b|\b(?:scp|sftp)\b|\brsync\b[^;\n]*:/i, reason: "涉及远端网络传输" },
];

// 默认静态白名单（仅匹配无 shell 拼接元字符的单条简单命令）
const SAFE_COMMAND_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "ls",
  "pwd",
  "which",
  "rg",
  "grep",
  "find",
  "wc",
  "head",
  "tail",
  "cat",
  "stat",
  "file",
  "tree",
  "bun test",
  "bun --version",
  "npm test",
  "pnpm test",
  "yarn test",
  "npx tsc",
  "pytest",
  "go test",
  "cargo test",
  "cargo check",
  "swift test",
  "make test",
];

function isSensitivePath(p: string): boolean {
  const expanded = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  const norm = normalize(expanded);
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(p) || re.test(norm));
}

export function isInsideAllowedRoots(targetPath: string, cwd: string): boolean {
  const expanded = targetPath.startsWith("~/") ? join(homedir(), targetPath.slice(2)) : targetPath;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const roots = [resolve(cwd), resolve("/tmp"), resolve("/private/tmp"), resolve(tmpdir())];
  return roots.some(root => {
    const rel = relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function matchesPrefixList(cmd: string, prefixes: string[]): string | undefined {
  const trimmed = cmd.trim();
  for (const p of prefixes) {
    const rule = p.trim();
    if (!rule) continue;
    if (trimmed === rule || trimmed.startsWith(rule + " ")) return rule;
  }
  return undefined;
}

function commandMentionsSensitivePath(cmd: string): boolean {
  const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const raw of tokens) {
    const t = raw.replace(/^["']|["']$/g, "");
    if (isSensitivePath(t)) return true;
  }
  return false;
}

// 评估一条 ACP 权限请求；返回 allow / deny / ask_user / review（review 表示交由 Layer 3 自审核）。
export function evaluatePermission(req: AcpPermissionRequest, ctx: EvaluateContext): PolicyDecision {
  const norm = normalizePermission(req);
  const userCfg = ctx.userConfig ?? {};
  const mode = ctx.policyMode ?? (process.env.BRIDGE_AGY_POLICY_MODE as EvaluateContext["policyMode"]) ?? "auto";

  // Layer 1A: 无论何种模式，毁灭性命令直接硬拒绝
  if (norm.command) {
    for (const { re, reason } of CATASTROPHIC_PATTERNS) {
      if (re.test(norm.command)) return { action: "deny", stage: "hard_deny", reason };
    }
    const userDeny = matchesPrefixList(norm.command, userCfg.denyCommands ?? []);
    if (userDeny) return { action: "deny", stage: "user_policy", reason: `命中用户拒绝规则：${userDeny}` };
  }

  // Layer 1B: 敏感路径 / 越界写入 / 不可逆或高危命令强制人工确认，绝不自动放行或交自审
  if (norm.locations.some(isSensitivePath) || (norm.command && commandMentionsSensitivePath(norm.command))) {
    return { action: "ask_user", stage: "hard_ask", reason: "涉及敏感凭据或系统关键路径，需人工确认" };
  }
  if (norm.kind === "fileChange" && norm.locations.length > 0 && norm.locations.some(p => !isInsideAllowedRoots(p, ctx.cwd))) {
    return { action: "ask_user", stage: "hard_ask", reason: "文件变更越出工作目录与临时目录，需人工确认" };
  }
  if (norm.command) {
    for (const { re, reason } of FORCE_ASK_COMMAND_PATTERNS) {
      if (re.test(norm.command)) return { action: "ask_user", stage: "hard_ask", reason: `${reason}，需人工确认` };
    }
    const userAsk = matchesPrefixList(norm.command, userCfg.askCommands ?? []);
    if (userAsk) return { action: "ask_user", stage: "user_policy", reason: `命中用户必问规则：${userAsk}` };
  }

  // strict 模式：除硬拒绝外一律转人工
  if (mode === "strict") {
    return { action: "ask_user", stage: "hard_ask", reason: "已启用 strict 策略，需人工确认" };
  }

  // 会话级已批准（用户曾执行 approve --session）
  if (ctx.sessionAllows?.has(norm.signature)) {
    return { action: "allow", stage: "session_allow", reason: `本会话已批准同类操作 (${norm.signature})` };
  }

  // 若 agy 原生 Auto 模式已生效且未强制切到 bridge 托管模式：
  // 凡仍落到这里的请求都是 agy 自己审查后主动升级的，尊重 agy 原生边界，直接转人工确认。
  if (mode === "auto" && ctx.nativeAutoActive) {
    return { action: "ask_user", stage: "native_escalation", reason: "agy 原生 Auto 模式升级请求人工确认" };
  }

  // Layer 2: 确定性白名单（当 agy 未激活原生 Auto，或用户显式设置 BRIDGE_AGY_POLICY_MODE=bridge 时启用）
  if (norm.kind === "fileChange" || norm.kind === "read") {
    if (norm.locations.length > 0 && norm.locations.every(p => isInsideAllowedRoots(p, ctx.cwd))) {
      return { action: "allow", stage: "allowlist", reason: `工作区/临时目录内常规 ${norm.kind} 操作` };
    }
  }

  if (norm.kind === "command" && norm.command) {
    if (!hasShellControlOps(norm.command)) {
      const hitUser = matchesPrefixList(norm.command, userCfg.allowCommands ?? []);
      if (hitUser) return { action: "allow", stage: "user_policy", reason: `命中用户白名单：${hitUser}` };
      const hitSafe = matchesPrefixList(norm.command, SAFE_COMMAND_PREFIXES);
      if (hitSafe) return { action: "allow", stage: "allowlist", reason: `命中内置安全白名单：${hitSafe}` };
    }
  }

  // 其余灰区请求交给 Layer 3 隔离自审核
  return { action: "review", stage: "fallback_review", reason: "未命中确定性规则，交由自审核评估" };
}
