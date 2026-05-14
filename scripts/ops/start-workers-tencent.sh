#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  set -a && source .env.local && set +a
fi

export APP_ENV="${APP_ENV:-production}"
export DEPLOY_TARGET="${DEPLOY_TARGET:-tencent}"

echo "[tencent] root=$ROOT_DIR"
echo "[tencent] deploy_target=$DEPLOY_TARGET"

tmux has-session -t preprocess-tencent 2>/dev/null && tmux kill-session -t preprocess-tencent || true
tmux new-session -d -s preprocess-tencent "cd '$ROOT_DIR' && npm run worker:openai-video-preprocess"

if [[ "${START_WECHAT_MEDIA_WORKER:-0}" == "1" ]]; then
  tmux has-session -t wechat-media-tencent 2>/dev/null && tmux kill-session -t wechat-media-tencent || true
  tmux new-session -d -s wechat-media-tencent "cd '$ROOT_DIR' && npm run worker:wechat-media"
fi

echo "[tencent] started sessions:"
tmux ls | grep -E "preprocess-tencent|wechat-media-tencent" || true
