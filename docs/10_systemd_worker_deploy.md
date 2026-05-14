# systemd Worker Deployment

Use `systemd` for the long-running workers instead of `tmux`.

## Why

- survives SSH disconnects
- restarts automatically after crashes
- starts on reboot
- logs are centralized in `journalctl`
- much easier to inspect than ad hoc sessions

## Service templates

Templates live in `scripts/ops/systemd/`:

- `preprocess-tencent.service`
- `wechat-media-tencent.service`
- `submit-gcp.service`
- `poll-gcp.service`

Before installing, replace these placeholders:

- `__USER__`
- `__WORKDIR__`

Typical values:

- Tencent Cloud user: `ubuntu`
- GCP user: `nkyy0923`
- Tencent Cloud workdir: `/home/ubuntu/wechat-assistant`
- GCP workdir: `/home/nkyy0923/wechat-assistant`

## Tencent Cloud install

```bash
cd ~/wechat-assistant
mkdir -p /tmp/wechat-systemd
cp scripts/ops/systemd/preprocess-tencent.service /tmp/wechat-systemd/
cp scripts/ops/systemd/wechat-media-tencent.service /tmp/wechat-systemd/
sed -i "s#__USER__#ubuntu#g" /tmp/wechat-systemd/preprocess-tencent.service
sed -i "s#__WORKDIR__#/home/ubuntu/wechat-assistant#g" /tmp/wechat-systemd/preprocess-tencent.service
sed -i "s#__USER__#ubuntu#g" /tmp/wechat-systemd/wechat-media-tencent.service
sed -i "s#__WORKDIR__#/home/ubuntu/wechat-assistant#g" /tmp/wechat-systemd/wechat-media-tencent.service
sudo cp /tmp/wechat-systemd/preprocess-tencent.service /etc/systemd/system/
sudo cp /tmp/wechat-systemd/wechat-media-tencent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable preprocess-tencent.service
sudo systemctl enable wechat-media-tencent.service
sudo systemctl restart preprocess-tencent.service
sudo systemctl restart wechat-media-tencent.service
```

## GCP install

```bash
cd ~/wechat-assistant
mkdir -p /tmp/wechat-systemd
cp scripts/ops/systemd/submit-gcp.service /tmp/wechat-systemd/
cp scripts/ops/systemd/poll-gcp.service /tmp/wechat-systemd/
sed -i "s#__USER__#nkyy0923#g" /tmp/wechat-systemd/submit-gcp.service
sed -i "s#__WORKDIR__#/home/nkyy0923/wechat-assistant#g" /tmp/wechat-systemd/submit-gcp.service
sed -i "s#__USER__#nkyy0923#g" /tmp/wechat-systemd/poll-gcp.service
sed -i "s#__WORKDIR__#/home/nkyy0923/wechat-assistant#g" /tmp/wechat-systemd/poll-gcp.service
sudo cp /tmp/wechat-systemd/submit-gcp.service /etc/systemd/system/
sudo cp /tmp/wechat-systemd/poll-gcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable submit-gcp.service
sudo systemctl enable poll-gcp.service
sudo systemctl restart submit-gcp.service
sudo systemctl restart poll-gcp.service
```

## Stop tmux workers before switching

Tencent Cloud:

```bash
tmux kill-session -t preprocess-tencent 2>/dev/null || true
tmux kill-session -t wechat-media-tencent 2>/dev/null || true
pkill -f preprocess-new.mjs || true
pkill -f wechat-media-worker.mjs || true
```

GCP:

```bash
tmux kill-session -t submit-gcp 2>/dev/null || true
tmux kill-session -t poll-gcp 2>/dev/null || true
pkill -f openai-video-batch-submit || true
pkill -f openai-video-batch-poll || true
```

## Status

Tencent Cloud:

```bash
sudo systemctl status preprocess-tencent.service --no-pager
sudo systemctl status wechat-media-tencent.service --no-pager
```

GCP:

```bash
sudo systemctl status submit-gcp.service --no-pager
sudo systemctl status poll-gcp.service --no-pager
```

## Logs

Tencent Cloud:

```bash
journalctl -u preprocess-tencent.service -f
journalctl -u wechat-media-tencent.service -f
```

GCP:

```bash
journalctl -u submit-gcp.service -f
journalctl -u poll-gcp.service -f
```

## Optional preprocess stability switch

If Tencent Cloud CI snapshot requests are unstable, try:

```env
OPENAI_VIDEO_PREPROCESS_DOWNLOAD_SOURCE=true
```

That makes preprocessing download the source file and use local `ffprobe` / `ffmpeg` instead of relying only on remote CI snapshot fetches.
