import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

import { buildProductAnalysisPrompt, buildProductAnalysisRepairPrompt } from "@/lib/ai/prompts";
import { productAnalysisOutputSchema } from "@/lib/ai/schemas/product-analysis";
import { requireProjectAccess } from "@/lib/auth/authorization";
import { prisma } from "@/lib/db/prisma";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { completeTask, createTask, failTask, findRecentRunningTask } from "@/lib/services/task-service";
import { readStorageFile } from "@/lib/storage/asset-manager";

function normalizeModelId(value: string) {
  return value.toLowerCase();
}

function hasCapability(model: { capabilities: unknown }, key: string) {
  const capabilities = (model.capabilities ?? {}) as Record<string, boolean>;
  return Boolean(capabilities[key]);
}

function isPreviewLike(modelId: string) {
  return /(preview|experimental|beta|test)/i.test(modelId);
}

function isLiteLike(modelId: string) {
  return /(lite|flash-lite)/i.test(modelId);
}

function isImageSpecialized(modelId: string) {
  return /(image|imagen|recraft|flux|canvas)/i.test(modelId);
}

function isStableAnalysisCandidate(modelId: string) {
  return !isPreviewLike(modelId) && !isLiteLike(modelId) && !isImageSpecialized(modelId);
}

function extractJsonBlock(raw: string) {
  const direct = raw.trim();
  if (direct.startsWith("{") || direct.startsWith("[")) {
    return direct;
  }

  const fencedMatch = direct.match(/```json([\s\S]*?)```/i) || direct.match(/```([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = direct.indexOf("{");
  const lastBrace = direct.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return direct.slice(firstBrace, lastBrace + 1);
  }

  return direct;
}

function shouldAttemptRepair(error: unknown) {
  return (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    (error instanceof Error && /json|schema|parse/i.test(error.message))
  );
}

function pickAnalysisModel(
  provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"],
  preferredModelId?: string | null,
) {
  if (preferredModelId) {
    const preferred = provider.models.find((item) => item.modelId === preferredModelId);
    if (preferred && hasCapability(preferred, "text")) {
      return preferred.modelId;
    }
  }

  const textVisionModels = provider.models.filter(
    (item) => hasCapability(item, "text") && hasCapability(item, "vision"),
  );
  const textModels = provider.models.filter((item) => hasCapability(item, "text"));

  const findMatch = (
    models: typeof provider.models,
    predicate: (model: (typeof provider.models)[number]) => boolean,
  ) => models.find(predicate)?.modelId;
  const configuredDefault = findMatch(textVisionModels, (item) => item.isDefaultAnalysis) ??
    findMatch(textModels, (item) => item.isDefaultAnalysis);

  return (
    configuredDefault ??
    findMatch(
      textVisionModels,
      (item) => normalizeModelId(item.modelId).includes("gemini") && isStableAnalysisCandidate(item.modelId),
    ) ??
    findMatch(
      textVisionModels,
      (item) => normalizeModelId(item.modelId).includes("gpt-4o") && isStableAnalysisCandidate(item.modelId),
    ) ??
    findMatch(textVisionModels, (item) => isStableAnalysisCandidate(item.modelId)) ??
    findMatch(textModels, (item) => item.isDefaultAnalysis) ??
    findMatch(textModels, (item) => isStableAnalysisCandidate(item.modelId)) ??
    textModels[0]?.modelId ??
    null
  );
}

async function assetToDataUrl(asset: { filePath: string; mimeType: string | null }) {
  const buffer = await readStorageFile(asset.filePath);
  const mimeType = asset.mimeType ?? "image/png";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function repairAnalysisOutput(input: {
  adapter: Awaited<ReturnType<typeof getProviderAdapter>>["adapter"];
  model: string;
  raw: string;
}) {
  const repaired = await input.adapter.generateText({
    model: input.model,
    systemPrompt: "Return one strict JSON object only.",
    userPrompt: buildProductAnalysisRepairPrompt(input.raw),
    monitor: {
      operation: "analysis_output_repair",
    },
  });

  const parsed = productAnalysisOutputSchema.parse(JSON.parse(extractJsonBlock(repaired.text)));
  return {
    parsed,
    repairedRaw: repaired.text,
  };
}

function normalizeAnalysisProviderError(error: unknown): never {
  const detail = error instanceof Error ? error.message : "Unknown analysis error";

  if (/monthly spending limit|spending limit|billing|quota|insufficient_quota/i.test(detail)) {
    throw new Error("当前 API Key 的分析额度已用尽。请前往代理商控制台提高或移除月度限额，或更换可用的 API Key。");
  }

  if (/429|rate limit|限流/i.test(detail)) {
    throw new Error("当前分析请求触发了限流。请稍后重试，或降低调用频率。");
  }

  if (/invalid token|unauthorized|forbidden/i.test(detail)) {
    throw new Error("当前 Provider 鉴权失败。请检查 baseURL、API Key 或代理商权限配置。");
  }

  if (/timed out|aborterror|network error|fetch failed/i.test(detail)) {
    throw new Error("当前 Provider 请求超时或网络异常，请稍后重试。");
  }

  throw error instanceof Error ? error : new Error(detail);
}

function describeAnalysisFallback(error: unknown) {
  const detail = error instanceof Error ? error.message : "Unknown analysis error";

  if (/No active provider config found/i.test(detail)) {
    return "当前没有可用的 Provider 配置，已生成可编辑的本地分析草稿。";
  }

  if (/No analysis model available|当前没有可用/i.test(detail)) {
    return "当前没有可用的商品分析模型，已生成可编辑的本地分析草稿。";
  }

  if (/timed out|aborterror|network error|fetch failed|请求超时|网络异常/i.test(detail)) {
    return "AI 商品分析请求超时或网络异常，已生成可编辑的本地分析草稿。";
  }

  if (/invalid token|unauthorized|forbidden|鉴权失败|401|403/i.test(detail)) {
    return "当前 Provider 鉴权失败，已生成可编辑的本地分析草稿。";
  }

  if (/429|rate limit|限流/i.test(detail)) {
    return "当前 Provider 触发限流，已生成可编辑的本地分析草稿。";
  }

  if (/monthly spending limit|spending limit|billing|quota|insufficient_quota|额度已用尽|月度限额/i.test(detail)) {
    return "当前 Provider 额度不可用，已生成可编辑的本地分析草稿。";
  }

  return `AI 商品分析暂时不可用，已生成可编辑的本地分析草稿。原因：${detail}`;
}

function buildLocalAnalysisDraft(project: {
  name: string;
  platform: string;
  style: string;
  description: string | null;
  assets: Array<{ fileName: string; type: string }>;
}) {
  const assetNames = project.assets.map((asset) => asset.fileName.replace(/\.[^.]+$/, "")).filter(Boolean);
  const productName = project.name || assetNames[0] || "未命名商品";
  const notes = project.description?.trim();

  return productAnalysisOutputSchema.parse({
    productName,
    category: "待确认品类",
    subcategory: "待确认子类目",
    material: "待补充材质",
    color: "以主图为准",
    styleTags: ["通用电商", "清晰展示", "转化导向"],
    targetAudience: ["关注商品外观与实用价值的用户", "需要快速判断购买理由的用户"],
    usageScenarios: ["日常使用场景", "电商详情页展示", "移动端浏览"],
    coreSellingPoints: [
      notes || "商品主体清晰，适合围绕外观、功能和使用场景展开详情页表达",
      "可结合主图补充卖点、细节、规格和信任背书",
      "适合先生成基础规划，再在分析页手动校准商品信息",
    ],
    differentiationPoints: ["结合主图突出外观记忆点", "通过详情页模块补充用户决策信息"],
    userConcerns: ["商品信息仍需人工确认", "材质、尺寸、功效等关键参数需要补充"],
    recommendedFocusPoints: ["先确认商品名称、品类、材质和核心卖点", "优先规划头图、卖点速览、细节说明、场景展示和规格信息"],
    suggestedSectionPlan: [
      { type: "hero", title: "主视觉头图", goal: "先用清晰商品主体建立第一眼认知" },
      { type: "selling_points", title: "核心卖点速览", goal: "把主要购买理由在一屏内讲清楚" },
      { type: "detail_closeup", title: "细节特写", goal: "补充材质、结构和做工信任感" },
      { type: "scenario", title: "场景使用展示", goal: "让用户代入真实使用场景" },
      { type: "specs", title: "规格信息说明", goal: "整理尺寸、参数和适配信息" },
      { type: "summary", title: "购买理由总结", goal: "完成最后转化收口" },
    ],
  }) as Prisma.JsonObject;
}

export async function analyzeProject(projectId: string, preferredModelId?: string | null) {
  await requireProjectAccess(projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { assets: { orderBy: { sortOrder: "asc" } } },
  });

  if (!project) {
    throw new Error("Project not found.");
  }

  const existingTask = await findRecentRunningTask({
    projectId,
    taskType: "ANALYZE",
    maxAgeMinutes: 10,
  });
  if (existingTask) {
    throw new Error("当前商品分析仍在进行中，请等待这一轮完成后再试。");
  }

  const task = await createTask({
    projectId,
    taskType: "ANALYZE",
    inputPayload: { requestedModel: preferredModelId ?? null },
  });

  try {
    const { provider, adapter } = await getProviderAdapter();
    const model = pickAnalysisModel({ ...provider, models: provider.models }, preferredModelId);

    if (!model) {
      throw new Error("No analysis model available.");
    }

    const imageUrls = await Promise.all(project.assets.slice(0, 6).map((asset) => assetToDataUrl(asset)));
    const prompt = buildProductAnalysisPrompt(project.assets);

    let parsedResult: Prisma.JsonObject;
    let rawResult: Prisma.JsonObject;

    try {
      const structured = await adapter.generateStructured({
        model,
        systemPrompt: "Return one strict JSON object only. No markdown.",
        userPrompt: prompt,
        schema: productAnalysisOutputSchema,
        images: imageUrls,
        monitor: {
          projectId,
          operation: "project_analysis",
        },
      });

      parsedResult = structured.parsed as Prisma.JsonObject;
      rawResult = {
        mode: "structured",
        model,
        raw: structured.raw,
      };
    } catch (error) {
      if (!shouldAttemptRepair(error)) {
        normalizeAnalysisProviderError(error);
      }

      const fallbackText = await adapter.generateText({
        model,
        systemPrompt: "Return one strict JSON object only. No markdown.",
        userPrompt: prompt,
        images: imageUrls,
        monitor: {
          projectId,
          operation: "project_analysis_fallback",
        },
      });

      try {
        const directParsed = productAnalysisOutputSchema.parse(JSON.parse(extractJsonBlock(fallbackText.text)));
        parsedResult = directParsed as Prisma.JsonObject;
        rawResult = {
          mode: "text_fallback",
          model,
          initialError:
            error instanceof ZodError
              ? error.flatten()
              : error instanceof Error
                ? error.message
                : "Unknown analysis error",
          fallbackRaw: fallbackText.text,
        };
      } catch {
      const repaired = await repairAnalysisOutput({
        adapter,
        model,
        raw: fallbackText.text,
      }).catch((repairError) => {
        normalizeAnalysisProviderError(repairError);
      });

        parsedResult = repaired.parsed as Prisma.JsonObject;
        rawResult = {
          mode: "text_repair",
          model,
          initialError:
            error instanceof ZodError
              ? error.flatten()
              : error instanceof Error
                ? error.message
                : "Unknown analysis error",
          fallbackRaw: fallbackText.text,
          repairedRaw: repaired.repairedRaw,
        };
      }
    }

    const saved = await prisma.productAnalysis.upsert({
      where: { projectId },
      update: {
        rawResult,
        normalizedResult: parsedResult,
      },
      create: {
        projectId,
        rawResult,
        normalizedResult: parsedResult,
      },
    });

    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "ANALYZED",
        modelSnapshot: {
          ...(project.modelSnapshot as Record<string, unknown> | null),
          analysisModelId: model,
          providerConfigId: provider.id,
        },
      },
    });

    await completeTask(task.id, saved.normalizedResult);
    return saved;
  } catch (error) {
    const fallbackReason = describeAnalysisFallback(error);
    const parsedResult = buildLocalAnalysisDraft(project);
    const saved = await prisma.productAnalysis.upsert({
      where: { projectId },
      update: {
        rawResult: {
          mode: "local_fallback",
          reason: fallbackReason,
          error: error instanceof Error ? error.message : "Unknown analysis error",
        },
        normalizedResult: parsedResult,
      },
      create: {
        projectId,
        rawResult: {
          mode: "local_fallback",
          reason: fallbackReason,
          error: error instanceof Error ? error.message : "Unknown analysis error",
        },
        normalizedResult: parsedResult,
      },
    });

    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "ANALYZED",
        modelSnapshot: {
          ...(project.modelSnapshot as Record<string, unknown> | null),
          analysisModelId: preferredModelId ?? null,
          analysisFallbackReason: fallbackReason,
        },
      },
    });

    await completeTask(task.id, {
      normalizedResult: saved.normalizedResult,
      fallbackMode: "local_analysis",
      fallbackReason,
    });
    return saved;
  }
}

export async function updateAnalysis(projectId: string, normalizedResult: unknown) {
  await requireProjectAccess(projectId);
  const jsonValue = normalizedResult as Prisma.InputJsonValue;
  return prisma.productAnalysis.upsert({
    where: { projectId },
    update: { normalizedResult: jsonValue },
    create: {
      projectId,
      rawResult: jsonValue,
      normalizedResult: jsonValue,
    },
  });
}
