import { dbQuery, dbQueryOne } from "@/lib/db";
import { getWebMvpRelation } from "@/lib/env";

const webUsersTable = getWebMvpRelation("web_users");
const webTeamsTable = getWebMvpRelation("web_teams");
const webCollectorsTable = getWebMvpRelation("web_collectors");
const webUploadSessionsTable = getWebMvpRelation("web_upload_sessions");
const webVideoSubmissionsTable = getWebMvpRelation("web_video_submissions");
const webPhoneVerificationCodesTable = getWebMvpRelation("web_phone_verification_codes");

export type DomesticDatabaseCounts = {
  appUsers: number;
  participants: number;
  leaders: number;
  uploadSessions: number;
  videoSubmissions: number;
  verificationCodes: number;
};

export type DomesticDatabaseParticipant = {
  id: number;
  participantCode: string;
  realName: string;
  phone: string;
  status: string;
  testStatus: string | null;
  formalStatus: string | null;
  leaderName: string | null;
  appUserPhone: string | null;
  createdAt: string | null;
};

export type DomesticDatabaseUploadSession = {
  id: string;
  participantCode: string;
  participantName: string | null;
  source: string;
  fileName: string | null;
  objectKey: string | null;
  sizeBytes: number;
  status: string;
  createdAt: string | null;
  completedAt: string | null;
};

export type DomesticDatabaseVideoSubmission = {
  id: number;
  participantCode: string;
  participantName: string | null;
  leaderName: string | null;
  source: string;
  fileName: string | null;
  objectKey: string | null;
  sizeBytes: number;
  reviewStatus: string;
  analysisStatus: string | null;
  analysisDecision: string | null;
  analysisSummary: string | null;
  createdAt: string | null;
};

export type DomesticDatabaseAccount = {
  id: number;
  phone: string;
  role: string;
  status: string;
  displayName: string;
  realName: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
};

export type DomesticDatabaseSnapshot = {
  counts: DomesticDatabaseCounts;
  accounts: DomesticDatabaseAccount[];
  participants: DomesticDatabaseParticipant[];
  uploadSessions: DomesticDatabaseUploadSession[];
  videoSubmissions: DomesticDatabaseVideoSubmission[];
};

function parseNumber(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function parseText(value: unknown, fallback = "-"): string {
  return parseNullableText(value) ?? fallback;
}

export async function getDomesticDatabaseSnapshot(): Promise<DomesticDatabaseSnapshot> {
  const [counts, accounts, participants, uploadSessions, videoSubmissions] = await Promise.all([
    dbQueryOne<{
      app_users: unknown;
      participants: unknown;
      leaders: unknown;
      upload_sessions: unknown;
      video_submissions: unknown;
      verification_codes: unknown;
    }>(
      `select
         (select count(*) from ${webUsersTable}) as app_users,
         (select count(*) from ${webCollectorsTable}) as participants,
         (select count(*) from ${webTeamsTable}) as leaders,
         (select count(*) from ${webUploadSessionsTable}) as upload_sessions,
         (select count(*) from ${webVideoSubmissionsTable}) as video_submissions,
         (select count(*) from ${webPhoneVerificationCodesTable}) as verification_codes`,
    ),
    dbQuery<{
      id: unknown;
      phone: unknown;
      role: unknown;
      status: unknown;
      display_name: unknown;
      real_name: unknown;
      last_login_at: unknown;
      created_at: unknown;
    }>(
      `select id, phone, role, status, display_name, real_name, last_login_at, created_at
       from ${webUsersTable}
       order by id desc
       limit 100`,
    ),
    dbQuery<{
      id: unknown;
      participant_code: unknown;
      real_name: unknown;
      phone: unknown;
      status: unknown;
      test_status: unknown;
      formal_status: unknown;
      leader_name: unknown;
      app_user_phone: unknown;
      created_at: unknown;
    }>(
      `select
         p.id,
         p.collector_code as participant_code,
         p.real_name,
         p.phone,
         p.status,
         p.extra ->> 'test_status' as test_status,
         p.extra ->> 'formal_status' as formal_status,
         l.team_name as leader_name,
         u.phone as app_user_phone,
         p.created_at
       from ${webCollectorsTable} p
       left join ${webTeamsTable} l
         on l.id = p.team_id
       left join ${webUsersTable} u
         on u.id = p.user_id
       order by p.created_at desc, p.id desc
       limit 200`,
    ),
    dbQuery<{
      id: unknown;
      participant_code: unknown;
      participant_name: unknown;
      source: unknown;
      file_name: unknown;
      object_key: unknown;
      size_bytes: unknown;
      status: unknown;
      created_at: unknown;
      completed_at: unknown;
    }>(
      `select
         u.id,
         u.collector_code as participant_code,
         p.real_name as participant_name,
         u.source,
         u.file_name,
         u.object_key,
         u.size_bytes,
         u.status,
         u.created_at,
         u.completed_at
       from ${webUploadSessionsTable} u
       left join ${webCollectorsTable} p
         on p.id = u.collector_id
       order by u.created_at desc
       limit 200`,
    ),
    dbQuery<{
      id: unknown;
      participant_code: unknown;
      participant_name: unknown;
      leader_name: unknown;
      source: unknown;
      file_name: unknown;
      object_key: unknown;
      size_bytes: unknown;
      review_status: unknown;
      analysis_status: unknown;
      analysis_decision: unknown;
      analysis_summary: unknown;
      created_at: unknown;
    }>(
      `select
         s.id,
         s.collector_code as participant_code,
         p.real_name as participant_name,
         l.team_name as leader_name,
         s.source,
         s.file_name,
         s.object_key,
         s.size_bytes,
         s.review_status,
         s.analysis_status,
         s.analysis_decision,
         s.analysis_summary,
         s.created_at
       from ${webVideoSubmissionsTable} s
       left join ${webCollectorsTable} p
         on p.id = s.collector_id
       left join ${webTeamsTable} l
         on l.id = p.team_id
       order by s.created_at desc, s.id desc
       limit 200`,
    ),
  ]);

  return {
    counts: {
      appUsers: parseNumber(counts.app_users),
      participants: parseNumber(counts.participants),
      leaders: parseNumber(counts.leaders),
      uploadSessions: parseNumber(counts.upload_sessions),
      videoSubmissions: parseNumber(counts.video_submissions),
      verificationCodes: parseNumber(counts.verification_codes),
    },
    accounts: accounts.map((row) => ({
      id: parseNumber(row.id),
      phone: parseText(row.phone),
      role: parseText(row.role),
      status: parseText(row.status),
      displayName: parseText(row.display_name),
      realName: parseNullableText(row.real_name),
      lastLoginAt: parseNullableText(row.last_login_at),
      createdAt: parseNullableText(row.created_at),
    })),
    participants: participants.map((row) => ({
      id: parseNumber(row.id),
      participantCode: parseText(row.participant_code),
      realName: parseText(row.real_name),
      phone: parseText(row.phone),
      status: parseText(row.status),
      testStatus: parseNullableText(row.test_status),
      formalStatus: parseNullableText(row.formal_status),
      leaderName: parseNullableText(row.leader_name),
      appUserPhone: parseNullableText(row.app_user_phone),
      createdAt: parseNullableText(row.created_at),
    })),
    uploadSessions: uploadSessions.map((row) => ({
      id: parseText(row.id),
      participantCode: parseText(row.participant_code),
      participantName: parseNullableText(row.participant_name),
      source: parseText(row.source),
      fileName: parseNullableText(row.file_name),
      objectKey: parseNullableText(row.object_key),
      sizeBytes: parseNumber(row.size_bytes),
      status: parseText(row.status),
      createdAt: parseNullableText(row.created_at),
      completedAt: parseNullableText(row.completed_at),
    })),
    videoSubmissions: videoSubmissions.map((row) => ({
      id: parseNumber(row.id),
      participantCode: parseText(row.participant_code),
      participantName: parseNullableText(row.participant_name),
      leaderName: parseNullableText(row.leader_name),
      source: parseText(row.source),
      fileName: parseNullableText(row.file_name),
      objectKey: parseNullableText(row.object_key),
      sizeBytes: parseNumber(row.size_bytes),
      reviewStatus: parseText(row.review_status),
      analysisStatus: parseNullableText(row.analysis_status),
      analysisDecision: parseNullableText(row.analysis_decision),
      analysisSummary: parseNullableText(row.analysis_summary),
      createdAt: parseNullableText(row.created_at),
    })),
  };
}
