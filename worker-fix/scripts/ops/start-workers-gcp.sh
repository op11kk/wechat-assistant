#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  set -a && source .env.local && set +a
fi

export APP_ENV="${APP_ENV:-production}"
export DEPLOY_TARGET="${DEPLOY_TARGET:-gcp}"

echo "[gcp] root=$ROOT_DIR"
echo "[gcp] deploy_target=$DEPLOY_TARGET"

tmux has-session -t submit-gcp 2>/dev/null && tmux kill-session -t submit-gcp || true
tmux new-session -d -s submit-gcp "cd '$ROOT_DIR' && npm run worker:openai-video-batch-submit-loop"

tmux has-session -t poll-gcp 2>/dev/null && tmux kill-session -t poll-gcp || true
tmux new-session -d -s poll-gcp "cd '$ROOT_DIR' && npm run worker:openai-video-batch-poll"

echo "[gcp] started sessions:"
tmux ls | grep -E "submit-gcp|poll-gcp" || true
