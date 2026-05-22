import type { NextRequest, NextResponse } from "next/server";

import {
  type AppUserRole,
  type AppUserRow,
  getCurrentAppUserFromRequest,
  mapAuthSetupError,
} from "@/lib/app-auth";
import { jsonResponse } from "@/lib/http";

type PermissionResult =
  | { ok: true; user: AppUserRow }
  | { ok: false; response: NextResponse };

function roleLabel(role: AppUserRole): string {
  if (role === "admin") {
    return "管理员";
  }
  if (role === "leader") {
    return "团长";
  }
  return "采集员";
}

export async function requireAppUser(
  request: NextRequest,
  allowedRoles?: readonly AppUserRole[],
): Promise<PermissionResult> {
  try {
    const user = await getCurrentAppUserFromRequest(request);
    if (!user) {
      return {
        ok: false,
        response: jsonResponse({ ok: false, error: "unauthenticated", detail: "请先登录。" }, 401),
      };
    }

    if (user.status !== "active") {
      return {
        ok: false,
        response: jsonResponse({ ok: false, error: "user_inactive", detail: "账号当前不可用，请重新登录或联系管理员。" }, 403),
      };
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
      return {
        ok: false,
        response: jsonResponse(
          {
            ok: false,
            error: "forbidden",
            detail: `当前账号是${roleLabel(user.role)}，不能访问这个接口。`,
          },
          403,
        ),
      };
    }

    return { ok: true, user };
  } catch (error) {
    const setupError = mapAuthSetupError(error);
    if (setupError) {
      return { ok: false, response: jsonResponse(setupError, 500) };
    }
    throw error;
  }
}

export function requireAdminAppUser(request: NextRequest): Promise<PermissionResult> {
  return requireAppUser(request, ["admin"]);
}

export function requireLeaderAppUser(request: NextRequest): Promise<PermissionResult> {
  return requireAppUser(request, ["leader"]);
}

export function requireCollectorAppUser(request: NextRequest): Promise<PermissionResult> {
  return requireAppUser(request, ["collector"]);
}
