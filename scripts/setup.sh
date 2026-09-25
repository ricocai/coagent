#!/usr/bin/env bash
# setup.sh — 按设计 §3.2 初始化本机运行目录（幂等，可重复执行）
set -euo pipefail

C="$HOME/c-doing/c-agent"
mkdir -p "$C/runtime" "$C/state/dsh"

W="$(cd "$(dirname "$0")/.." && pwd)"   # workspace = 仓库根
mkdir -p "$W/context" "$W/outputs" "$W/feedback" "$W/evals/private" "$W/runs"

# workspace 必须是独立 Git 根（dsh 技能发现依赖）
if [ ! -d "$W/.git" ]; then
  git -C "$W" init -b main
fi
git -C "$W" rev-parse --show-toplevel

echo "目录初始化完成。runtime=$C/runtime state=$C/state/dsh workspace=$W"
