import argparse
import json
import math
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from uuid import uuid4

import cv2

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
DOWNLOAD_RETRIES = 3
DOWNLOAD_TIMEOUT_SECONDS = 120
DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024
DEFAULT_PROVIDER = os.getenv("VIDEO_ANALYSIS_PROVIDER", "mediapipe").strip().lower() or "mediapipe"
DEFAULT_GEMINI_MODEL = os.getenv("VIDEO_ANALYSIS_GEMINI_MODEL", "gemini-2.5-pro").strip() or "gemini-2.5-pro"
DEFAULT_GCP_PROJECT_ID = os.getenv("GCP_PROJECT_ID", "").strip()
DEFAULT_GCP_LOCATION = os.getenv("GCP_LOCATION", "us-central1").strip() or "us-central1"
DEFAULT_GCS_BUCKET = os.getenv("GCS_VIDEO_REVIEW_BUCKET", "").strip()
DEFAULT_SEGMENT_SECONDS = int(float(os.getenv("VIDEO_ANALYSIS_SEGMENT_SECONDS", "6") or 6))
DEFAULT_SEGMENT_OVERLAP_SECONDS = int(float(os.getenv("VIDEO_ANALYSIS_SEGMENT_OVERLAP_SECONDS", "2") or 2))
DEFAULT_GCS_PREFIX = os.getenv("VIDEO_ANALYSIS_GCS_PREFIX", "video-review-clips").strip() or "video-review-clips"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="First-pass dual-hand video quality analysis")
    parser.add_argument("--input-url", required=True, help="Presigned GET URL for the source video")
    parser.add_argument("--sample-fps", type=float, default=3.0, help="Target sampled frames per second")
    parser.add_argument(
        "--min-window-hit-ratio",
        type=float,
        default=0.67,
        help="Minimum fraction of sampled frames in a 1-second window that must contain two hands",
    )
    parser.add_argument("--pass-ratio", type=float, default=0.65, help="Auto-pass threshold")
    parser.add_argument("--review-ratio", type=float, default=0.5, help="Needs-review threshold")
    parser.add_argument(
        "--provider",
        default=DEFAULT_PROVIDER,
        choices=("mediapipe", "gemini"),
        help="Video analysis backend",
    )
    return parser.parse_args()


def ensure_model() -> Path:
    model_dir = Path(__file__).resolve().parent / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / "hand_landmarker.task"
    if not model_path.exists():
        urllib.request.urlretrieve(MODEL_URL, model_path)
    return model_path


def _download_once(url: str, destination: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "wechat-assistant-video-qc/1.0",
            "Accept": "*/*",
            "Connection": "close",
        },
    )
    with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
        expected_length_header = response.headers.get("Content-Length")
        expected_length = int(expected_length_header) if expected_length_header else None
        bytes_written = 0

        with destination.open("wb") as output_file:
            while True:
                chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                output_file.write(chunk)
                bytes_written += len(chunk)

        if expected_length is not None and bytes_written != expected_length:
            raise urllib.error.ContentTooShortError(
                f"retrieval incomplete: got only {bytes_written} out of {expected_length} bytes",
                None,
            )


def download_video(url: str) -> Path:
    last_error: Exception | None = None

    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as temp_file:
            temp_path = Path(temp_file.name)

        try:
            _download_once(url, temp_path)
            if temp_path.stat().st_size <= 0:
                raise RuntimeError("downloaded video is empty")
            return temp_path
        except (
            urllib.error.ContentTooShortError,
            urllib.error.URLError,
            TimeoutError,
            socket.timeout,
            OSError,
            RuntimeError,
        ) as error:
            last_error = error
            temp_path.unlink(missing_ok=True)
            if attempt >= DOWNLOAD_RETRIES:
                break
            time.sleep(min(2**attempt, 5))

    if last_error is None:
        raise RuntimeError("video download failed for an unknown reason")
    raise RuntimeError(
        f"video download failed after {DOWNLOAD_RETRIES} attempts: {last_error}"
    ) from last_error


def create_detector(model_path: Path):
    import mediapipe as mp  # noqa: F401
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    options = vision.HandLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.HandLandmarker.create_from_options(options)


def classify_decision(ratio: float, pass_ratio: float, review_ratio: float) -> str:
    if ratio > pass_ratio:
        return "auto_pass"
    if ratio >= review_ratio:
        return "review_needed"
    return "auto_reject"


def read_video_metadata(video_path: Path) -> dict:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()

    if fps <= 0 or total_frames <= 0:
        raise RuntimeError("Video metadata is invalid or empty")

    return {
        "fps": fps,
        "total_frames": total_frames,
        "duration_seconds": total_frames / fps,
        "width": width,
        "height": height,
    }


def analyze_video_mediapipe(
    video_path: Path,
    detector,
    sample_fps: float,
    min_window_hit_ratio: float,
    pass_ratio: float,
    review_ratio: float,
) -> dict:
    import mediapipe as mp

    metadata = read_video_metadata(video_path)
    fps = metadata["fps"]
    total_frames = metadata["total_frames"]

    cap = cv2.VideoCapture(str(video_path))
    sample_step = max(1, int(round(fps / max(sample_fps, 0.1))))
    sampled_frames = 0
    dual_hand_frames = 0
    windows = defaultdict(lambda: {"samples": 0, "hits": 0})

    frame_index = 0
    while True:
        grabbed = cap.grab()
        if not grabbed:
            break

        if frame_index % sample_step != 0:
            frame_index += 1
            continue

        ok, frame = cap.retrieve()
        if not ok:
            frame_index += 1
            continue

        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        timestamp_ms = int(round(frame_index / fps * 1000))
        detection_result = detector.detect_for_video(mp_image, timestamp_ms)
        hand_count = len(detection_result.hand_landmarks) if detection_result.hand_landmarks else 0
        dual_hand_hit = hand_count >= 2

        sampled_frames += 1
        if dual_hand_hit:
            dual_hand_frames += 1

        window_index = int(frame_index / fps)
        windows[window_index]["samples"] += 1
        if dual_hand_hit:
            windows[window_index]["hits"] += 1

        frame_index += 1

    cap.release()

    total_windows = len(windows)
    dual_hand_windows = 0
    window_debug = []

    for window_index in sorted(windows):
        bucket = windows[window_index]
        required_hits = max(1, math.ceil(bucket["samples"] * min_window_hit_ratio - 1e-9))
        qualified = bucket["hits"] >= required_hits
        if qualified:
            dual_hand_windows += 1
        window_debug.append(
            {
                "second": window_index,
                "samples": bucket["samples"],
                "hits": bucket["hits"],
                "required_hits": required_hits,
                "qualified": qualified,
            }
        )

    frame_ratio = dual_hand_frames / sampled_frames if sampled_frames else 0.0
    window_ratio = dual_hand_windows / total_windows if total_windows else 0.0
    decision = classify_decision(frame_ratio, pass_ratio, review_ratio)
    reason = (
        f"Detected two hands in {dual_hand_frames} of {sampled_frames} sampled frames "
        f"({frame_ratio * 100:.1f}%)."
    )

    return {
        "ok": True,
        "provider": "mediapipe",
        "decision": decision,
        "ratio": frame_ratio,
        "reason": reason,
        "video": metadata,
        "sampling": {
            "sample_fps": sample_fps,
            "sample_step_frames": sample_step,
            "min_window_hit_ratio": min_window_hit_ratio,
            "pass_ratio": pass_ratio,
            "review_ratio": review_ratio,
        },
        "totals": {
            "sampled_frames": sampled_frames,
            "dual_hand_frames": dual_hand_frames,
            "dual_hand_frame_ratio": frame_ratio,
            "sampled_windows": total_windows,
            "qualified_windows": dual_hand_windows,
            "qualified_window_ratio": window_ratio,
        },
        "windows": window_debug,
    }


def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def ensure_ffmpeg() -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is required for Gemini video segmentation but was not found on PATH")
    return ffmpeg_path


def chunk_start_times(duration_seconds: float, segment_seconds: int, overlap_seconds: int) -> list[float]:
    if duration_seconds <= 0:
        return [0.0]

    step_seconds = max(segment_seconds - overlap_seconds, 1)
    starts: list[float] = []
    current = 0.0

    while current < duration_seconds:
        starts.append(round(current, 3))
        if current + segment_seconds >= duration_seconds:
            break
        current += step_seconds

    return starts


def segment_video(video_path: Path, segment_seconds: int, overlap_seconds: int) -> tuple[dict, list[dict], Path]:
    ffmpeg_path = ensure_ffmpeg()
    metadata = read_video_metadata(video_path)
    duration_seconds = metadata["duration_seconds"]

    segments_dir = Path(tempfile.mkdtemp(prefix="gemini-video-segments-"))
    segments: list[dict] = []

    for index, start_seconds in enumerate(
        chunk_start_times(duration_seconds, max(segment_seconds, 1), max(overlap_seconds, 0))
    ):
        remaining = max(duration_seconds - start_seconds, 0.0)
        clip_duration = min(float(segment_seconds), remaining) if remaining > 0 else float(segment_seconds)
        if clip_duration <= 0.25:
            continue

        segment_path = segments_dir / f"segment_{index:04d}.mp4"
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start_seconds:.3f}",
            "-i",
            str(video_path),
            "-t",
            f"{clip_duration:.3f}",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-movflags",
            "+faststart",
            str(segment_path),
        ]
        subprocess.run(command, check=True)
        if not segment_path.exists() or segment_path.stat().st_size <= 0:
            raise RuntimeError(f"ffmpeg produced an empty segment at {segment_path}")

        segments.append(
            {
                "index": index,
                "start_seconds": round(start_seconds, 3),
                "end_seconds": round(min(start_seconds + clip_duration, duration_seconds), 3),
                "duration_seconds": round(clip_duration, 3),
                "path": segment_path,
            }
        )

    if not segments:
        raise RuntimeError("No video segments were created for Gemini analysis")

    return metadata, segments, segments_dir


def create_gcs_client(project_id: str):
    from google.cloud import storage

    return storage.Client(project=project_id)


def upload_segment(bucket, prefix: str, segment: dict) -> str:
    remote_name = (
        f"{prefix}/segment_{segment['index']:04d}_{uuid4().hex}.mp4"
    )
    blob = bucket.blob(remote_name)
    blob.upload_from_filename(str(segment["path"]), content_type="video/mp4")
    return f"gs://{bucket.name}/{remote_name}"


def cleanup_gcs_objects(bucket, object_names: list[str]) -> None:
    for object_name in object_names:
        try:
            bucket.blob(object_name).delete()
        except Exception:
            pass


def strip_json_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        lines = cleaned.splitlines()
        if lines and lines[0].strip().lower() == "json":
            lines = lines[1:]
        cleaned = "\n".join(lines).strip()
    return cleaned


def coerce_ratio(value, fallback: float = 0.0) -> float:
    try:
        ratio = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(0.0, min(1.0, ratio))


def coerce_float(value, fallback: float = 0.0, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def format_seconds_label(value: float) -> str:
    total_seconds = max(0, int(round(value)))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def normalize_reason_text(value: str) -> str:
    cleaned = " ".join((value or "").strip().split())
    return cleaned[:300]


def build_gemini_prompt(segment: dict) -> str:
    return f"""
You are an embodied AI data annotation expert auditing first-person (ego-centric) training video quality.

Task:
Review this first-person video segment and determine how many seconds in this segment are QUALIFIED.

Core rules that must ALL be satisfied for a second to count as qualified:
1. Bimanual presence:
   - Left hand and right hand must appear in the frame at the same time.
   - If either hand is missing, that moment is invalid.
2. Limb completeness:
   - Both hands and forearms should stay present in the frame for a continuous duration.
3. Boundary tolerance:
   - The moment is still valid if at least 90% of each hand/forearm contour remains in frame.
   - Slight clipping of fingertips or the side of the forearm is acceptable if overall action recognition is still clear.
4. Invalid scenarios:
   - Single-handed operation
   - One hand disappears completely
   - More than 10% of a hand or forearm is truncated by the frame boundary
   - Hands are technically visible but not participating in a meaningful cooperative action

Segment metadata:
- start_seconds: {segment["start_seconds"]}
- end_seconds: {segment["end_seconds"]}
- duration_seconds: {segment["duration_seconds"]}

Return only JSON with this shape:
{{
  "segment_decision": "pass" | "review" | "reject",
  "qualified_seconds_estimate": 0.0,
  "bimanual_visibility_rate_estimate": 0.0,
  "qualified_ranges": [
    {{
      "start_offset_seconds": 0.0,
      "end_offset_seconds": 0.0,
      "reason": "short explanation"
    }}
  ],
  "violations": [
    {{
      "time_offset_seconds": 0.0,
      "reason": "short concise reason"
    }}
  ],
  "dominant_failure_reasons": [
    "single_hand_only",
    "left_hand_missing",
    "right_hand_missing",
    "forearm_missing_or_too_short",
    "large_boundary_truncation",
    "not_meaningful_bimanual_action"
  ],
  "confidence": 0.0,
  "summary": "short explanation"
}}

Rules:
- qualified_seconds_estimate must be between 0.0 and duration_seconds
- bimanual_visibility_rate_estimate must be between 0.0 and 1.0
- confidence must be between 0.0 and 1.0
- If a violation happens at a specific moment, include it in violations with the approximate offset in seconds.
- Prefer a few high-signal violations rather than an exhaustive frame-by-frame list.
- Qualified ranges should only include periods that satisfy all four core rules.
- Use "review" if uncertain
- Return JSON only, no markdown
""".strip()


def create_gemini_client(project_id: str, location: str):
    from google import genai

    return genai.Client(vertexai=True, project=project_id, location=location)


def review_segment_with_gemini(client, model_name: str, gcs_uri: str, segment: dict) -> dict:
    from google.genai import types

    prompt = build_gemini_prompt(segment)
    response = client.models.generate_content(
        model=model_name,
        contents=[
            types.Part.from_uri(file_uri=gcs_uri, mime_type="video/mp4"),
            prompt,
        ],
        config=types.GenerateContentConfig(
            temperature=0.1,
            response_mime_type="application/json",
        ),
    )

    response_text = strip_json_fence(response.text or "")
    if not response_text:
        raise RuntimeError(f"Gemini returned an empty response for segment {segment['index']}")

    parsed = json.loads(response_text)
    segment_decision = str(parsed.get("segment_decision", "review")).strip().lower()
    if segment_decision not in {"pass", "review", "reject"}:
        segment_decision = "review"

    duration_seconds = float(segment["duration_seconds"])
    qualified_seconds = coerce_float(
        parsed.get("qualified_seconds_estimate"),
        fallback=0.0,
        minimum=0.0,
        maximum=duration_seconds,
    )
    visibility_rate = coerce_ratio(
        parsed.get("bimanual_visibility_rate_estimate"),
        fallback=qualified_seconds / duration_seconds if duration_seconds > 0 else 0.0,
    )

    qualified_ranges = []
    for item in parsed.get("qualified_ranges", []) or []:
        start_offset = coerce_float(item.get("start_offset_seconds"), minimum=0.0, maximum=duration_seconds)
        end_offset = coerce_float(item.get("end_offset_seconds"), minimum=0.0, maximum=duration_seconds)
        if end_offset <= start_offset:
            continue
        qualified_ranges.append(
            {
                "start_offset_seconds": round(start_offset, 3),
                "end_offset_seconds": round(end_offset, 3),
                "reason": normalize_reason_text(str(item.get("reason", ""))),
            }
        )

    violations = []
    for item in parsed.get("violations", []) or []:
        offset = coerce_float(item.get("time_offset_seconds"), minimum=0.0, maximum=duration_seconds)
        reason = normalize_reason_text(str(item.get("reason", "")))
        if not reason:
            continue
        violations.append(
            {
                "time_offset_seconds": round(offset, 3),
                "reason": reason,
            }
        )

    dominant_failure_reasons = []
    for item in parsed.get("dominant_failure_reasons", []) or []:
        normalized = normalize_reason_text(str(item)).lower().replace(" ", "_")
        if normalized:
            dominant_failure_reasons.append(normalized)

    return {
        "segment_index": segment["index"],
        "start_seconds": segment["start_seconds"],
        "end_seconds": segment["end_seconds"],
        "duration_seconds": segment["duration_seconds"],
        "segment_decision": segment_decision,
        "qualified_seconds_estimate": round(qualified_seconds, 3),
        "bimanual_visibility_rate_estimate": visibility_rate,
        "qualified_ranges": qualified_ranges,
        "violations": violations,
        "dominant_failure_reasons": dominant_failure_reasons,
        "confidence": coerce_ratio(parsed.get("confidence"), fallback=0.5),
        "summary": normalize_reason_text(str(parsed.get("summary", ""))),
        "gcs_uri": gcs_uri,
    }


def summarize_gemini_results(segment_results: list[dict], pass_ratio: float, review_ratio: float) -> dict:
    if not segment_results:
        raise RuntimeError("Gemini produced no segment results")

    total_duration = max(item["end_seconds"] for item in segment_results)
    total_seconds_int = max(1, math.ceil(total_duration))
    second_qualified = [False] * total_seconds_int
    violation_events = []
    dominant_failure_counts = Counter()

    for item in segment_results:
        segment_start = float(item["start_seconds"])
        segment_end = float(item["end_seconds"])
        for qualified_range in item.get("qualified_ranges", []):
            absolute_start = segment_start + float(qualified_range["start_offset_seconds"])
            absolute_end = min(segment_end, segment_start + float(qualified_range["end_offset_seconds"]))
            if absolute_end <= absolute_start:
                continue
            start_index = max(0, int(math.floor(absolute_start)))
            end_index = min(total_seconds_int, int(math.ceil(absolute_end)))
            for second_index in range(start_index, end_index):
                second_qualified[second_index] = True

        for violation in item.get("violations", []):
            absolute_time = min(segment_end, segment_start + float(violation["time_offset_seconds"]))
            violation_events.append(
                {
                    "time_seconds": round(absolute_time, 3),
                    "time_label": format_seconds_label(absolute_time),
                    "reason": violation["reason"],
                }
            )

        dominant_failure_counts.update(item.get("dominant_failure_reasons", []))

    qualified_seconds_total = sum(1 for qualified in second_qualified if qualified)
    ratio = qualified_seconds_total / total_seconds_int if total_seconds_int else 0.0
    final_decision = classify_decision(ratio, pass_ratio, review_ratio)
    conclusion = "QUALIFIED" if ratio >= pass_ratio else "UNQUALIFIED"

    qualified_ranges = []
    range_start = None
    for second_index, qualified in enumerate(second_qualified):
        if qualified and range_start is None:
            range_start = second_index
        elif not qualified and range_start is not None:
            qualified_ranges.append(
                {
                    "start_seconds": range_start,
                    "end_seconds": second_index,
                    "start_label": format_seconds_label(range_start),
                    "end_label": format_seconds_label(second_index),
                }
            )
            range_start = None
    if range_start is not None:
        qualified_ranges.append(
            {
                "start_seconds": range_start,
                "end_seconds": total_seconds_int,
                "start_label": format_seconds_label(range_start),
                "end_label": format_seconds_label(total_seconds_int),
            }
        )

    unique_violation_messages = []
    unique_violation_events = []
    seen = set()
    for violation in sorted(violation_events, key=lambda event: event["time_seconds"]):
        key = (violation["time_label"], violation["reason"])
        if key in seen:
            continue
        seen.add(key)
        unique_violation_messages.append(f"{violation['time_label']} {violation['reason']}")
        unique_violation_events.append(violation)

    if not unique_violation_messages:
        unique_violation_messages.append("No major violations were detected in the reviewed qualified ranges.")

    dominant_failure_summary = ", ".join(
        f"{reason} x{count}" for reason, count in dominant_failure_counts.most_common(5)
    ) or "none"

    summary = (
        f"T={total_seconds_int}s; V={qualified_seconds_total}s; R={ratio * 100:.1f}%; "
        f"Conclusion={conclusion}. Top failure reasons: {dominant_failure_summary}. "
        f"Violations: {'; '.join(unique_violation_messages[:12])}"
    )
    return {
        "ratio": ratio,
        "final_decision": final_decision,
        "final_conclusion": conclusion,
        "total_duration_seconds": total_seconds_int,
        "qualified_duration_seconds": qualified_seconds_total,
        "bimanual_visibility_rate_percent": round(ratio * 100, 2),
        "qualified_ranges": qualified_ranges,
        "violation_analysis": unique_violation_events,
        "dominant_failure_summary": dominant_failure_summary,
        "summary": summary,
    }


def analyze_video_gemini(
    video_path: Path,
    pass_ratio: float,
    review_ratio: float,
) -> dict:
    project_id = get_required_env("GCP_PROJECT_ID")
    location = os.getenv("GCP_LOCATION", DEFAULT_GCP_LOCATION).strip() or DEFAULT_GCP_LOCATION
    bucket_name = get_required_env("GCS_VIDEO_REVIEW_BUCKET")
    model_name = os.getenv("VIDEO_ANALYSIS_GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
    segment_seconds = max(1, int(float(os.getenv("VIDEO_ANALYSIS_SEGMENT_SECONDS", str(DEFAULT_SEGMENT_SECONDS)))))
    overlap_seconds = max(
        0,
        int(float(os.getenv("VIDEO_ANALYSIS_SEGMENT_OVERLAP_SECONDS", str(DEFAULT_SEGMENT_OVERLAP_SECONDS)))),
    )
    if overlap_seconds >= segment_seconds:
        overlap_seconds = max(segment_seconds - 1, 0)

    metadata, segments, segments_dir = segment_video(video_path, segment_seconds, overlap_seconds)
    storage_client = create_gcs_client(project_id)
    bucket = storage_client.bucket(bucket_name)
    prefix = f"{DEFAULT_GCS_PREFIX}/{uuid4().hex}"
    uploaded_object_names: list[str] = []
    client = create_gemini_client(project_id, location)
    segment_results: list[dict] = []
    effective_pass_ratio = max(pass_ratio, 0.70)
    effective_review_ratio = min(review_ratio, effective_pass_ratio)

    try:
        for segment in segments:
            gcs_uri = upload_segment(bucket, prefix, segment)
            uploaded_object_names.append(gcs_uri.removeprefix(f"gs://{bucket_name}/"))
            segment_results.append(review_segment_with_gemini(client, model_name, gcs_uri, segment))
    finally:
        cleanup_gcs_objects(bucket, uploaded_object_names)
        shutil.rmtree(segments_dir, ignore_errors=True)

    audit = summarize_gemini_results(segment_results, effective_pass_ratio, effective_review_ratio)
    return {
        "ok": True,
        "provider": "gemini",
        "decision": audit["final_decision"],
        "ratio": audit["ratio"],
        "reason": audit["summary"],
        "video": metadata,
        "gemini": {
            "project_id": project_id,
            "location": location,
            "bucket_name": bucket_name,
            "model": model_name,
            "segment_seconds": segment_seconds,
            "segment_overlap_seconds": overlap_seconds,
        },
        "audit": {
            "total_duration_seconds": audit["total_duration_seconds"],
            "qualified_duration_seconds": audit["qualified_duration_seconds"],
            "bimanual_visibility_rate_percent": audit["bimanual_visibility_rate_percent"],
            "final_conclusion": audit["final_conclusion"],
            "pass_threshold_percent": round(effective_pass_ratio * 100, 2),
            "qualified_ranges": audit["qualified_ranges"],
            "violation_analysis": audit["violation_analysis"],
            "dominant_failure_summary": audit["dominant_failure_summary"],
        },
        "segments": segment_results,
        "totals": {
            "segments_reviewed": len(segment_results),
            "segment_decision_counts": dict(Counter(item["segment_decision"] for item in segment_results)),
            "total_duration_seconds": audit["total_duration_seconds"],
            "qualified_duration_seconds": audit["qualified_duration_seconds"],
            "bimanual_visibility_rate_percent": audit["bimanual_visibility_rate_percent"],
        },
    }


def analyze_video(provider: str, video_path: Path, args: argparse.Namespace) -> dict:
    if provider == "gemini":
        return analyze_video_gemini(
            video_path=video_path,
            pass_ratio=args.pass_ratio,
            review_ratio=args.review_ratio,
        )

    model_path = ensure_model()
    detector = create_detector(model_path)
    try:
        return analyze_video_mediapipe(
            video_path=video_path,
            detector=detector,
            sample_fps=args.sample_fps,
            min_window_hit_ratio=args.min_window_hit_ratio,
            pass_ratio=args.pass_ratio,
            review_ratio=args.review_ratio,
        )
    finally:
        detector.close()


def main() -> None:
    args = parse_args()
    temp_video = download_video(args.input_url)

    try:
        result = analyze_video(provider=args.provider, video_path=temp_video, args=args)
    finally:
        temp_video.unlink(missing_ok=True)

    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
