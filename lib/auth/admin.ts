import { NextRequest } from "next/server";

import { getCurrentUser, requireCurrentUser, type SessionUser } from "@/lib/auth/session";
import { fail } from "@/lib/utils/route";

function parseList(value?: string | null) {
  return new Set(
    String(value || "")
      .split(/[,\n;]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function configuredAdmins() {
  return {
    ids: parseList(process.env.BANANA_MALL_ADMIN_USER_IDS),
    names: parseList(process.env.BANANA_MALL_ADMIN_USERS || process.env.APP_ADMIN_USERS),
    emails: parseList(process.env.BANANA_MALL_ADMIN_EMAILS || process.env.APP_ADMIN_EMAILS),
  };
}

export function isAppAdmin(user: SessionUser | null | undefined) {
  if (!user) return false;
  const admins = configuredAdmins();
  const hasExplicitAdmin =
    admins.ids.size > 0 ||
    admins.names.size > 0 ||
    admins.emails.size > 0;

  if (!hasExplicitAdmin) {
    return false;
  }

  const name = String(user.name || "").trim().toLowerCase();
  const username = String(user.username || "").trim().toLowerCase();
  const email = String(user.email || "").trim().toLowerCase();
  return (
    admins.ids.has(user.id.toLowerCase()) ||
    (name ? admins.names.has(name) || admins.emails.has(name) : false) ||
    (username ? admins.names.has(username) : false) ||
    (email ? admins.emails.has(email) : false)
  );
}

export async function getCurrentAdmin() {
  const user = await getCurrentUser();
  return isAppAdmin(user) ? user : null;
}

export async function requireAppAdmin(request?: NextRequest) {
  const user = await requireCurrentUser(request);
  if (!isAppAdmin(user)) {
    throw new Error("APP_ADMIN_REQUIRED");
  }
  return user;
}

export function adminForbiddenResponse() {
  return fail("APP_ADMIN_REQUIRED", "当前账号没有管理权限。", null, 403);
}
