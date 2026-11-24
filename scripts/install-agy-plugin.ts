#!/usr/bin/env bun
// 将本仓库的 Codex / agy 派活能力打包安装为 Antigravity 全局插件（~/.gemini/config/plugins/codex-bridge/）。
// 包含：
//   - plugin.json
//   - hooks.json（PreToolUse 拦截 run_command 中的 bridge.ts approve，使用 force_ask 强制用户弹窗确认）
//   - skills/delegate-codex/SKILL.md + COLLABORATION.md（面向 Antigravity 的 --once / wait / cancel / stop 工作流）

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(import.meta.dir));
const BRIDGE_SCRIPT = join(REPO_ROOT, "scripts", "bridge.ts");
const GUARD_SCRIPT = join(REPO_ROOT, "scripts", "approve-guard.ts");
const COLLAB_SRC = join(REPO_ROOT, "skills", "delegate", "COLLABORATION.md");

export function installAgyPlugin(targetDir = join(homedir(), ".gemini", "config", "plugins", "codex-bridge")) {
  const skillDir = join(targetDir, "skills", "delegate-codex");
  mkdirSync(skillDir, { recursive: true, mode: 0o755 });

  const pluginJson = {
    name: "codex-bridge",
    displayName: "Codex Bridge",
    version: "0.5.0",
    description: "让 Antigravity 通过本机 claude-codex-bridge 向 Codex 派单、多轮往返沟通、审批确认与验收。",
    suggestedPrompts: [
      "把当前方案派给 Codex 实现，并在完成后验收 diff 和测试",
      "检查 Codex bridge 依赖与正在运行的派活线程",
      "给正在运行的 Codex 线程追加修改意见并等待本轮汇报",
    ],
  };

  const bunPath = process.execPath;
  const hooksJson = {
    "codex-bridge-approve-guard": {
      PreToolUse: [
        {
          matcher: "run_command",
          hooks: [
            {
              type: "command",
              command: `"${bunPath}" "${GUARD_SCRIPT}"`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };

  const skillMd = `---
name: delegate-codex
description: 把已定方案派给本机 Codex 执行并在同一线程里多轮往返沟通与验收。当用户说"让 Codex 去做""交给 Codex""派给 Codex 实现"或需要查看/继续/取消 Codex 派活线程时使用。
---

# 派活给 Codex（Antigravity 模式）

你出方案、拆规格并验收；Codex 在本机 daemon 的沙箱里独立实现、实测并交回证据。

桥接脚本：\`bun "${BRIDGE_SCRIPT}"\`（下文简记为 \`bridge\`）。

> 连接本机 Codex Unix socket 需要绕过终端沙箱（按常规先尝试，被沙箱拦截时对单条 \`bridge\` 命令使用 unsandboxed 执行）。

## 流程

1. **先读同目录的 [COLLABORATION.md](COLLABORATION.md)**，按其中的规格格式派单、收取证据并亲自验收 diff 与测试。派活前先让用户确认方案与范围。
2. **开线程并零轮询等待本轮结果**：
   - 把较长或含特殊字符的方案写入临时文件，使用后台命令运行：
     \`bun "${BRIDGE_SCRIPT}" start <项目目录> --file <方案文件> --agent codex --name <短名> --once\`
   - \`--once\` 会自动拉起脱离终端的后台监听进程持有 WebSocket（**审批不断链**），前台在收到下一条需处理事件（\`turn_completed\` / \`approval_requested\` / \`codex_lost\`）时立刻退出，自动唤醒你，**不要轮询、不要 sleep**。
   - **旁观命令**：收到 \`started\` 事件里的 \`observe\` 字段后，**原样转告用户**（不要改写命令，提醒只看不发消息）。
   - 需要指定模型或思考深度时加 \`--model <模型>\` / \`--effort <深度>\`（可选值用 \`bridge models --agent codex\` 查）；不需要联网时加 \`--no-network\`。
3. **处理返回事件**：
   - \`turn_completed\`：读 \`text\`；是汇报就**自己核对 diff、测试输出或证据**再向用户转述；是提问就回复。
   - \`approval_requested\`：**绝对不要替用户批准**！把 \`command\` / \`grantRoot\`、\`cwd\`、\`reason\` 和 \`timeoutSec\` 原样告诉用户，等用户明确同意后执行：
     - 同意：\`bun "${BRIDGE_SCRIPT}" approve <线程> <requestId>\`（会触发插件 \`PreToolUse\` 的 \`force_ask\` 强制二次确认，不要绕过）
     - 拒绝：\`bun "${BRIDGE_SCRIPT}" deny <线程> <requestId>\`
     - 回应后立即运行 \`bun "${BRIDGE_SCRIPT}" wait <线程>\` 继续等待本轮结束（后台监听一直存活，不会丢进度）。
   - \`codex_lost\` / \`closed\` / \`error\`：告诉用户并用 \`bridge history <线程>\` 查看已有进展，必要时 \`send --wait\` 重发。
4. **同一线程追问或返工**：
   - \`bun "${BRIDGE_SCRIPT}" send <线程> "<文本>" --wait\`（长文本用 \`--file <文件>\`），自动复用后台监听并在收到下一条事件时退出唤醒你。
5. **中途查看进度或取消**：
   - \`bun "${BRIDGE_SCRIPT}" status <线程>\`：只读查询存活状态、\`pendingApprovals\` 与进度，不拉起 daemon。
   - \`bun "${BRIDGE_SCRIPT}" cancel <线程>\`：中断当前正在运行的轮次。
6. **任务完成后收尾**：
   - 执行 \`bun "${BRIDGE_SCRIPT}" stop <线程>\` 关闭后台监听进程（线程历史仍保留，随时可 \`history\` 或再次 \`send --wait\`）。
`;

  writeFileSync(join(targetDir, "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n", { mode: 0o644 });
  writeFileSync(join(targetDir, "hooks.json"), JSON.stringify(hooksJson, null, 2) + "\n", { mode: 0o644 });
  writeFileSync(join(skillDir, "SKILL.md"), skillMd, { mode: 0o644 });
  copyFileSync(COLLAB_SRC, join(skillDir, "COLLABORATION.md"));

  return { targetDir, bridgeScript: BRIDGE_SCRIPT, guardScript: GUARD_SCRIPT };
}

if (import.meta.main) {
  const res = installAgyPlugin();
  console.log(JSON.stringify({ installed: true, ...res }));
}
