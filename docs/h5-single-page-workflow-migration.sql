-- Single H5 page workflow migration
-- Based on: docs/公众号H5视频采集流程修订版_测试视频版.ai.md
-- Target: PostgreSQL

BEGIN;

-- 1. Participants: add explicit workflow fields
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS consent_confirmed BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS test_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS formal_status TEXT NOT NULL DEFAULT 'not_started';

ALTER TABLE public.participants
  DROP CONSTRAINT IF EXISTS participants_test_status_chk;

ALTER TABLE public.participants
  ADD CONSTRAINT participants_test_status_chk
  CHECK (test_status IN ('not_started', 'pending', 'passed', 'failed'));

ALTER TABLE public.participants
  DROP CONSTRAINT IF EXISTS participants_formal_status_chk;

ALTER TABLE public.participants
  ADD CONSTRAINT participants_formal_status_chk
  CHECK (formal_status IN ('not_started', 'pending', 'reviewed'));

COMMENT ON COLUMN public.participants.consent_confirmed IS 'Whether the participant has confirmed participation terms.';
COMMENT ON COLUMN public.participants.test_status IS 'Test stage status: not_started / pending / passed / failed.';
COMMENT ON COLUMN public.participants.formal_status IS 'Formal task status: not_started / pending / reviewed.';

-- 2. Video submissions: add single-page workflow metadata
ALTER TABLE public.video_submissions
  ADD COLUMN IF NOT EXISTS submission_type TEXT,
  ADD COLUMN IF NOT EXISTS scene TEXT;

ALTER TABLE public.video_submissions
  DROP CONSTRAINT IF EXISTS video_submissions_submission_type_chk;

ALTER TABLE public.video_submissions
  ADD CONSTRAINT video_submissions_submission_type_chk
  CHECK (
    submission_type IS NULL
    OR submission_type IN ('test', 'formal')
  );

COMMENT ON COLUMN public.video_submissions.submission_type IS 'Single-page workflow type: test or formal.';
COMMENT ON COLUMN public.video_submissions.scene IS 'Selected upload scene on the H5 page.';

CREATE INDEX IF NOT EXISTS idx_video_submissions_submission_type
  ON public.video_submissions (submission_type);

CREATE INDEX IF NOT EXISTS idx_video_submissions_scene
  ON public.video_submissions (scene);

-- 3. Backfill old data
-- Old rows without submission_type are treated as early test submissions
-- if the participant has not yet entered the formal stage.
UPDATE public.participants
SET
  consent_confirmed = TRUE,
  test_status = CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.video_submissions s
      WHERE s.participant_id = public.participants.id
        AND COALESCE(s.submission_type, 'test') = 'test'
        AND s.review_status = 'approved'
    ) THEN 'passed'
    WHEN EXISTS (
      SELECT 1
      FROM public.video_submissions s
      WHERE s.participant_id = public.participants.id
        AND COALESCE(s.submission_type, 'test') = 'test'
        AND s.review_status = 'rejected'
    ) THEN 'failed'
    WHEN EXISTS (
      SELECT 1
      FROM public.video_submissions s
      WHERE s.participant_id = public.participants.id
        AND COALESCE(s.submission_type, 'test') = 'test'
        AND s.review_status = 'pending'
    ) THEN 'pending'
    ELSE 'not_started'
  END,
  formal_status = CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.video_submissions s
      WHERE s.participant_id = public.participants.id
        AND s.submission_type = 'formal'
        AND s.review_status IN ('approved', 'rejected')
    ) THEN 'reviewed'
    WHEN EXISTS (
      SELECT 1
      FROM public.video_submissions s
      WHERE s.participant_id = public.participants.id
        AND s.submission_type = 'formal'
        AND s.review_status = 'pending'
    ) THEN 'pending'
    ELSE 'not_started'
  END;

UPDATE public.video_submissions s
SET submission_type = CASE
  WHEN submission_type IS NOT NULL THEN submission_type
  WHEN EXISTS (
    SELECT 1
    FROM public.participants p
    WHERE p.id = s.participant_id
      AND p.formal_status <> 'not_started'
  ) THEN 'formal'
  ELSE 'test'
END
WHERE submission_type IS NULL;

COMMIT;

-- Optional checks
-- SELECT id, participant_code, consent_confirmed, test_status, formal_status
-- FROM public.participants
-- ORDER BY id DESC;
--
-- SELECT id, participant_code, submission_type, scene, review_status, created_at
-- FROM public.video_submissions
-- ORDER BY id DESC;
