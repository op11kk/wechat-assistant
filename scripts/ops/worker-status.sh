#!/usr/bin/env bash
set -euo pipefail

echo "== tmux sessions =="
tmux ls || true

echo
echo "== worker processes =="
ps -ef | grep -E "wechat-media-worker|preprocess-new|openai-video-batch-submit|openai-video-batch-poll|openai-video-preprocess" | grep -v grep || true
