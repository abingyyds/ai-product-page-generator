import { NextRequest } from "next/server";

import { requireCurrentUser } from "@/lib/auth/session";
import { getLatestGatewayAccount, refreshGatewayModelsForUser } from "@/lib/services/smart-gateway-service";
import { handleRouteError, ok } from "@/lib/utils/route";

export async function GET(request: NextRequest) {
  try {
    const user = await requireCurrentUser(request);
    const account = await getLatestGatewayAccount(user.id);
    return ok({
      connected: Boolean(account?.apiKey),
      account: account
        ? {
            username: account.username,
            email: account.email,
            displayName: account.displayName,
            apiKeyReady: Boolean(account.apiKey),
          }
        : null,
      models: Array.isArray(account?.modelsSnapshot) ? account.modelsSnapshot : [],
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCurrentUser(request);
    const models = await refreshGatewayModelsForUser(user.id);
    return ok({ models });
  } catch (error) {
    return handleRouteError(error);
  }
}
