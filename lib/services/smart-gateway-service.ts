import { Prisma } from "@prisma/client";

import { normalizeDetectedModels } from "@/lib/ai/capability-detector";
import { recommendDefaultModels } from "@/lib/ai/model-matcher";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret, encryptSecret } from "@/lib/utils/crypto";

export type GatewayLoginProvider = "subrouterai" | "sub2api";

export type GatewayLoginProviderConfig = {
  provider: GatewayLoginProvider;
  baseUrl: string;
};

type GatewayLoginOptions = GatewayLoginProviderConfig & {
  username: string;
  password: string;
  timeoutMs?: number;
};

type GatewayLoginResult = GatewayLoginProviderConfig & {
  externalUserId?: string;
  username?: string;
  email?: string;
  displayName?: string;
  sessionCookie?: string;
  accessToken?: string;
  refreshToken?: string;
};

type StoredGatewayAccount = GatewayLoginResult & {
  id?: string;
  userId: string;
  apiKey?: string;
  apiKeyId?: string;
  modelsSnapshot?: unknown;
};

type GatewayModel = {
  id: string;
  label?: string;
  type?: string | null;
  category?: string | null;
  modalities?: string[];
};

const AUTO_KEY_PREFIX = "product-page-auto";
const INTERNAL_GATEWAY_BASE_URL = "http://subrouter.railway.internal:8080";
const DEFAULT_PROVIDER_NAME = "智能网关";

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function apiBase(baseUrl: string) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/, "");
}

function gatewayBase(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function buildCookie(headers: Headers) {
  const cookie = headers.get("set-cookie");
  if (!cookie) return "";
  return cookie
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function bearer(apiKey: string) {
  return `Bearer ${apiKey.replace(/^Bearer\s+/i, "")}`;
}

function extractItems(data: any): any[] {
  const candidates = [data?.data?.items, data?.data?.data, data?.data, data?.items, data];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function extractUser(data: any): Record<string, any> {
  return data?.data?.user || data?.data || data?.user || {};
}

function extractKey(data: any): { key?: string; id?: string } {
  const body = data?.data || data;
  return {
    key: body?.key || body?.api_key || body?.token,
    id: body?.id != null ? String(body.id) : undefined,
  };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    const response = await fetch(`${apiBase(baseUrl)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    const text = await response.text();
    const data = text ? tryParseJson(text) ?? text : null;
    if (!response.ok) {
      throw new Error(extractErrorMessage(data) ?? `请求失败：${response.status}`);
    }
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(data: unknown) {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const record = data as Record<string, any>;
  return record.message ?? record.error?.message ?? record.reason ?? null;
}

function encryptNullable(value?: string | null) {
  return value ? encryptSecret(value) : null;
}

function decryptNullable(value?: string | null) {
  return value ? decryptSecret(value) : undefined;
}

function authHeadersForGateway(account: StoredGatewayAccount): Record<string, string> {
  const headers: Record<string, string> = { Cookie: account.sessionCookie || "" };
  if (account.externalUserId) headers["New-Api-User"] = String(account.externalUserId);
  return headers;
}

async function loginGatewayA(options: GatewayLoginOptions): Promise<GatewayLoginResult> {
  const { response, data } = await requestJson(options.baseUrl, "/api/user/login", {
    method: "POST",
    body: JSON.stringify({
      username: options.username,
      password: options.password,
    }),
    timeoutMs: options.timeoutMs,
  });

  if ((data as any)?.success === false) {
    throw new Error((data as any)?.message || "登录失败");
  }

  const cookie = buildCookie(response.headers);
  if (!cookie) {
    throw new Error("登录成功但未返回会话信息");
  }

  const user = extractUser(data);
  return {
    provider: "subrouterai",
    baseUrl: normalizeBaseUrl(options.baseUrl),
    externalUserId: user.id != null ? String(user.id) : undefined,
    username: user.username || options.username,
    email: user.email,
    displayName: user.display_name || user.displayName || user.username || options.username,
    sessionCookie: cookie,
  };
}

async function loginGatewayB(options: GatewayLoginOptions): Promise<GatewayLoginResult> {
  const { data } = await requestJson(options.baseUrl, "/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: options.username,
      password: options.password,
    }),
    timeoutMs: options.timeoutMs,
  });

  if ((data as any)?.code && (data as any).code !== 0) {
    throw new Error((data as any)?.message || "登录失败");
  }

  const body = (data as any)?.data || {};
  const user = body.user || {};
  const accessToken = body.access_token || body.accessToken;
  if (!accessToken) {
    throw new Error("登录成功但未返回访问令牌");
  }

  return {
    provider: "sub2api",
    baseUrl: normalizeBaseUrl(options.baseUrl),
    externalUserId: user.id != null ? String(user.id) : undefined,
    username: user.username || user.name || options.username,
    email: user.email || options.username,
    displayName: user.display_name || user.displayName || user.name || options.username,
    accessToken,
    refreshToken: body.refresh_token || body.refreshToken,
  };
}

async function authenticateGateway(options: GatewayLoginOptions) {
  return options.provider === "subrouterai"
    ? loginGatewayA(options)
    : loginGatewayB(options);
}

async function listGatewayAKeys(account: StoredGatewayAccount) {
  const { data } = await requestJson(account.baseUrl, "/api/token/", {
    method: "GET",
    headers: authHeadersForGateway(account),
  });
  if ((data as any)?.success === false) {
    throw new Error((data as any)?.message || "获取访问密钥列表失败");
  }
  return extractItems(data);
}

async function ensureGatewayAKey(account: StoredGatewayAccount) {
  const existing = (await listGatewayAKeys(account)).find(
    (item) => String(item.name || "").startsWith(AUTO_KEY_PREFIX) && item.key,
  );
  if (existing?.key) {
    return {
      key: `sk-${String(existing.key).replace(/^sk-/, "")}`,
      id: existing.id != null ? String(existing.id) : undefined,
    };
  }

  const name = `${AUTO_KEY_PREFIX}-${Date.now()}`;
  const { data } = await requestJson(account.baseUrl, "/api/token/", {
    method: "POST",
    headers: authHeadersForGateway(account),
    body: JSON.stringify({
      name,
      group: "subrouter",
      expired_time: -1,
      remain_quota: 0,
      unlimited_quota: true,
      model_limits_enabled: false,
    }),
  });

  if ((data as any)?.success === false) {
    throw new Error((data as any)?.message || "创建访问密钥失败");
  }

  const created = (await listGatewayAKeys(account)).find((item) => item.name === name && item.key);
  if (!created?.key) {
    throw new Error("访问密钥已创建但未能读取");
  }

  return {
    key: `sk-${String(created.key).replace(/^sk-/, "")}`,
    id: created.id != null ? String(created.id) : undefined,
  };
}

async function ensureGatewayBKey(account: StoredGatewayAccount) {
  const auth = { Authorization: bearer(account.accessToken || "") };
  const list = await requestJson(account.baseUrl, "/api/v1/keys", {
    method: "GET",
    headers: auth,
  });
  const existing = extractItems(list.data).find(
    (item) => String(item.name || "").startsWith(AUTO_KEY_PREFIX) && item.key,
  );
  if (existing?.key) {
    return { key: existing.key, id: existing.id != null ? String(existing.id) : undefined };
  }

  const groups = await requestJson(account.baseUrl, "/api/v1/groups/available", {
    method: "GET",
    headers: auth,
  }).catch(() => ({ data: { data: [] } }));
  const group = extractItems(groups.data).find((item) =>
    /subrouter|智能|订阅/i.test(`${item.name || ""} ${item.description || ""}`),
  );

  const body: Record<string, unknown> = { name: `${AUTO_KEY_PREFIX}-${Date.now()}`, quota: 0 };
  if (group?.id != null) body.group_id = Number(group.id);

  const created = await requestJson(account.baseUrl, "/api/v1/keys", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  const key = extractKey(created.data);
  if (!key.key) {
    throw new Error("访问密钥已创建但响应中没有返回密钥");
  }

  return key;
}

async function fetchGatewayModels(baseUrl: string, apiKey: string): Promise<GatewayModel[]> {
  if (!apiKey) return [];
  const response = await fetch(`${gatewayBase(baseUrl)}/models`, {
    headers: {
      Authorization: bearer(apiKey),
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(data) ?? `获取模型列表失败：${response.status}`);
  }

  return extractItems(data)
    .map((item) => ({
      id: String(item.id || item.model || item.name || "").trim(),
      label: item.label || item.name || item.id,
      type: item.type,
      category: item.category || item.type,
      modalities: Array.isArray(item.modalities) ? item.modalities : undefined,
    }))
    .filter((item) => item.id);
}

async function fetchGatewayAModels(account: StoredGatewayAccount): Promise<GatewayModel[]> {
  const subscribed = await requestJson(account.baseUrl, "/api/user/self/subrouter/models", {
    method: "GET",
    headers: authHeadersForGateway(account),
  }).catch((error) => {
    if (error instanceof Error && /404|not found/i.test(error.message)) {
      return { data: { data: [] } };
    }
    throw error;
  });

  const rows = extractItems(subscribed.data);
  if (rows.length > 0) {
    return rows
      .map((row) => ({
        id: String(row.model_name || row.modelName || row.id || row.name || "").trim(),
        label: row.name || row.model_name || row.modelName || row.id,
        type: row.type,
        category: row.category,
      }))
      .filter((item) => item.id);
  }

  return fetchGatewayModels(account.baseUrl, account.apiKey || "");
}

async function fetchGatewayBModels(account: StoredGatewayAccount): Promise<GatewayModel[]> {
  return fetchGatewayModels(account.baseUrl, account.apiKey || "");
}

async function upsertAppUser(login: GatewayLoginResult) {
  const externalProvider = login.provider;
  const externalUserId = login.externalUserId || login.email || login.username;

  if (externalUserId) {
    return prisma.appUser.upsert({
      where: {
        externalProvider_externalUserId: {
          externalProvider,
          externalUserId,
        },
      },
      update: {
        username: login.username ?? null,
        email: login.email ?? null,
        displayName: login.displayName ?? login.username ?? login.email ?? null,
      },
      create: {
        externalProvider,
        externalUserId,
        username: login.username ?? null,
        email: login.email ?? null,
        displayName: login.displayName ?? login.username ?? login.email ?? null,
      },
    });
  }

  return prisma.appUser.create({
    data: {
      externalProvider,
      username: login.username ?? null,
      email: login.email ?? null,
      displayName: login.displayName ?? login.username ?? login.email ?? null,
    },
  });
}

function hydrateStoredAccount(row: Awaited<ReturnType<typeof prisma.gatewayAccount.findFirst>>) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider as GatewayLoginProvider,
    baseUrl: row.baseUrl,
    externalUserId: row.externalUserId ?? undefined,
    username: row.username ?? undefined,
    email: row.email ?? undefined,
    displayName: row.displayName ?? undefined,
    sessionCookie: decryptNullable(row.sessionCookieEncrypted),
    accessToken: decryptNullable(row.accessTokenEncrypted),
    refreshToken: decryptNullable(row.refreshTokenEncrypted),
    apiKey: decryptNullable(row.apiKeyEncrypted),
    apiKeyId: row.apiKeyId ?? undefined,
    modelsSnapshot: row.modelsSnapshot,
  } satisfies StoredGatewayAccount;
}

async function saveGatewayAccount(account: StoredGatewayAccount) {
  return prisma.gatewayAccount.upsert({
    where: {
      userId_provider_baseUrl: {
        userId: account.userId,
        provider: account.provider,
        baseUrl: account.baseUrl,
      },
    },
    update: {
      externalUserId: account.externalUserId ?? null,
      username: account.username ?? null,
      email: account.email ?? null,
      displayName: account.displayName ?? null,
      sessionCookieEncrypted: encryptNullable(account.sessionCookie),
      accessTokenEncrypted: encryptNullable(account.accessToken),
      refreshTokenEncrypted: encryptNullable(account.refreshToken),
      apiKeyEncrypted: encryptNullable(account.apiKey),
      apiKeyId: account.apiKeyId ?? null,
      modelsSnapshot: (account.modelsSnapshot ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
    create: {
      userId: account.userId,
      provider: account.provider,
      baseUrl: account.baseUrl,
      externalUserId: account.externalUserId ?? null,
      username: account.username ?? null,
      email: account.email ?? null,
      displayName: account.displayName ?? null,
      sessionCookieEncrypted: encryptNullable(account.sessionCookie),
      accessTokenEncrypted: encryptNullable(account.accessToken),
      refreshTokenEncrypted: encryptNullable(account.refreshToken),
      apiKeyEncrypted: encryptNullable(account.apiKey),
      apiKeyId: account.apiKeyId ?? null,
      modelsSnapshot: (account.modelsSnapshot ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

function scoreTextModel(modelId: string) {
  const text = modelId.toLowerCase();
  let score = 0;
  const preferences: Array<[RegExp, number]> = [
    [/claude.*sonnet|sonnet.*claude|sonnet/, 120],
    [/gpt-5|gpt-4\.?1|gpt-4o|gpt-4|o3|o4/, 110],
    [/deepseek.*(v3|chat|pro)|deepseek-ai\/deepseek/, 100],
    [/qwen.*(max|plus|72b|32b|coder)|qwen3/, 90],
    [/glm.*(5|4\.5|4-5)|kimi|moonshot/, 80],
    [/doubao.*(seed|pro|1-6|1\.6)/, 70],
    [/haiku|flash|lite|mini|small/, -10],
  ];
  for (const [pattern, weight] of preferences) {
    if (pattern.test(text)) score += weight;
  }
  if (/embedding|embed|rerank|moderation|whisper|speech|tts|audio|video/.test(text)) {
    score -= 1000;
  }
  return score;
}

function chooseDefaults(models: ReturnType<typeof normalizeDetectedModels>) {
  const recommended = recommendDefaultModels(models);
  const textModels = models.filter((model) => model.capabilities.text);
  const preferredText = textModels
    .slice()
    .sort((left, right) => scoreTextModel(right.modelId) - scoreTextModel(left.modelId))[0]?.modelId;
  const imageModels = models.filter((model) => model.capabilities.image_gen);
  const imageEditModels = models.filter((model) => model.capabilities.image_edit || model.capabilities.image_gen);

  return {
    analysisModelId: recommended.analysisModelId ?? preferredText ?? null,
    planningModelId: recommended.planningModelId ?? preferredText ?? null,
    heroImageModelId: recommended.heroImageModelId ?? imageModels[0]?.modelId ?? null,
    detailImageModelId: recommended.detailImageModelId ?? imageModels[0]?.modelId ?? null,
    imageEditModelId: recommended.imageEditModelId ?? imageEditModels[0]?.modelId ?? null,
  };
}

async function upsertUserProviderFromGateway(account: StoredGatewayAccount, models: GatewayModel[]) {
  const normalizedModels = normalizeDetectedModels(models);
  const defaults = chooseDefaults(normalizedModels);

  await prisma.providerConfig.updateMany({
    where: {
      userId: account.userId,
      isActive: true,
    },
    data: {
      isActive: false,
    },
  });

  const existing = await prisma.providerConfig.findFirst({
    where: {
      userId: account.userId,
      name: DEFAULT_PROVIDER_NAME,
      baseUrl: gatewayBase(account.baseUrl),
    },
  });

  const provider = existing
    ? await prisma.providerConfig.update({
        where: { id: existing.id },
        data: {
          apiKeyEncrypted: encryptSecret(account.apiKey || ""),
          isActive: true,
        },
      })
    : await prisma.providerConfig.create({
        data: {
          userId: account.userId,
          name: DEFAULT_PROVIDER_NAME,
          baseUrl: gatewayBase(account.baseUrl),
          apiKeyEncrypted: encryptSecret(account.apiKey || ""),
          isActive: true,
        },
      });

  await prisma.modelProfile.deleteMany({
    where: { providerConfigId: provider.id },
  });

  if (normalizedModels.length > 0) {
    await prisma.modelProfile.createMany({
      data: normalizedModels.map((model) => ({
        providerConfigId: provider.id,
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

  return provider.id;
}

function parseProviderName(value: unknown): GatewayLoginProvider | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "subrouterai" || normalized === "sub2api" ? normalized : null;
}

function normalizeLoginProviders(providers: Array<Partial<GatewayLoginProviderConfig> | null | undefined>) {
  const seen = new Set<string>();
  const result: GatewayLoginProviderConfig[] = [];

  for (const item of providers) {
    const provider = parseProviderName(item?.provider);
    const baseUrl = typeof item?.baseUrl === "string" ? normalizeBaseUrl(item.baseUrl) : "";
    if (!provider || !baseUrl) continue;
    const key = `${provider}:${baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ provider, baseUrl });
  }

  return result;
}

function parseLoginProviderEnv(value?: string) {
  if (!value?.trim()) return [];
  const raw = value.trim();

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeLoginProviders(parsed);
    if (parsed && typeof parsed === "object") return normalizeLoginProviders([parsed]);
  } catch {
    // Also support provider=https://example.com;provider2=https://example.org.
  }

  return normalizeLoginProviders(
    raw.split(/[,\n;]/).flatMap((entry) => {
      const text = entry.trim();
      if (!text) return [];

      const matched = text.match(/^(subrouterai|sub2api)\s*=\s*(.+)$/i);
      if (matched) {
        return [{ provider: matched[1].toLowerCase() as GatewayLoginProvider, baseUrl: matched[2].trim() }];
      }

      if (/^https?:\/\//i.test(text)) {
        return [
          { provider: "subrouterai" as const, baseUrl: text },
          { provider: "sub2api" as const, baseUrl: text },
        ];
      }

      return [];
    }),
  );
}

export function getGatewayLoginProviders() {
  const providers: Array<Partial<GatewayLoginProviderConfig>> = [
    ...parseLoginProviderEnv(process.env.BANANA_MALL_GATEWAY_LOGIN_PROVIDERS),
  ];

  const sharedBaseUrl =
    process.env.BANANA_MALL_GATEWAY_BASE_URL ||
    process.env.TOONFLOW_SUBROUTER_BASE_URL ||
    process.env.SUBROUTER_BASE_URL;

  if (sharedBaseUrl) {
    providers.push(
      { provider: "subrouterai", baseUrl: sharedBaseUrl },
      { provider: "sub2api", baseUrl: sharedBaseUrl },
    );
  }

  providers.push(
    {
      provider: "subrouterai",
      baseUrl:
        process.env.BANANA_MALL_GATEWAY_A_BASE_URL ||
        process.env.TOONFLOW_SUBROUTERAI_BASE_URL ||
        process.env.SUBROUTERAI_BASE_URL,
    },
    {
      provider: "sub2api",
      baseUrl:
        process.env.BANANA_MALL_GATEWAY_B_BASE_URL ||
        process.env.TOONFLOW_SUB2API_BASE_URL ||
        process.env.SUB2API_BASE_URL,
    },
  );

  const normalized = normalizeLoginProviders(providers);
  if (normalized.length > 0) return normalized;

  return normalizeLoginProviders([
    { provider: "subrouterai", baseUrl: INTERNAL_GATEWAY_BASE_URL },
    { provider: "sub2api", baseUrl: INTERNAL_GATEWAY_BASE_URL },
  ]);
}

export async function loginWithGatewayProviders(username: string, password: string) {
  const providers = getGatewayLoginProviders();
  let lastError: unknown;

  for (const provider of providers) {
    try {
      const login = await authenticateGateway({
        ...provider,
        username,
        password,
        timeoutMs: 10000,
      });
      const user = await upsertAppUser(login);
      const account: StoredGatewayAccount = {
        ...login,
        userId: user.id,
      };
      const key = account.provider === "subrouterai"
        ? await ensureGatewayAKey(account)
        : await ensureGatewayBKey(account);
      account.apiKey = key.key;
      account.apiKeyId = key.id;

      const models = account.provider === "subrouterai"
        ? await fetchGatewayAModels(account)
        : await fetchGatewayBModels(account);
      account.modelsSnapshot = models;
      await saveGatewayAccount(account);
      const providerConfigId = await upsertUserProviderFromGateway(account, models);

      return {
        user,
        account: {
          provider: account.provider,
          baseUrl: account.baseUrl,
          username: account.username,
          email: account.email,
          displayName: account.displayName,
          apiKeyReady: Boolean(account.apiKey),
        },
        models,
        providerConfigId,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("账号或密码错误");
}

export async function getLatestGatewayAccount(userId: string) {
  const row = await prisma.gatewayAccount.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return hydrateStoredAccount(row);
}

export async function refreshGatewayModelsForUser(userId: string) {
  const account = await getLatestGatewayAccount(userId);
  if (!account?.apiKey) {
    throw new Error("当前账号尚未连接智能网关");
  }

  const models = account.provider === "subrouterai"
    ? await fetchGatewayAModels(account)
    : await fetchGatewayBModels(account);
  account.modelsSnapshot = models;
  await saveGatewayAccount(account);
  await upsertUserProviderFromGateway(account, models);
  return models;
}
