import { z } from "zod";
import { NextRequest } from "next/server";

import {
  activateProviderConfig,
  getAllProviderConfigs,
  resolveProviderConnectionInput,
  saveProviderConfig,
} from "@/lib/services/provider-service";
import { requireAppAdmin } from "@/lib/auth/admin";
import { providerSaveSchema } from "@/lib/validations/provider";
import { handleRouteError, ok } from "@/lib/utils/route";

const providerActivateSchema = z.object({
  providerId: z.string().min(1, "请选择要切换的历史服务"),
});

export async function GET() {
  try {
    await requireAppAdmin();
    const providers = await getAllProviderConfigs();
    return ok(providers);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin(request);
    const parsed = providerSaveSchema.parse(await request.json());
    const resolved = await resolveProviderConnectionInput(parsed);
    const savedProviderId = await saveProviderConfig({
      ...parsed,
      apiKey: resolved.apiKey,
    });
    const providers = await getAllProviderConfigs();
    return ok({
      savedProviderId,
      providers,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireAppAdmin(request);
    const parsed = providerActivateSchema.parse(await request.json());
    const providers = await activateProviderConfig(parsed.providerId);
    return ok(providers);
  } catch (error) {
    return handleRouteError(error);
  }
}
