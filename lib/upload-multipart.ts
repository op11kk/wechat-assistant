export const MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024;
export const DEFAULT_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = 10_000;
export const DEFAULT_MULTIPART_CONCURRENCY = 3;
export const MAX_MULTIPART_CONCURRENCY = 5;

export function getMultipartPartSize(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return DEFAULT_MULTIPART_PART_SIZE;
  }
  const candidate = Math.max(DEFAULT_MULTIPART_PART_SIZE, Math.ceil(sizeBytes / MAX_MULTIPART_PARTS));
  return Math.max(candidate, MIN_MULTIPART_PART_SIZE);
}

export function getMultipartPartCount(sizeBytes: number, partSize: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return 0;
  }
  return Math.ceil(sizeBytes / partSize);
}
