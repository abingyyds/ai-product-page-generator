import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/utils/env";
import {
  createSessionToken as createSignedSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type SessionUser,
  verifySessionToken as verifySignedSessionToken,
} from "@/lib/auth/token";

export { SESSION_COOKIE_NAME };
export type { SessionUser };

export async function createSessionToken(user: SessionUser) {
  return createSignedSessionToken(user, env.APP_SECRET);
}

export async function verifySessionToken(token?: string | null): Promise<SessionUser | null> {
  return verifySignedSessionToken(token, env.APP_SECRET);
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function readSessionFromRequest(request?: NextRequest): Promise<SessionUser | null> {
  const token = request
    ? request.cookies.get(SESSION_COOKIE_NAME)?.value
    : cookies().get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

export async function getCurrentUser(request?: NextRequest): Promise<SessionUser | null> {
  const session = await readSessionFromRequest(request);
  if (!session) return null;

  const user = await prisma.appUser.findUnique({
    where: { id: session.id },
    select: { id: true, displayName: true, username: true, email: true },
  });

  if (!user) return null;

  return {
    id: user.id,
    name: user.displayName ?? user.username ?? user.email ?? session.name ?? null,
    username: user.username,
    email: user.email,
  };
}

export async function requireCurrentUser(request?: NextRequest): Promise<SessionUser> {
  const user = await getCurrentUser(request);
  if (!user) {
    throw new Error("AUTH_REQUIRED");
  }
  return user;
}
