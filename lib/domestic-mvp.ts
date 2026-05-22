import { dbQuery, dbQueryMaybeOne, dbQueryOne } from "@/lib/db";
import { getWebMvpRelation } from "@/lib/env";

const webUsersTable = getWebMvpRelation("web_users");
const webTeamsTable = getWebMvpRelation("web_teams");
const webCollectorsTable = getWebMvpRelation("web_collectors");
const webVideoSubmissionsTable = getWebMvpRelation("web_video_submissions");

export type DomesticAdminSummary = {
  participantCount: number;
  leaderCount: number;
  submissionCount: number;
  pendingReviewCount: number;
  approvedCount: number;
  rejectedCount: number;
};

export type DomesticLeaderSummary = {
  leaderId: number;
  promoterName: string;
  promoCode: string;
  status: string;
  participantCount: number;
  submissionCount: number;
  approvedCount: number;
  pendingCount: number;
};

export type DomesticLeaderCollectorRow = {
  participantId: number;
  participantCode: string;
  realName: string;
  phone: string;
  status: string;
  submissionCount: number;
  approvedCount: number;
  pendingCount: number;
  latestSubmittedAt: string | null;
};

export type DomesticSubmissionRow = {
  submissionId: number;
  participantId: number;
  participantCode: string;
  participantName: string;
  leaderName: string | null;
  source: string;
  scene: string | null;
  reviewStatus: string;
  analysisStatus: string | null;
  createdAt: string;
};

export type DomesticAdminCollectorRow = {
  participantId: number;
  participantCode: string;
  realName: string;
  phone: string;
  participantStatus: string;
  appUserId: number | null;
  appUserPhone: string | null;
  accountRole: string | null;
  accountStatus: string | null;
  leaderId: number | null;
  leaderName: string | null;
  leaderPromoCode: string | null;
  submissionCount: number;
  approvedCount: number;
  pendingCount: number;
  latestSubmittedAt: string | null;
};

export type DomesticAdminLeaderRow = {
  leaderId: number;
  promoterName: string;
  promoCode: string;
  leaderStatus: string;
  appUserId: number | null;
  appUserPhone: string | null;
  accountStatus: string | null;
  participantCount: number;
  submissionCount: number;
  approvedCount: number;
  pendingCount: number;
};

export type DomesticLeaderDashboard = {
  leader: DomesticLeaderSummary;
  collectors: DomesticLeaderCollectorRow[];
  recentSubmissions: DomesticSubmissionRow[];
};

export type DomesticLeaderParticipantSearchResult = {
  collector: DomesticLeaderCollectorRow;
  submissions: DomesticSubmissionRow[];
};

export type DomesticAdminDashboard = {
  summary: DomesticAdminSummary;
  leaders: DomesticLeaderSummary[];
  recentSubmissions: DomesticSubmissionRow[];
};

export type DomesticAdminLeaderCodeSearchResult = {
  leader: DomesticLeaderSummary;
  collectors: DomesticLeaderCollectorRow[];
  submissions: DomesticSubmissionRow[];
};

function parseCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

async function hasLeaderTable(): Promise<boolean> {
  const row = await dbQueryOne<{ exists: string | null }>(
    `select to_regclass('${webTeamsTable}') as exists`,
  );
  return Boolean(row.exists);
}

export async function getDomesticAdminSummary(): Promise<DomesticAdminSummary> {
  const leaderTableExists = await hasLeaderTable();
  const row = await dbQueryOne<{
    participant_count: unknown;
    submission_count: unknown;
    pending_review_count: unknown;
    approved_count: unknown;
    rejected_count: unknown;
  }>(
    `select
       (select count(*) from ${webCollectorsTable}) as participant_count,
       (select count(*) from ${webVideoSubmissionsTable}) as submission_count,
       (select count(*) from ${webVideoSubmissionsTable} where review_status = 'pending') as pending_review_count,
       (select count(*) from ${webVideoSubmissionsTable} where review_status = 'approved') as approved_count,
       (select count(*) from ${webVideoSubmissionsTable} where review_status = 'rejected') as rejected_count`,
  );

  return {
    participantCount: parseCount(row.participant_count),
    leaderCount: leaderTableExists
      ? parseCount(
          (
            await dbQueryOne<{ leader_count: unknown }>(
              `select count(*) as leader_count from ${webTeamsTable}`,
            )
          ).leader_count,
        )
      : 0,
    submissionCount: parseCount(row.submission_count),
    pendingReviewCount: parseCount(row.pending_review_count),
    approvedCount: parseCount(row.approved_count),
    rejectedCount: parseCount(row.rejected_count),
  };
}

export async function getDomesticLeaderSummaries(limit = 12): Promise<DomesticLeaderSummary[]> {
  if (!(await hasLeaderTable())) {
    return [];
  }

  const rows = await dbQuery<{
    leader_id: unknown;
    promoter_name: unknown;
    promo_code: unknown;
    status: unknown;
    participant_count: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
  }>(
    `select
       p.id as leader_id,
       p.team_name as promoter_name,
       p.team_code as promo_code,
       p.status,
       count(distinct c.id) as participant_count,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count
     from ${webTeamsTable} p
     left join ${webCollectorsTable} c
       on c.team_id = p.id
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = c.id
     group by p.id, p.team_name, p.team_code, p.status
     order by submission_count desc, participant_count desc, p.id asc
     limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    leaderId: parseCount(row.leader_id),
    promoterName: String(row.promoter_name ?? ""),
    promoCode: String(row.promo_code ?? ""),
    status: String(row.status ?? "active"),
    participantCount: parseCount(row.participant_count),
    submissionCount: parseCount(row.submission_count),
    approvedCount: parseCount(row.approved_count),
    pendingCount: parseCount(row.pending_count),
  }));
}

export async function getDomesticLeaderSummaryByAppUserId(appUserId: number): Promise<DomesticLeaderSummary | null> {
  if (!(await hasLeaderTable())) {
    return null;
  }

  const row = await dbQueryMaybeOne<{
    leader_id: unknown;
    promoter_name: unknown;
    promo_code: unknown;
    status: unknown;
    participant_count: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
  }>(
    `select
       p.id as leader_id,
       p.team_name as promoter_name,
       p.team_code as promo_code,
       p.status,
       count(distinct c.id) as participant_count,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count
     from ${webTeamsTable} p
     left join ${webCollectorsTable} c
       on c.team_id = p.id
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = c.id
     where p.leader_user_id = $1
     group by p.id, p.team_name, p.team_code, p.status
     limit 1`,
    [appUserId],
  );

  return row
    ? {
        leaderId: parseCount(row.leader_id),
        promoterName: String(row.promoter_name ?? ""),
        promoCode: String(row.promo_code ?? ""),
        status: String(row.status ?? "active"),
        participantCount: parseCount(row.participant_count),
        submissionCount: parseCount(row.submission_count),
        approvedCount: parseCount(row.approved_count),
        pendingCount: parseCount(row.pending_count),
      }
    : null;
}

export async function getDomesticLeaderCollectors(leaderId: number, limit = 100): Promise<DomesticLeaderCollectorRow[]> {
  const rows = await dbQuery<{
    participant_id: unknown;
    participant_code: unknown;
    real_name: unknown;
    phone: unknown;
    status: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
    latest_submitted_at: unknown;
  }>(
    `select
       p.id as participant_id,
       p.collector_code as participant_code,
       p.real_name,
       p.phone,
       p.status,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count,
       max(s.created_at) as latest_submitted_at
     from ${webCollectorsTable} p
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = p.id
     where p.team_id = $1
     group by p.id, p.collector_code, p.real_name, p.phone, p.status
     order by submission_count desc, p.id asc
     limit $2`,
    [leaderId, limit],
  );

  return rows.map((row) => ({
    participantId: parseCount(row.participant_id),
    participantCode: String(row.participant_code ?? ""),
    realName: String(row.real_name ?? ""),
    phone: String(row.phone ?? ""),
    status: String(row.status ?? "active"),
    submissionCount: parseCount(row.submission_count),
    approvedCount: parseCount(row.approved_count),
    pendingCount: parseCount(row.pending_count),
    latestSubmittedAt: parseNullableText(row.latest_submitted_at),
  }));
}

export async function getDomesticLeaderParticipantSearchByCode(
  leaderId: number,
  participantCode: string,
): Promise<DomesticLeaderParticipantSearchResult | null> {
  const normalizedCode = participantCode.trim();
  if (!normalizedCode) {
    return null;
  }

  const collector = await dbQueryMaybeOne<{
    participant_id: unknown;
    participant_code: unknown;
    real_name: unknown;
    phone: unknown;
    status: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
    latest_submitted_at: unknown;
  }>(
    `select
       p.id as participant_id,
       p.collector_code as participant_code,
       p.real_name,
       p.phone,
       p.status,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count,
       max(s.created_at) as latest_submitted_at
     from ${webCollectorsTable} p
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = p.id
     where p.team_id = $1
       and p.collector_code = $2
     group by p.id, p.collector_code, p.real_name, p.phone, p.status
     limit 1`,
    [leaderId, normalizedCode],
  );

  if (!collector) {
    return null;
  }

  const submissions = await dbQuery<{
    submission_id: unknown;
    participant_id: unknown;
    participant_code: unknown;
    participant_name: unknown;
    leader_name: unknown;
    source: unknown;
    scene: unknown;
    review_status: unknown;
    analysis_status: unknown;
    created_at: unknown;
  }>(
    `select
       s.id as submission_id,
       p.id as participant_id,
       p.collector_code as participant_code,
       p.real_name as participant_name,
       l.team_name as leader_name,
       s.source,
       s.extra ->> 'scene' as scene,
       s.review_status,
       s.analysis_status,
       s.created_at
     from ${webVideoSubmissionsTable} s
     join ${webCollectorsTable} p
       on p.id = s.collector_id
     left join ${webTeamsTable} l
       on l.id = p.team_id
     where p.team_id = $1
       and p.id = $2
     order by s.created_at desc
     limit 100`,
    [leaderId, parseCount(collector.participant_id)],
  );

  return {
    collector: {
      participantId: parseCount(collector.participant_id),
      participantCode: String(collector.participant_code ?? ""),
      realName: String(collector.real_name ?? ""),
      phone: String(collector.phone ?? ""),
      status: String(collector.status ?? "active"),
      submissionCount: parseCount(collector.submission_count),
      approvedCount: parseCount(collector.approved_count),
      pendingCount: parseCount(collector.pending_count),
      latestSubmittedAt: parseNullableText(collector.latest_submitted_at),
    },
    submissions: submissions.map((row) => ({
      submissionId: parseCount(row.submission_id),
      participantId: parseCount(row.participant_id),
      participantCode: String(row.participant_code ?? ""),
      participantName: String(row.participant_name ?? ""),
      leaderName: parseNullableText(row.leader_name),
      source: String(row.source ?? ""),
      scene: parseNullableText(row.scene),
      reviewStatus: String(row.review_status ?? "pending"),
      analysisStatus: parseNullableText(row.analysis_status),
      createdAt: String(row.created_at ?? ""),
    })),
  };
}

export async function getDomesticRecentSubmissions(params?: {
  leaderId?: number;
  limit?: number;
  reviewStatus?: "pending" | "approved" | "rejected";
}): Promise<DomesticSubmissionRow[]> {
  const limit = Math.min(Math.max(params?.limit ?? 20, 1), 100);
  const rows = params?.leaderId
    ? await dbQuery<{
        submission_id: unknown;
        participant_id: unknown;
        participant_code: unknown;
        participant_name: unknown;
        leader_name: unknown;
        source: unknown;
        scene: unknown;
        review_status: unknown;
        analysis_status: unknown;
        created_at: unknown;
      }>(
        `select
           s.id as submission_id,
           p.id as participant_id,
           p.collector_code as participant_code,
           p.real_name as participant_name,
           l.team_name as leader_name,
           s.source,
           s.extra ->> 'scene' as scene,
           s.review_status,
           s.analysis_status,
           s.created_at
         from ${webVideoSubmissionsTable} s
         join ${webCollectorsTable} p
           on p.id = s.collector_id
         left join ${webTeamsTable} l
           on l.id = p.team_id
         where p.team_id = $1
           and ($2::text is null or s.review_status = $2)
         order by s.created_at desc
         limit $3`,
        [params.leaderId, params.reviewStatus ?? null, limit],
      )
    : await dbQuery<{
        submission_id: unknown;
        participant_id: unknown;
        participant_code: unknown;
        participant_name: unknown;
        leader_name: unknown;
        source: unknown;
        scene: unknown;
        review_status: unknown;
        analysis_status: unknown;
        created_at: unknown;
      }>(
        `select
           s.id as submission_id,
           p.id as participant_id,
           p.collector_code as participant_code,
           p.real_name as participant_name,
           l.team_name as leader_name,
           s.source,
           s.extra ->> 'scene' as scene,
           s.review_status,
           s.analysis_status,
           s.created_at
         from ${webVideoSubmissionsTable} s
         join ${webCollectorsTable} p
           on p.id = s.collector_id
         left join ${webTeamsTable} l
           on l.id = p.team_id
         where ($1::text is null or s.review_status = $1)
         order by s.created_at desc
         limit $2`,
        [params?.reviewStatus ?? null, limit],
      );

  return rows.map((row) => ({
    submissionId: parseCount(row.submission_id),
    participantId: parseCount(row.participant_id),
    participantCode: String(row.participant_code ?? ""),
    participantName: String(row.participant_name ?? ""),
    leaderName: parseNullableText(row.leader_name),
    source: String(row.source ?? ""),
    scene: parseNullableText(row.scene),
    reviewStatus: String(row.review_status ?? "pending"),
    analysisStatus: parseNullableText(row.analysis_status),
    createdAt: String(row.created_at ?? ""),
  }));
}

export async function getDomesticLeaderDashboardByAppUserId(
  appUserId: number,
  options?: { reviewStatus?: "pending" | "approved" | "rejected" },
): Promise<DomesticLeaderDashboard | null> {
  const leader = await getDomesticLeaderSummaryByAppUserId(appUserId);
  if (!leader) {
    return null;
  }

  const [collectors, recentSubmissions] = await Promise.all([
    getDomesticLeaderCollectors(leader.leaderId, 100),
    getDomesticRecentSubmissions({
      leaderId: leader.leaderId,
      limit: 30,
      reviewStatus: options?.reviewStatus,
    }),
  ]);

  return {
    leader,
    collectors,
    recentSubmissions,
  };
}

export async function getDomesticAdminLeaderRows(limit = 100): Promise<DomesticAdminLeaderRow[]> {
  if (!(await hasLeaderTable())) {
    return [];
  }

  const rows = await dbQuery<{
    leader_id: unknown;
    promoter_name: unknown;
    promo_code: unknown;
    leader_status: unknown;
    app_user_id: unknown;
    app_user_phone: unknown;
    account_status: unknown;
    participant_count: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
  }>(
    `select
       l.id as leader_id,
       l.team_name as promoter_name,
       l.team_code as promo_code,
       l.status as leader_status,
       l.leader_user_id as app_user_id,
       u.phone as app_user_phone,
       u.status as account_status,
       count(distinct p.id) as participant_count,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count
     from ${webTeamsTable} l
     left join ${webUsersTable} u
       on u.id = l.leader_user_id
     left join ${webCollectorsTable} p
       on p.team_id = l.id
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = p.id
     group by l.id, l.team_name, l.team_code, l.status, l.leader_user_id, u.phone, u.status
     order by submission_count desc, participant_count desc, l.id asc
     limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    leaderId: parseCount(row.leader_id),
    promoterName: String(row.promoter_name ?? ""),
    promoCode: String(row.promo_code ?? ""),
    leaderStatus: String(row.leader_status ?? "active"),
    appUserId: row.app_user_id == null ? null : parseCount(row.app_user_id),
    appUserPhone: parseNullableText(row.app_user_phone),
    accountStatus: parseNullableText(row.account_status),
    participantCount: parseCount(row.participant_count),
    submissionCount: parseCount(row.submission_count),
    approvedCount: parseCount(row.approved_count),
    pendingCount: parseCount(row.pending_count),
  }));
}

export async function getDomesticAdminLeaderSearchByPromoCode(
  promoCode: string,
): Promise<DomesticAdminLeaderCodeSearchResult | null> {
  if (!(await hasLeaderTable())) {
    return null;
  }

  const normalizedCode = promoCode.trim();
  if (!normalizedCode) {
    return null;
  }

  const leader = await dbQueryMaybeOne<{
    leader_id: unknown;
    promoter_name: unknown;
    promo_code: unknown;
    status: unknown;
    participant_count: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
  }>(
    `select
       l.id as leader_id,
       l.team_name as promoter_name,
       l.team_code as promo_code,
       l.status,
       count(distinct p.id) as participant_count,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count
     from ${webTeamsTable} l
     left join ${webCollectorsTable} p
       on p.team_id = l.id
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = p.id
     where l.team_code = $1
     group by l.id, l.team_name, l.team_code, l.status
     limit 1`,
    [normalizedCode],
  );

  if (!leader) {
    return null;
  }

  const leaderId = parseCount(leader.leader_id);
  const [collectors, submissions] = await Promise.all([
    getDomesticLeaderCollectors(leaderId, 200),
    getDomesticRecentSubmissions({ leaderId, limit: 100 }),
  ]);

  return {
    leader: {
      leaderId,
      promoterName: String(leader.promoter_name ?? ""),
      promoCode: String(leader.promo_code ?? ""),
      status: String(leader.status ?? "active"),
      participantCount: parseCount(leader.participant_count),
      submissionCount: parseCount(leader.submission_count),
      approvedCount: parseCount(leader.approved_count),
      pendingCount: parseCount(leader.pending_count),
    },
    collectors,
    submissions,
  };
}

export async function getDomesticAdminCollectorRows(limit = 200): Promise<DomesticAdminCollectorRow[]> {
  const rows = await dbQuery<{
    participant_id: unknown;
    participant_code: unknown;
    real_name: unknown;
    phone: unknown;
    participant_status: unknown;
    app_user_id: unknown;
    app_user_phone: unknown;
    account_role: unknown;
    account_status: unknown;
    leader_id: unknown;
    leader_name: unknown;
    leader_promo_code: unknown;
    submission_count: unknown;
    approved_count: unknown;
    pending_count: unknown;
    latest_submitted_at: unknown;
  }>(
    `select
       p.id as participant_id,
       p.collector_code as participant_code,
       p.real_name,
       p.phone,
       p.status as participant_status,
       p.user_id as app_user_id,
       u.phone as app_user_phone,
       u.role as account_role,
       u.status as account_status,
       l.id as leader_id,
       l.team_name as leader_name,
       l.team_code as leader_promo_code,
       count(s.id) as submission_count,
       count(*) filter (where s.review_status = 'approved') as approved_count,
       count(*) filter (where s.review_status = 'pending') as pending_count,
       max(s.created_at) as latest_submitted_at
     from ${webCollectorsTable} p
     left join ${webUsersTable} u
       on u.id = p.user_id
     left join ${webTeamsTable} l
       on l.id = p.team_id
     left join ${webVideoSubmissionsTable} s
       on s.collector_id = p.id
     group by
       p.id,
       p.collector_code,
       p.real_name,
       p.phone,
       p.status,
       p.user_id,
       u.phone,
       u.role,
       u.status,
       l.id,
       l.team_name,
       l.team_code
     order by latest_submitted_at desc nulls last, p.id desc
     limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    participantId: parseCount(row.participant_id),
    participantCode: String(row.participant_code ?? ""),
    realName: String(row.real_name ?? ""),
    phone: String(row.phone ?? ""),
    participantStatus: String(row.participant_status ?? "active"),
    appUserId: row.app_user_id == null ? null : parseCount(row.app_user_id),
    appUserPhone: parseNullableText(row.app_user_phone),
    accountRole: parseNullableText(row.account_role),
    accountStatus: parseNullableText(row.account_status),
    leaderId: row.leader_id == null ? null : parseCount(row.leader_id),
    leaderName: parseNullableText(row.leader_name),
    leaderPromoCode: parseNullableText(row.leader_promo_code),
    submissionCount: parseCount(row.submission_count),
    approvedCount: parseCount(row.approved_count),
    pendingCount: parseCount(row.pending_count),
    latestSubmittedAt: parseNullableText(row.latest_submitted_at),
  }));
}

export async function getDomesticAdminDashboard(): Promise<DomesticAdminDashboard> {
  const [summary, leaders, recentSubmissions] = await Promise.all([
    getDomesticAdminSummary(),
    getDomesticLeaderSummaries(50),
    getDomesticRecentSubmissions({ limit: 40 }),
  ]);

  return {
    summary,
    leaders,
    recentSubmissions,
  };
}
