import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  createSessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { loginWithGatewayProviders } from "@/lib/services/smart-gateway-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const loginSchema = z.object({
  username: z.string().trim().min(1, "请输入账号"),
  password: z.string().min(1, "请输入密码"),
});

export async function POST(request: NextRequest) {
  try {
    const input = loginSchema.parse(await request.json());
    const result = await loginWithGatewayProviders(input.username, input.password);
    const token = await createSessionToken({
      id: result.user.id,
      name: result.user.displayName ?? result.user.username ?? result.user.email,
    });

    const response = ok({
      user: {
        id: result.user.id,
        name: result.user.displayName ?? result.user.username ?? result.user.email,
        username: result.user.username,
        email: result.user.email,
      },
      account: {
        connected: true,
        displayName: result.account.displayName ?? result.account.username ?? result.account.email ?? null,
        apiKeyReady: result.account.apiKeyReady,
      },
      modelCount: result.models.length,
      providerConfigId: result.providerConfigId,
    });

    response.cookies.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
