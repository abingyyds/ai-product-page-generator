import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return fail("AUTH_REQUIRED", "请先登录。", null, 401);
    }
    return ok({ user });
  } catch (error) {
    return handleRouteError(error);
  }
}
