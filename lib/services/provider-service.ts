import { prisma } from "@/lib/db/prisma";
import { OpenAICompatibleAdapter } from "@/lib/ai/adapters/openai-compatible";
import { normalizeDetectedModels } from "@/lib/ai/capability-detector";
import { recommendDefaultModels } from "@/lib/ai/model-matcher";
import { requireCurrentUser } from "@/lib/auth/session";
import { ensureGatewayProviderForUser } from "@/lib/services/smart-gateway-service";
import { decryptSecret, encryptSecret } from "@/lib/utils/crypto";
import type {
  CapabilityMap,
  ModelDetectionResult,
  ModelRoleMap,
  ProviderConnectionInput,
} from "@/types/domain";

type RuntimeProviderModel = {
  id: string;
  providerConfigId: string;
  modelId: string;
  label: string;
  capabilities: Record<string, unknown>;
  roles: Record<string, unknown>;
  quality: string | null;
  latency: string | null;
  cost: string | null;
  isAvailable: boolean;
  isDefaultAnalysis: boolean;
  isDefaultPlanning: boolean;
  isDefaultHeroImage: boolean;
  isDefaultDetailImage: boolean;
  isDefaultImageEdit: boolean;
  createdAt: Date;
  updatedAt: Date;
  endpointSupport: {
    imageGeneration: string;
    imageEdit: string;
    note: string | null;
  };
};

type ProviderAdapterContext = {
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    apiKeyEncrypted: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    models: RuntimeProviderModel[];
  };
  apiKey: string;
  adapter: OpenAICompatibleAdapter;
};

type ProviderModelSnapshot = {
  modelId: string;
  label: string;
  capabilities: Record<string, unknown>;
  roles: Record<string, unknown>;
  quality?: string | null;
  latency?: string | null;
  cost?: string | null;
  isAvailable: boolean;
  endpointSupport?: {
    imageGeneration: string;
    imageEdit: string;
    note?: string | null;
  };
};

type DiscoveredProviderModel = {
  id: string;
  label?: string;
  type?: string | null;
  category?: string | null;
  modalities?: string[];
};

const OPENAI_IMAGE_MODEL_PRESETS: DiscoveredProviderModel[] = [
  { id: "gpt-image-2-2026-04-21", label: "gpt-image-2-2026-04-21", type: "image", category: "image" },
  { id: "gpt-image-2", label: "gpt-image-2", type: "image", category: "image" },
  { id: "gpt-image-1.5", label: "gpt-image-1.5", type: "image", category: "image" },
  { id: "gpt-image-1.5-2025-12-16", label: "gpt-image-1.5-2025-12-16", type: "image", category: "image" },
  { id: "gpt-image-1-mini", label: "gpt-image-1-mini", type: "image", category: "image" },
  { id: "gpt-image-1", label: "gpt-image-1", type: "image", category: "image" },
  { id: "dall-e-3", label: "dall-e-3", type: "image", category: "image" },
  { id: "dall-e-2", label: "dall-e-2", type: "image", category: "image" },
];

function maskApiKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 6)}***${trimmed.slice(-4)}`;
}

function isManagedGatewayProvider(provider: { name?: string | null }) {
  return provider.name === "智能网关" || String(provider.name ?? "").startsWith("智能网关 / ");
}

function serializeProviderForClient<T extends { name: string; baseUrl: string; apiKey: string; maskedApiKey: string }>(
  provider: T,
) {
  if (!isManagedGatewayProvider(provider)) {
    return provider;
  }

  return {
    ...provider,
    baseUrl: "自动配置",
    apiKey: "",
    maskedApiKey: "自动托管",
  };
}

function readEndpointSupport(capabilities: Record<string, unknown> | null | undefined) {
  return {
    imageGeneration: (capabilities?.__imageGenerationStatus as string | undefined) ?? "unknown",
    imageEdit: (capabilities?.__imageEditStatus as string | undefined) ?? "unknown",
    note: (capabilities?.__probeNote as string | undefined) ?? null,
  };
}

function hydrateProviderModels<T extends { capabilities: any }>(models: T[]) {
  return models.map((model) => ({
    ...model,
    endpointSupport: readEndpointSupport(model.capabilities as Record<string, unknown> | undefined),
  }));
}

function shouldIncludeOpenAiImagePresets(baseUrl: string, models: Array<{ modelId?: string; id?: string }>) {
  const text = `${baseUrl} ${models.map((model) => model.modelId ?? model.id ?? "").join(" ")}`.toLowerCase();
  return /openai|chatgpt|gpt-|(^|[^a-z])o[1345](?:[^a-z]|$)|dall[-_\s]?e/.test(text);
}

function mergeDiscoveredModels(baseUrl: string, models: DiscoveredProviderModel[]) {
  if (!shouldIncludeOpenAiImagePresets(baseUrl, models)) {
    return models;
  }

  const seen = new Set(models.map((model) => model.id.toLowerCase()));
  const missingPresets = OPENAI_IMAGE_MODEL_PRESETS.filter((model) => !seen.has(model.id.toLowerCase()));
  return [...models, ...missingPresets];
}

function mergeHydratedProviderModels<T extends RuntimeProviderModel>(
  providerId: string,
  baseUrl: string,
  models: T[],
) {
  if (!shouldIncludeOpenAiImagePresets(baseUrl, models)) {
    return models;
  }

  const seen = new Set(models.map((model) => model.modelId.toLowerCase()));
  const missingPresets = OPENAI_IMAGE_MODEL_PRESETS.filter((model) => !seen.has(model.id.toLowerCase()));
  if (missingPresets.length === 0) {
    return models;
  }

  const now = new Date();
  const supplemental = enrichModelEndpointSupport(normalizeDetectedModels(missingPresets)).map((model) => ({
    id: `${providerId}:preset:${model.modelId}`,
    providerConfigId: providerId,
    modelId: model.modelId,
    label: model.label,
    capabilities: model.capabilities as Record<string, unknown>,
    roles: model.roles as Record<string, unknown>,
    quality: model.quality ?? null,
    latency: model.latency ?? null,
    cost: model.cost ?? null,
    isAvailable: model.isAvailable,
    isDefaultAnalysis: false,
    isDefaultPlanning: false,
    isDefaultHeroImage: false,
    isDefaultDetailImage: false,
    isDefaultImageEdit: false,
    createdAt: now,
    updatedAt: now,
    endpointSupport: model.endpointSupport ?? {
      imageGeneration: "unknown",
      imageEdit: "unknown",
      note: PASSIVE_IMAGE_CAPABILITY_NOTE,
    },
  })) as T[];

  return [...models, ...supplemental];
}

const PASSIVE_IMAGE_CAPABILITY_NOTE =
  "未发起真实图像接口调用；仅根据 /models 返回和模型名称识别能力，实际可用性会在生成时验证。";

function enrichModelEndpointSupport(models: ProviderModelSnapshot[]) {
  return models.map((model) => {
    const capabilities = { ...(model.capabilities as Record<string, unknown>) };
    delete capabilities.real_image_gen;
    delete capabilities.real_image_edit;

    const hasImageGeneration = Boolean(capabilities.image_gen);
    const hasImageEdit = Boolean(capabilities.image_edit);
    const endpointSupport = {
      imageGeneration: hasImageGeneration ? ("unknown" as const) : ("not_applicable" as const),
      imageEdit: hasImageEdit ? ("unknown" as const) : ("not_applicable" as const),
      note: hasImageGeneration || hasImageEdit ? PASSIVE_IMAGE_CAPABILITY_NOTE : null,
    };

    capabilities.__imageGenerationStatus = endpointSupport.imageGeneration;
    capabilities.__imageEditStatus = endpointSupport.imageEdit;
    capabilities.__probeNote = endpointSupport.note;

    return {
      ...model,
      capabilities: capabilities as CapabilityMap,
      roles: { ...model.roles } as ModelRoleMap,
      endpointSupport,
    };
  }) satisfies ModelDetectionResult[];
}

async function replaceProviderModels(
  providerConfigId: string,
  models: Awaited<ReturnType<typeof discoverProviderModels>>["models"],
  defaults: {
    analysisModelId?: string | null;
    planningModelId?: string | null;
    heroImageModelId?: string | null;
    detailImageModelId?: string | null;
    imageEditModelId?: string | null;
  },
) {
  await prisma.modelProfile.deleteMany({
    where: { providerConfigId },
  });

  await prisma.modelProfile.createMany({
    data: models.map((model) => ({
      providerConfigId,
      modelId: model.modelId,
      label: model.label,
      capabilities: model.capabilities,
      roles: model.roles,
      quality: model.quality,
      latency: model.latency,
      cost: model.cost,
      isAvailable: model.isAvailable,
      isDefaultAnalysis: defaults.analysisModelId === model.modelId,
      isDefaultPlanning: defaults.planningModelId === model.modelId,
      isDefaultHeroImage: defaults.heroImageModelId === model.modelId,
      isDefaultDetailImage: defaults.detailImageModelId === model.modelId,
      isDefaultImageEdit: defaults.imageEditModelId === model.modelId,
    })),
  });
}

export async function testProviderConnection(input: ProviderConnectionInput) {
  const adapter = new OpenAICompatibleAdapter(input.baseUrl, input.apiKey);
  return adapter.testConnection();
}

export async function resolveProviderConnectionInput(
  input: Omit<ProviderConnectionInput, "apiKey"> & { apiKey?: string | null; id?: string | null },
): Promise<ProviderConnectionInput> {
  const user = await requireCurrentUser();
  const trimmedKey = input.apiKey?.trim() ?? "";
  if (trimmedKey.length >= 6) {
    return {
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: trimmedKey,
    };
  }

  const matchedProvider =
    (input.id
      ? await prisma.providerConfig.findUnique({
          where: { id: input.id, userId: user.id },
        })
      : await prisma.providerConfig.findFirst({
          where: {
            userId: user.id,
            OR: [{ baseUrl: input.baseUrl }, { isActive: true }],
          },
          orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
        })) ?? null;

  if (!matchedProvider) {
    throw new Error("当前没有可复用的已保存 API Key，请重新输入 API Key 后再试。");
  }

  return {
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: decryptSecret(matchedProvider.apiKeyEncrypted),
  };
}

export async function discoverProviderModels(input: ProviderConnectionInput) {
  const adapter = new OpenAICompatibleAdapter(input.baseUrl, input.apiKey);
  const models = await adapter.listModels();
  const normalized = enrichModelEndpointSupport(normalizeDetectedModels(mergeDiscoveredModels(input.baseUrl, models)));
  return {
    models: normalized,
    recommendations: recommendDefaultModels(normalized),
  };
}

export async function saveProviderConfig(
  input: ProviderConnectionInput & {
    id?: string | null;
    isActive?: boolean;
    discoveredModels?: ProviderModelSnapshot[];
    defaultAssignments?: {
      analysisModelId?: string | null;
      planningModelId?: string | null;
      heroImageModelId?: string | null;
      detailImageModelId?: string | null;
      imageEditModelId?: string | null;
    };
  },
) {
  const user = await requireCurrentUser();
  const discoveredModels = input.discoveredModels?.length
    ? enrichModelEndpointSupport(input.discoveredModels)
    : (await discoverProviderModels(input)).models;
  const discovered = {
    models: discoveredModels,
    recommendations: recommendDefaultModels(discoveredModels),
  };
  const nextIsActive = input.isActive ?? true;

  if (nextIsActive) {
    await prisma.providerConfig.updateMany({
      where: { userId: user.id },
      data: { isActive: false },
    });
  }

  const provider = input.id
    ? await prisma.providerConfig.update({
        where: { id: input.id, userId: user.id },
        data: {
          name: input.name,
          baseUrl: input.baseUrl,
          apiKeyEncrypted: encryptSecret(input.apiKey),
          isActive: nextIsActive,
        },
      })
    : await prisma.providerConfig.create({
        data: {
          userId: user.id,
          name: input.name,
          baseUrl: input.baseUrl,
          apiKeyEncrypted: encryptSecret(input.apiKey),
          isActive: nextIsActive,
        },
      });

  const defaults = {
    ...discovered.recommendations,
    ...(input.defaultAssignments ?? {}),
  };

  await replaceProviderModels(provider.id, discovered.models, defaults);
  return provider.id;
}

export async function getAllProviderConfigs() {
  const user = await requireCurrentUser();
  let providers = await prisma.providerConfig.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      models: {
        orderBy: { modelId: "asc" },
      },
    },
  });

  if (providers.length === 0) {
    await ensureGatewayProviderForUser(user.id);
    providers = await prisma.providerConfig.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      include: {
        models: {
          orderBy: { modelId: "asc" },
        },
      },
    });
  }

  return providers.map((provider) => {
    const apiKey = decryptSecret(provider.apiKeyEncrypted);
    return serializeProviderForClient({
      ...provider,
      apiKey,
      maskedApiKey: maskApiKey(apiKey),
      models: mergeHydratedProviderModels(
        provider.id,
        provider.baseUrl,
        hydrateProviderModels(provider.models) as RuntimeProviderModel[],
      ),
    });
  });
}

export async function getActiveProviderConfig() {
  const user = await requireCurrentUser();
  let provider = await prisma.providerConfig.findFirst({
    where: { userId: user.id, isActive: true },
    include: {
      models: {
        orderBy: { modelId: "asc" },
      },
    },
  });

  if (!provider) {
    await ensureGatewayProviderForUser(user.id);
    provider = await prisma.providerConfig.findFirst({
      where: { userId: user.id, isActive: true },
      include: {
        models: {
          orderBy: { modelId: "asc" },
        },
      },
    });
  }

  if (!provider) return null;

  const apiKey = decryptSecret(provider.apiKeyEncrypted);
  return serializeProviderForClient({
    ...provider,
    apiKey,
    maskedApiKey: maskApiKey(apiKey),
    models: mergeHydratedProviderModels(
      provider.id,
      provider.baseUrl,
      hydrateProviderModels(provider.models) as RuntimeProviderModel[],
    ),
  });
}

export async function activateProviderConfig(providerId: string) {
  const user = await requireCurrentUser();
  const provider = await prisma.providerConfig.findUnique({
    where: { id: providerId, userId: user.id },
  });

  if (!provider) {
    throw new Error("未找到要切换的历史服务配置。");
  }

  await prisma.$transaction([
    prisma.providerConfig.updateMany({
      where: { userId: user.id },
      data: { isActive: false },
    }),
    prisma.providerConfig.update({
      where: { id: providerId, userId: user.id },
      data: { isActive: true },
    }),
  ]);

  return getAllProviderConfigs();
}

export async function updateProviderDefaultModels(
  providerId: string,
  defaults: {
    analysisModelId?: string | null;
    planningModelId?: string | null;
    heroImageModelId?: string | null;
    detailImageModelId?: string | null;
    imageEditModelId?: string | null;
  },
) {
  const user = await requireCurrentUser();
  const provider = await prisma.providerConfig.findUnique({
    where: { id: providerId, userId: user.id },
    select: { id: true },
  });

  if (!provider) {
    throw new Error("未找到要保存的模型服务配置。");
  }

  await prisma.providerConfig.updateMany({
    where: {
      userId: user.id,
      id: { not: providerId },
    },
    data: { isActive: false },
  });

  await prisma.modelProfile.updateMany({
    where: { providerConfigId: providerId },
    data: {
      isDefaultAnalysis: false,
      isDefaultPlanning: false,
      isDefaultHeroImage: false,
      isDefaultDetailImage: false,
      isDefaultImageEdit: false,
    },
  });

  const updates = [
    ["isDefaultAnalysis", defaults.analysisModelId],
    ["isDefaultPlanning", defaults.planningModelId],
    ["isDefaultHeroImage", defaults.heroImageModelId],
    ["isDefaultDetailImage", defaults.detailImageModelId],
    ["isDefaultImageEdit", defaults.imageEditModelId],
  ] as const;

  for (const [field, modelId] of updates) {
    if (!modelId) continue;
    await prisma.modelProfile.updateMany({
      where: { providerConfigId: providerId, modelId },
      data: { [field]: true },
    });
  }

  await prisma.providerConfig.update({
    where: { id: providerId, userId: user.id },
    data: {
      isActive: true,
      updatedAt: new Date(),
    },
  });

  return getAllProviderConfigs();
}

export async function getProviderAdapter(providerId?: string): Promise<ProviderAdapterContext> {
  const user = await requireCurrentUser();
  let provider =
    (providerId
      ? await prisma.providerConfig.findUnique({
          where: { id: providerId, userId: user.id },
          include: { models: true },
        })
      : await prisma.providerConfig.findFirst({
          where: { userId: user.id, isActive: true },
          include: { models: true },
        })) ?? null;

  if (!provider && !providerId) {
    await ensureGatewayProviderForUser(user.id);
    provider = await prisma.providerConfig.findFirst({
      where: { userId: user.id, isActive: true },
      include: { models: true },
    });
  }

  if (!provider) {
    throw new Error("No active provider config found.");
  }

  const apiKey = decryptSecret(provider.apiKeyEncrypted);
  const runtimeModels = hydrateProviderModels(provider.models) as unknown as RuntimeProviderModel[];

  return {
    provider: {
      ...provider,
      models: runtimeModels,
    },
    apiKey,
    adapter: new OpenAICompatibleAdapter(provider.baseUrl, apiKey),
  };
}
