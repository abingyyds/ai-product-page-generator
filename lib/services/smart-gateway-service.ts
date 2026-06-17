import { Prisma } from "@prisma/client";

import { normalizeDetectedModels } from "@/lib/ai/capability-detector";
import { recommendDefaultModels } from "@/lib/ai/model-matcher";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret, encryptSecret } from "@/lib/utils/crypto";

export type GatewayLoginProvider = "subrouterai" | "subrouterai_dist" | "sub2api";

export type GatewayLoginProviderConfig = {
  provider: GatewayLoginProvider;
  baseUrl: string;
  distHost?: string;
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

type GatewayDistributorInfo = {
  belongsToDistributor: boolean;
  distributorId?: string;
  distributorSlug?: string;
  distributorName?: string;
  distributorHost?: string;
  status?: number;
};

const AUTO_KEY_PREFIX = "product-page-auto";
const INTERNAL_GATEWAY_BASE_URL = "http://subrouter.railway.internal:8080";
const DEFAULT_PROVIDER_NAME = "智能网关";

function normalizeBaseUrl(baseUrl: string) {
  let text = baseUrl.trim().replace(/：/g, ":").replace(/\/+$/, "");
  if (!text) return "";
  if (/^https?:[^/]/i.test(text)) {
    text = text.replace(/^(https?):/i, "$1://");
  }
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
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

function normalizeHost(value?: string | null) {
  const text = String(value || "")
    .trim()
    .replace(/：/g, ":");
  if (!text) return "";

  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).host.toLowerCase();
  } catch {
    return text
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase();
  }
}

function gatewayIdentityScope(login: Pick<GatewayLoginResult, "provider" | "baseUrl" | "distHost">) {
  return [
    login.provider,
    normalizeBaseUrl(login.baseUrl),
    normalizeHost(login.distHost) || "main",
  ].join("|");
}

function scopedExternalUserId(login: GatewayLoginResult, externalUserId: string) {
  return `${gatewayIdentityScope(login)}|${externalUserId}`;
}

function gatewayProviderName(account: Pick<StoredGatewayAccount, "distHost">) {
  return account.distHost ? `${DEFAULT_PROVIDER_NAME} / ${account.distHost}` : DEFAULT_PROVIDER_NAME;
}

function distContextHeaders(config: { distHost?: string | null }): Record<string, string> {
  const host = normalizeHost(config.distHost);
  if (!host) return {};
  return {
    "X-Original-Host": host,
    "X-Forwarded-Host": host,
  };
}

function extractItems(data: any): any[] {
  const candidates = [
    data?.data?.items,
    data?.data?.models,
    data?.data?.list,
    data?.data?.rows,
    data?.data?.data,
    data?.data,
    data?.items,
    data?.models,
    data?.list,
    data?.rows,
    data,
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function extractUser(data: any): Record<string, any> {
  return data?.data?.user || data?.data || data?.user || {};
}

function extractDistributorInfo(data: any): GatewayDistributorInfo | null {
  const body = data?.data || data;
  if (!body || typeof body !== "object") return null;
  const distributor =
    body.distributor && typeof body.distributor === "object"
      ? body.distributor
      : body.site && typeof body.site === "object"
        ? body.site
        : {};
  const distributorId = body.distributor_id ?? body.distributorId ?? distributor.id ?? distributor.distributor_id;
  const distributorHost = normalizeHost(
    body.site_host ||
      body.siteHost ||
      body.api_host ||
      body.apiHost ||
      body.host ||
      distributor.site_host ||
      distributor.siteHost ||
      distributor.api_host ||
      distributor.apiHost ||
      distributor.host ||
      distributor.domain,
  );
  const belongs =
    body.belongs_to_distributor ?? body.belongsToDistributor ?? body.belongs ?? Number(distributorId || 0) > 0;

  return {
    belongsToDistributor: Boolean(belongs),
    distributorId: distributorId != null ? String(distributorId) : undefined,
    distributorSlug: distributor.slug || body.distributor_slug ? String(distributor.slug || body.distributor_slug) : undefined,
    distributorName: distributor.name || body.distributor_name ? String(distributor.name || body.distributor_name) : undefined,
    distributorHost: distributorHost || undefined,
    status: distributor.status != null ? Number(distributor.status) : undefined,
  };
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
  options: RequestInit & { timeoutMs?: number; distHost?: string | null } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    const response = await fetch(`${apiBase(baseUrl)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...distContextHeaders(options as { distHost?: string | null }),
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
  const headers: Record<string, string> = {
    Cookie: account.sessionCookie || "",
    ...distContextHeaders(account),
  };
  if (account.externalUserId) headers["New-Api-User"] = String(account.externalUserId);
  return headers;
}

function authHeadersForGatewaySession(account: StoredGatewayAccount): Record<string, string> {
  const headers: Record<string, string> = { Cookie: account.sessionCookie || "" };
  if (account.externalUserId) headers["New-Api-User"] = String(account.externalUserId);
  return headers;
}

async function fetchGatewayDistributorInfo(login: GatewayLoginResult) {
  if (!login.sessionCookie) return null;
  const { data } = await requestJson(login.baseUrl, "/api/user/self/distributor", {
    method: "GET",
    headers: authHeadersForGateway({ ...login, userId: "" }),
  }).catch(() => ({ data: null }));
  return extractDistributorInfo(data);
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

async function loginGatewayDist(options: GatewayLoginOptions): Promise<GatewayLoginResult> {
  const { response, data } = await requestJson(options.baseUrl, "/api/dist/user/login", {
    method: "POST",
    distHost: options.distHost,
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
    provider: "subrouterai_dist",
    baseUrl: normalizeBaseUrl(options.baseUrl),
    distHost: normalizeHost(options.distHost || options.baseUrl) || undefined,
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
  if (options.provider === "subrouterai") {
    return loginGatewayA(options);
  }
  if (options.provider === "subrouterai_dist") {
    return loginGatewayDist(options);
  }
  return loginGatewayB(options);
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

async function listGatewayDistKeys(account: StoredGatewayAccount) {
  const { data } = await requestJson(account.baseUrl, "/api/dist/token/list", {
    method: "GET",
    headers: authHeadersForGateway(account),
  });
  if ((data as any)?.success === false) {
    throw new Error((data as any)?.message || "获取访问密钥列表失败");
  }
  return extractItems(data);
}

async function listGatewaySelfDistKeys(account: StoredGatewayAccount) {
  const { data } = await requestJson(account.baseUrl, "/api/user/self/distributor/token/list", {
    method: "GET",
    headers: authHeadersForGatewaySession(account),
  });
  if ((data as any)?.success === false) {
    throw new Error((data as any)?.message || "获取访问密钥列表失败");
  }
  return extractItems(data);
}

async function ensureGatewayDistKey(account: StoredGatewayAccount) {
  let useSelfDistTokenEndpoint = true;
  let keys = await listGatewaySelfDistKeys(account).catch(() => {
    useSelfDistTokenEndpoint = false;
    return listGatewayDistKeys(account);
  });

  const existing = keys.find((item) => String(item.name || "").startsWith(AUTO_KEY_PREFIX) && item.key);
  if (existing?.key) {
    return {
      key: `sk-${String(existing.key).replace(/^sk-/, "")}`,
      id: existing.id != null ? String(existing.id) : undefined,
    };
  }

  const name = `${AUTO_KEY_PREFIX}-${Date.now()}`;
  const { data } = await requestJson(
    account.baseUrl,
    useSelfDistTokenEndpoint ? "/api/user/self/distributor/token/create" : "/api/dist/token/create",
    {
      method: "POST",
      headers: useSelfDistTokenEndpoint ? authHeadersForGatewaySession(account) : authHeadersForGateway(account),
      body: JSON.stringify({
        name,
        key_group_id: 0,
      }),
    },
  );

  if ((data as any)?.success === false) {
    throw new Error((data as any)?.message || "创建访问密钥失败");
  }

  const key = extractKey(data);
  if (!key.key) {
    keys = useSelfDistTokenEndpoint ? await listGatewaySelfDistKeys(account) : await listGatewayDistKeys(account);
    const created = keys.find((item) => item.name === name && item.key);
    if (created?.key) {
      return {
        key: `sk-${String(created.key).replace(/^sk-/, "")}`,
        id: created.id != null ? String(created.id) : undefined,
      };
    }
    throw new Error("访问密钥已创建但未能读取");
  }

  return {
    key: `sk-${String(key.key).replace(/^sk-/, "")}`,
    id: key.id,
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
      id: String(typeof item === "string" ? item : item.id || item.model || item.name || "").trim(),
      label: typeof item === "string" ? item : item.label || item.name || item.id,
      type: typeof item === "string" ? undefined : item.type,
      category: typeof item === "string" ? undefined : item.category || item.type,
      modalities: typeof item !== "string" && Array.isArray(item.modalities) ? item.modalities : undefined,
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
        id: String(typeof row === "string" ? row : row.model_name || row.modelName || row.id || row.name || "").trim(),
        label: typeof row === "string" ? row : row.name || row.model_name || row.modelName || row.id,
        type: typeof row === "string" ? undefined : row.type,
        category: typeof row === "string" ? undefined : row.category,
      }))
      .filter((item) => item.id);
  }

  return fetchGatewayModels(account.baseUrl, account.apiKey || "");
}

async function fetchGatewayDistModels(account: StoredGatewayAccount): Promise<GatewayModel[]> {
  const listed = await requestJson(account.baseUrl, "/api/dist/site/models", {
    method: "GET",
    distHost: account.distHost,
  }).catch(() => ({ data: { data: [] } }));
  const rows = extractItems(listed.data);
  if (rows.length > 0) {
    return rows
      .map((row) => ({
        id: String(typeof row === "string" ? row : row.model_name || row.modelName || row.id || row.name || "").trim(),
        label: typeof row === "string" ? row : row.display_name || row.name || row.model_name || row.modelName || row.id,
        type: typeof row === "string" ? undefined : row.type,
        category: typeof row === "string" ? undefined : row.category || row.type,
      }))
      .filter((item) => item.id);
  }

  const tokenListed =
    account.apiKeyId && account.distHost
      ? await requestJson(account.baseUrl, `/api/dist/token/${account.apiKeyId}/models`, {
          method: "GET",
          headers: authHeadersForGateway(account),
        }).catch(() => ({ data: { data: [] } }))
      : { data: { data: [] } };
  const tokenRows = extractItems(tokenListed.data);
  if (tokenRows.length > 0) {
    return tokenRows
      .map((row) => ({
        id: String(typeof row === "string" ? row : row.model_name || row.modelName || row.model || row.id || row.name || "").trim(),
        label: typeof row === "string" ? row : row.display_name || row.name || row.model_name || row.modelName || row.model || row.id,
        type: typeof row === "string" ? undefined : row.type,
        category: typeof row === "string" ? undefined : row.category || row.type,
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
  const legacyExternalUserId = login.externalUserId || login.email || login.username;
  const externalUserId = legacyExternalUserId ? scopedExternalUserId(login, legacyExternalUserId) : "";
  const userData = {
    username: login.username ?? null,
    email: login.email ?? null,
    displayName: login.displayName ?? login.username ?? login.email ?? null,
  };

  if (externalUserId) {
    const scopedUser = await prisma.appUser.findUnique({
      where: {
        externalProvider_externalUserId: {
          externalProvider,
          externalUserId,
        },
      },
    });

    if (scopedUser) {
      return prisma.appUser.update({
        where: { id: scopedUser.id },
        data: userData,
      });
    }

    if (legacyExternalUserId && legacyExternalUserId !== externalUserId) {
      const legacyUser = await prisma.appUser.findUnique({
        where: {
          externalProvider_externalUserId: {
            externalProvider,
            externalUserId: legacyExternalUserId,
          },
        },
      });

      if (legacyUser) {
        return prisma.appUser.update({
          where: { id: legacyUser.id },
          data: {
            ...userData,
            externalUserId,
          },
        });
      }
    }

    return prisma.appUser.create({
      data: {
        externalProvider,
        externalUserId,
        ...userData,
      },
    });
  }

  return prisma.appUser.create({
    data: {
      externalProvider,
      ...userData,
    },
  });
}

async function claimLegacyWorkspaceForUser(userId: string) {
  await prisma.$transaction(async (tx) => {
    const [ownedProjects, ownedProviders] = await Promise.all([
      tx.project.count({
        where: {
          userId: {
            not: null,
          },
        },
      }),
      tx.providerConfig.count({
        where: {
          userId: {
            not: null,
          },
        },
      }),
    ]);

    if (ownedProjects + ownedProviders > 0) {
      return;
    }

    await Promise.all([
      tx.project.updateMany({
        where: { userId: null },
        data: { userId },
      }),
      tx.providerConfig.updateMany({
        where: { userId: null },
        data: { userId },
      }),
    ]);
  });
}

async function updateExistingGatewayAccount(account: StoredGatewayAccount) {
  const existing = await prisma.gatewayAccount.findFirst({
    where: {
      userId: account.userId,
      provider: account.provider,
      baseUrl: account.baseUrl,
      distHost: account.distHost ?? null,
    },
  });

  const data = {
    distHost: account.distHost ?? null,
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
  };

  if (existing) {
    return prisma.gatewayAccount.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.gatewayAccount.create({
    data: {
      userId: account.userId,
      provider: account.provider,
      baseUrl: account.baseUrl,
      ...data,
    },
  });
}

async function saveGatewayAccount(account: StoredGatewayAccount) {
  try {
    return await updateExistingGatewayAccount(account);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const legacy = await prisma.gatewayAccount.findFirst({
        where: {
          userId: account.userId,
          provider: account.provider,
          baseUrl: account.baseUrl,
        },
        orderBy: { updatedAt: "desc" },
      });

      if (legacy) {
        await prisma.gatewayAccount.update({
          where: { id: legacy.id },
          data: {
            distHost: account.distHost ?? null,
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
        return legacy;
      }
    }

    throw error;
  }
}

function hydrateStoredAccount(row: Awaited<ReturnType<typeof prisma.gatewayAccount.findFirst>>) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider as GatewayLoginProvider,
    baseUrl: row.baseUrl,
    distHost: row.distHost ?? undefined,
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
  const recommendedDefaults = chooseDefaults(normalizedModels);
  const providerName = gatewayProviderName(account);

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
      name: providerName,
      baseUrl: gatewayBase(account.baseUrl),
    },
    include: { models: true },
  });

  const modelIds = new Set(normalizedModels.map((model) => model.modelId));
  const existingDefaults = existing
    ? {
        analysisModelId: existing.models.find((model) => model.isDefaultAnalysis && modelIds.has(model.modelId))?.modelId,
        planningModelId: existing.models.find((model) => model.isDefaultPlanning && modelIds.has(model.modelId))?.modelId,
        heroImageModelId: existing.models.find((model) => model.isDefaultHeroImage && modelIds.has(model.modelId))?.modelId,
        detailImageModelId: existing.models.find((model) => model.isDefaultDetailImage && modelIds.has(model.modelId))?.modelId,
        imageEditModelId: existing.models.find((model) => model.isDefaultImageEdit && modelIds.has(model.modelId))?.modelId,
      }
    : {};
  const defaults = {
    ...recommendedDefaults,
    ...Object.fromEntries(Object.entries(existingDefaults).filter(([, value]) => Boolean(value))),
  };

  const provider = existing
    ? await prisma.providerConfig.update({
        where: { id: existing.id },
        data: {
          name: providerName,
          apiKeyEncrypted: encryptSecret(account.apiKey || ""),
          isActive: true,
        },
      })
    : await prisma.providerConfig.create({
        data: {
          userId: account.userId,
          name: providerName,
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
  const normalized = String(value || "").trim().toLowerCase().replace(/[-\s]/g, "_");
  if (normalized === "dist" || normalized === "branch" || normalized === "subrouter_dist") {
    return "subrouterai_dist";
  }
  return normalized === "subrouterai" || normalized === "subrouterai_dist" || normalized === "sub2api"
    ? normalized
    : null;
}

function normalizeLoginProviders(providers: Array<Partial<GatewayLoginProviderConfig> | null | undefined>) {
  const seen = new Set<string>();
  const result: GatewayLoginProviderConfig[] = [];

  for (const item of providers) {
    const provider = parseProviderName(item?.provider);
    const baseUrl = typeof item?.baseUrl === "string" ? normalizeBaseUrl(item.baseUrl) : "";
    const distHost = typeof item?.distHost === "string" ? normalizeHost(item.distHost) : undefined;
    if (!provider || !baseUrl) continue;
    const key = `${provider}:${baseUrl}:${distHost || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ provider, baseUrl, distHost });
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

      const matched = text.match(/^([a-z0-9_\-\s]+)\s*=\s*(.+)$/i);
      if (matched) {
        const provider = parseProviderName(matched[1]);
        return provider ? [{ provider, baseUrl: matched[2].trim() }] : [];
      }

      if (/^https?:\/\//i.test(text)) {
        return [
          { provider: "subrouterai" as const, baseUrl: text },
          { provider: "subrouterai_dist" as const, baseUrl: text },
          { provider: "sub2api" as const, baseUrl: text },
        ];
      }

      return [];
    }),
  );
}

function parseBaseUrlList(value?: string) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDistBaseUrlMap(value?: string) {
  const map = new Map<string, string>();
  const raw = String(value || "").trim();
  if (!raw) return map;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, baseUrl] of Object.entries(parsed)) {
        if (typeof baseUrl === "string" && key.trim() && baseUrl.trim()) {
          map.set(key.trim().toLowerCase(), normalizeBaseUrl(baseUrl));
        }
      }
      return map;
    }
  } catch {
    // Also support slug=https://site;123=https://site.
  }

  for (const entry of raw.split(/[,\n;]/)) {
    const [key, ...rest] = entry.split("=");
    const baseUrl = rest.join("=").trim();
    if (key?.trim() && baseUrl) {
      map.set(key.trim().toLowerCase(), normalizeBaseUrl(baseUrl));
    }
  }

  return map;
}

function parseDistHostMap(value?: string) {
  const map = new Map<string, string>();
  const raw = String(value || "").trim();
  if (!raw) return map;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, host] of Object.entries(parsed)) {
        const normalized = normalizeHost(typeof host === "string" ? host : "");
        if (key.trim() && normalized) map.set(key.trim().toLowerCase(), normalized);
      }
      return map;
    }
  } catch {
    // Also support slug=site.example.com;123=site.example.com.
  }

  for (const entry of raw.split(/[,\n;]/)) {
    const [key, ...rest] = entry.split("=");
    const host = normalizeHost(rest.join("=").trim());
    if (key?.trim() && host) {
      map.set(key.trim().toLowerCase(), host);
    }
  }

  return map;
}

function getDistSubdomainSuffixes() {
  return parseBaseUrlList(
    process.env.BANANA_MALL_GATEWAY_DIST_SUBDOMAIN_SUFFIXES ||
      process.env.BANANA_MALL_GATEWAY_DIST_SUBDOMAIN_SUFFIX ||
      process.env.DIST_SUBDOMAIN_SUFFIX,
  ).map((suffix) => normalizeHost(suffix));
}

function inferDistHostFromInfo(info?: GatewayDistributorInfo | null) {
  if (!info?.belongsToDistributor) return "";
  if (info.distributorHost) return normalizeHost(info.distributorHost);

  const hostMap = parseDistHostMap(
    process.env.BANANA_MALL_GATEWAY_DIST_HOSTS ||
      process.env.BANANA_MALL_GATEWAY_DIST_HOST_MAP ||
      process.env.SUBROUTER_DIST_HOST_MAP,
  );
  const keys = [info.distributorId, info.distributorSlug]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  for (const key of keys) {
    const host = hostMap.get(key);
    if (host) return host;
  }

  const suffix = getDistSubdomainSuffixes()[0];
  if (suffix && info.distributorSlug) {
    return `${info.distributorSlug}.${suffix}`;
  }

  return "";
}

function getDistBaseUrlFromInfo(info?: GatewayDistributorInfo | null) {
  if (!info?.belongsToDistributor) return "";

  const baseUrlMap = parseDistBaseUrlMap(
    process.env.BANANA_MALL_GATEWAY_DIST_BASE_URL_MAP ||
      process.env.BANANA_MALL_GATEWAY_DIST_URLS ||
      process.env.SUBROUTER_DIST_BASE_URL_MAP,
  );
  const keys = [info.distributorId, info.distributorSlug]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  for (const key of keys) {
    const baseUrl = baseUrlMap.get(key);
    if (baseUrl) return baseUrl;
  }

  const host = inferDistHostFromInfo(info);
  return host ? normalizeBaseUrl(host) : "";
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

function getGatewayDistLoginProviders(siteUrl?: string | null) {
  const candidates = [
    siteUrl,
    process.env.BANANA_MALL_GATEWAY_DIST_BASE_URL,
    process.env.TOONFLOW_SUBROUTER_DIST_BASE_URL,
    ...parseBaseUrlList(
      process.env.BANANA_MALL_GATEWAY_DIST_BASE_URLS ||
        process.env.TOONFLOW_SUBROUTER_DIST_BASE_URLS ||
        process.env.SUBROUTER_DIST_BASE_URLS,
    ),
  ];

  return normalizeLoginProviders(
    candidates.map((baseUrl) => ({
      provider: "subrouterai_dist" as const,
      baseUrl: baseUrl ?? undefined,
    })),
  );
}

function getGatewayDistProvidersForDistributor(
  info: GatewayDistributorInfo | null | undefined,
  mainBaseUrl: string,
  siteUrl?: string | null,
) {
  const providers: Array<Partial<GatewayLoginProviderConfig>> = [];
  const distHost = inferDistHostFromInfo(info);
  const mappedBaseUrl = getDistBaseUrlFromInfo(info);

  if (distHost) {
    providers.push({
      provider: "subrouterai_dist",
      baseUrl: mainBaseUrl,
      distHost,
    });
  }

  if (mappedBaseUrl) {
    providers.push({
      provider: "subrouterai_dist",
      baseUrl: mappedBaseUrl,
      distHost: normalizeHost(mappedBaseUrl),
    });
  }

  if (distHost) {
    providers.push({
      provider: "subrouterai_dist",
      baseUrl: normalizeBaseUrl(distHost),
      distHost,
    });
  }

  providers.push(...getGatewayDistLoginProviders(siteUrl), { provider: "subrouterai_dist", baseUrl: mainBaseUrl });

  return normalizeLoginProviders(providers);
}

function orderLoginProviders(siteUrl?: string | null) {
  const distProviders = getGatewayDistLoginProviders(siteUrl);
  const baseProviders = getGatewayLoginProviders();
  return siteUrl ? [...distProviders, ...baseProviders] : [...baseProviders, ...distProviders];
}

function isDistKeyError(error: unknown) {
  return error instanceof Error && /分站用户请使用分站密钥接口|分站密钥接口/.test(error.message);
}

function needsDistSiteAddress(error: unknown) {
  return (
    error instanceof Error &&
    /此 API 仅供分站访问|无法识别分销商|分站不存在|404|not found/i.test(error.message)
  );
}

async function completeGatewayLogin(login: GatewayLoginResult) {
  const user = await upsertAppUser(login);
  await claimLegacyWorkspaceForUser(user.id);
  const account: StoredGatewayAccount = {
    ...login,
    userId: user.id,
  };
  const key =
    account.provider === "sub2api"
      ? await ensureGatewayBKey(account)
      : account.provider === "subrouterai_dist"
        ? await ensureGatewayDistKey(account)
        : await ensureGatewayAKey(account);
  account.apiKey = key.key;
  account.apiKeyId = key.id;

  const models =
    account.provider === "sub2api"
      ? await fetchGatewayBModels(account)
      : account.provider === "subrouterai_dist"
        ? await fetchGatewayDistModels(account)
        : await fetchGatewayAModels(account);
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
}

export async function loginWithGatewayProviders(username: string, password: string, siteUrl?: string | null) {
  const providers = orderLoginProviders(siteUrl);
  let lastError: unknown;
  let sawDistKeyError = false;

  for (const provider of providers) {
    try {
      const login = await authenticateGateway({
        ...provider,
        username,
        password,
        timeoutMs: 10000,
      });

      if (login.provider === "subrouterai") {
        const distributor = await fetchGatewayDistributorInfo(login);
        if (distributor?.belongsToDistributor) {
          const distProviders = getGatewayDistProvidersForDistributor(distributor, login.baseUrl, siteUrl);
          if (distProviders.length === 0) {
            throw new Error("当前账号属于分站，请填写站点地址后登录，或联系管理员配置站点地址。");
          }

          let distError: unknown;
          let emptyModelResult: Awaited<ReturnType<typeof completeGatewayLogin>> | null = null;
          for (const distProvider of distProviders) {
            try {
              const result = await completeGatewayLogin({
                ...login,
                ...distProvider,
                provider: "subrouterai_dist",
              });
              if (result.models.length > 0 || !distProvider.distHost) {
                return result;
              }
              emptyModelResult = result;
            } catch (error) {
              distError = error;
            }
          }

          const hasDistContext = distProviders.some(
            (item) => item.distHost || normalizeBaseUrl(item.baseUrl) !== normalizeBaseUrl(login.baseUrl),
          );
          if (!hasDistContext && needsDistSiteAddress(distError)) {
            throw new Error("当前账号属于分站，请填写站点地址后登录，或联系管理员升级网关接口。");
          }

          if (emptyModelResult) {
            return emptyModelResult;
          }

          throw distError instanceof Error
            ? distError
            : new Error("当前账号属于分站，但未能连接到对应站点。");
        }
      }

      return await completeGatewayLogin(login);
    } catch (error) {
      if (isDistKeyError(error)) {
        sawDistKeyError = true;
      }
      lastError = error;
    }
  }

  if (sawDistKeyError && getGatewayDistLoginProviders(siteUrl).length === 0) {
    throw new Error("当前账号属于分站，请填写站点地址后登录。");
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

  const models =
    account.provider === "sub2api"
      ? await fetchGatewayBModels(account)
      : account.provider === "subrouterai_dist"
        ? await fetchGatewayDistModels(account)
        : await fetchGatewayAModels(account);
  account.modelsSnapshot = models;
  await saveGatewayAccount(account);
  await upsertUserProviderFromGateway(account, models);
  return models;
}

export async function ensureGatewayProviderForUser(userId: string) {
  const account = await getLatestGatewayAccount(userId);
  if (!account?.apiKey) {
    return null;
  }

  const cachedModels = Array.isArray(account.modelsSnapshot)
    ? (account.modelsSnapshot as GatewayModel[])
    : [];

  if (cachedModels.length > 0) {
    return upsertUserProviderFromGateway(account, cachedModels);
  }

  await refreshGatewayModelsForUser(userId);
  const refreshedAccount = await getLatestGatewayAccount(userId);
  const refreshedModels = Array.isArray(refreshedAccount?.modelsSnapshot)
    ? (refreshedAccount.modelsSnapshot as GatewayModel[])
    : [];
  return refreshedModels.length > 0 && refreshedAccount
    ? upsertUserProviderFromGateway(refreshedAccount, refreshedModels)
    : null;
}
