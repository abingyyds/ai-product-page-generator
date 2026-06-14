"use client";

import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ChevronsUpDown, CopyPlus, History, KeyRound, Loader2, PlugZap, RefreshCw, Save, Search } from "lucide-react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { providerSaveSchema } from "@/lib/validations/provider";

type ProviderFormValues = z.input<typeof providerSaveSchema>;

type ProviderModelRecord = {
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
  isDefaultAnalysis: boolean;
  isDefaultPlanning: boolean;
  isDefaultHeroImage: boolean;
  isDefaultDetailImage: boolean;
  isDefaultImageEdit: boolean;
};

type ProviderRecord = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  maskedApiKey: string;
  isActive: boolean;
  updatedAt: string | Date;
  models: ProviderModelRecord[];
};

type GatewayStatus = {
  connected: boolean;
  account: {
    username?: string | null;
    email?: string | null;
    displayName?: string | null;
    apiKeyReady: boolean;
  } | null;
  models: Array<Record<string, unknown>>;
};

interface ProviderSettingsProps {
  initialProviders: ProviderRecord[];
}

type DefaultAssignments = {
  analysisModelId: string;
  planningModelId: string;
  heroImageModelId: string;
  detailImageModelId: string;
  imageEditModelId: string;
};

type GenericModelRecord = Record<string, any>;
type ModelTypeKey = "text" | "vision" | "image_gen" | "image_edit";
type ModelOptionGroup = {
  key: string;
  label: string;
  description: string;
  models: GenericModelRecord[];
};

const modelTypeFields: Array<{ key: ModelTypeKey; label: string }> = [
  { key: "text", label: "文本生成模型" },
  { key: "vision", label: "图像识别模型" },
  { key: "image_gen", label: "图像生成模型" },
  { key: "image_edit", label: "图像编辑模型" },
];

function buildDefaults(provider: ProviderRecord | null): DefaultAssignments {
  return {
    analysisModelId: provider?.models.find((item) => item.isDefaultAnalysis)?.modelId ?? "",
    planningModelId: provider?.models.find((item) => item.isDefaultPlanning)?.modelId ?? "",
    heroImageModelId: provider?.models.find((item) => item.isDefaultHeroImage)?.modelId ?? "",
    detailImageModelId: provider?.models.find((item) => item.isDefaultDetailImage)?.modelId ?? "",
    imageEditModelId: provider?.models.find((item) => item.isDefaultImageEdit)?.modelId ?? "",
  };
}

function uniqueModels(models: GenericModelRecord[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = model.modelId ?? model.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getModelText(model: GenericModelRecord) {
  return `${model.modelId ?? ""} ${model.label ?? ""}`.toLowerCase();
}

function normalizeModelId(modelId: string) {
  return modelId.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

const preferredEconomyTextModelIds = [
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "gemini-2.5-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
];

function getEconomyTextPreferenceRank(model: GenericModelRecord) {
  const normalized = normalizeModelId(String(model.modelId ?? model.label ?? ""));
  const index = preferredEconomyTextModelIds.map(normalizeModelId).indexOf(normalized);
  return index === -1 ? null : index;
}

function isPreferredEconomyTextModel(model: GenericModelRecord) {
  return getEconomyTextPreferenceRank(model) !== null;
}

function isPreferredGptImage2(model: GenericModelRecord) {
  const modelId = String(model.modelId ?? model.label ?? "");
  const normalized = normalizeModelId(modelId);
  return normalized === "gptimage2" || /^gpt[-_\s]?image[-_\s]?2(?:[-_\s]|$)/i.test(modelId);
}

function isUtilityModel(model: GenericModelRecord) {
  return /(embedding|embed|rerank|ranker|moderation|whisper|tts|speech|transcrib|audio|sora|video)/.test(getModelText(model));
}

function isTextGenerationModel(model: GenericModelRecord) {
  return (
    !isUtilityModel(model) &&
    (Boolean(model.capabilities?.text) ||
      /(^|[-_])o[134](?:[-_]|$)|gpt|gemini|claude|qwen|qwq|qvq|glm|deepseek|chat|instruct|command|llama|mistral|mixtral|moonshot|kimi|yi-|ernie|hunyuan|spark|doubao|minimax|abab|grok|reka|cohere|sonar/.test(
        getModelText(model),
      ))
  );
}

function isVisionModel(model: GenericModelRecord) {
  return (
    Boolean(model.capabilities?.vision) ||
    /(vision|vl|4o|omni|gemini|multimodal|qwen-vl|qvq|pixtral|llava|visual|claude-3|claude-sonnet|claude-opus|gpt-4\.1|gpt-5)/.test(
      getModelText(model),
    )
  );
}

function isImageGenerationModel(model: GenericModelRecord) {
  return (
    Boolean(model.capabilities?.image_gen) ||
    /(image|imagen|flux|sdxl|stable-diffusion|stable.?image|banana|nano-banana|recraft|dall[-_ ]?e|gpt[-_\s]?image|chatgpt-image|seedream|jimeng|midjourney|mj-|ideogram|hidream|kolors|wanx|cogview|playground|leonardo)/.test(
      getModelText(model),
    )
  );
}

function isImageEditModel(model: GenericModelRecord) {
  return (
    Boolean(model.capabilities?.image_edit) ||
    /(edit|inpaint|mask|kontext|retouch|erase|remove.?background|gpt[-_\s]?image|chatgpt-image)/.test(getModelText(model))
  );
}

function isImageProductionModel(model: GenericModelRecord) {
  return isImageGenerationModel(model) || isImageEditModel(model);
}

function isStructuredOutputModel(model: GenericModelRecord) {
  return Boolean(model.capabilities?.structured_output) || isTextGenerationModel(model);
}

function isEmbeddingOrRerankModel(model: GenericModelRecord) {
  return /(embedding|embed|rerank|ranker)/.test(getModelText(model));
}

function isAudioModel(model: GenericModelRecord) {
  return /(whisper|tts|speech|audio|transcrib)/.test(getModelText(model));
}

function isVideoModel(model: GenericModelRecord) {
  return /(sora|video|veo|kling|wan[-_ ]?video)/.test(getModelText(model));
}

function isModerationModel(model: GenericModelRecord) {
  return /(moderation|guard|safety|safe)/.test(getModelText(model));
}

function isFastOrCheapModel(model: GenericModelRecord) {
  return Boolean(model.capabilities?.fast || model.capabilities?.cheap) || /(flash|mini|nano|lite|turbo|instant)/.test(getModelText(model));
}

function isHighQualityModel(model: GenericModelRecord) {
  return Boolean(model.capabilities?.high_quality) || /(pro|ultra|opus|quality|max|sonnet|gpt-5)/.test(getModelText(model));
}

function isPreviewOrTestModel(model: GenericModelRecord) {
  return /(^|[-_])(?:preview|experimental|beta|test|deprecated|legacy)(?:[-_]|$)/.test(getModelText(model));
}

function canUseForModelType(model: GenericModelRecord, typeKey: ModelTypeKey) {
  if (typeKey === "text") {
    return isTextGenerationModel(model) && !isImageProductionModel(model);
  }
  if (typeKey === "vision") {
    return isVisionModel(model) && !isImageProductionModel(model);
  }
  if (typeKey === "image_gen") {
    return isImageGenerationModel(model);
  }
  return isImageEditModel(model);
}

function scoreModelForType(model: GenericModelRecord, typeKey: ModelTypeKey) {
  let score = 0;

  const economyRank = getEconomyTextPreferenceRank(model);
  if ((typeKey === "text" || typeKey === "vision") && economyRank !== null) {
    score += 120 - economyRank;
  }
  if ((typeKey === "image_gen" || typeKey === "image_edit") && isPreferredGptImage2(model)) {
    score += normalizeModelId(String(model.modelId ?? model.label ?? "")) === "gptimage2" ? 100 : 90;
  }

  if (typeKey === "text") {
    if (isTextGenerationModel(model)) score += 10;
    if (isStructuredOutputModel(model)) score += 5;
  } else if (typeKey === "vision") {
    if (isVisionModel(model)) score += 12;
    if (isTextGenerationModel(model)) score += 4;
  } else if (typeKey === "image_edit") {
    if (isImageEditModel(model)) score += 35;
  } else {
    if (isImageGenerationModel(model)) score += 35;
  }

  if (isHighQualityModel(model)) score += 4;
  if (isFastOrCheapModel(model)) score += 6;
  if ((typeKey === "text" || typeKey === "vision") && /gpt[-_\s]?5\.5|gpt[-_\s]?5\.4[-_\s]?pro|pro|max/i.test(getModelText(model))) {
    score -= 25;
  }
  if (isPreviewOrTestModel(model)) score -= 8;

  return score;
}

function getModelsForType(models: GenericModelRecord[], typeKey: ModelTypeKey) {
  return uniqueModels(models.filter((model) => canUseForModelType(model, typeKey))).sort((left, right) => {
    const diff = scoreModelForType(right, typeKey) - scoreModelForType(left, typeKey);
    if (diff !== 0) return diff;
    return String(left.modelId ?? left.label).localeCompare(String(right.modelId ?? right.label));
  });
}

function isManagedGatewayProvider(provider: ProviderRecord | null | undefined) {
  return Boolean(provider && (provider.name === "智能网关" || provider.name.startsWith("智能网关 / ")) && provider.baseUrl === "自动配置");
}

function getTypeDefaultValue(defaults: DefaultAssignments, typeKey: ModelTypeKey) {
  if (typeKey === "text") {
    return defaults.planningModelId ?? "";
  }
  if (typeKey === "vision") {
    return defaults.analysisModelId ?? "";
  }
  if (typeKey === "image_gen") {
    return defaults.heroImageModelId || defaults.detailImageModelId || "";
  }
  return defaults.imageEditModelId ?? "";
}

function setTypeDefaultValue(defaults: DefaultAssignments, typeKey: ModelTypeKey, modelId: string): DefaultAssignments {
  if (typeKey === "text") {
    return { ...defaults, planningModelId: modelId };
  }
  if (typeKey === "vision") {
    return { ...defaults, analysisModelId: modelId };
  }
  if (typeKey === "image_gen") {
    return { ...defaults, heroImageModelId: modelId, detailImageModelId: modelId };
  }
  return { ...defaults, imageEditModelId: modelId };
}

function buildCapabilityGroups(models: GenericModelRecord[]): ModelOptionGroup[] {
  return [
    {
      key: "text",
      label: "文本生成模型",
      description: "用于商品分析、页面规划、文案生成和结构化输出",
      models: models.filter(isTextGenerationModel),
    },
    {
      key: "vision",
      label: "图像识别模型",
      description: "用于理解上传商品图、参考图和多模态分析",
      models: models.filter(isVisionModel),
    },
    {
      key: "image_gen",
      label: "图像生成模型",
      description: "用于生成头图、详情图和电商视觉素材",
      models: models.filter(isImageGenerationModel),
    },
    {
      key: "image_edit",
      label: "图像编辑模型",
      description: "用于重绘、增强、局部修改和基于参考图编辑",
      models: models.filter(isImageEditModel),
    },
    {
      key: "structured",
      label: "结构化输出模型",
      description: "用于稳定返回 JSON、规划模块和可解析结果",
      models: models.filter(isStructuredOutputModel),
    },
    {
      key: "embedding",
      label: "Embedding / Rerank 模型",
      description: "用于向量检索、排序和相似度任务",
      models: models.filter(isEmbeddingOrRerankModel),
    },
    {
      key: "audio",
      label: "音频模型",
      description: "用于语音识别、转写或语音合成",
      models: models.filter(isAudioModel),
    },
    {
      key: "video",
      label: "视频模型",
      description: "用于视频生成或视频理解",
      models: models.filter(isVideoModel),
    },
    {
      key: "moderation",
      label: "安全审核模型",
      description: "用于内容审核、安全分类和风控",
      models: models.filter(isModerationModel),
    },
    {
      key: "fast",
      label: "高速/低成本模型",
      description: "适合草稿、批量预览和低成本任务",
      models: models.filter(isFastOrCheapModel),
    },
    {
      key: "high_quality",
      label: "高质量模型",
      description: "适合最终生成、复杂推理和高品质视觉任务",
      models: models.filter(isHighQualityModel),
    },
    {
      key: "other",
      label: "其他模型",
      description: "当前规则未明确归类的模型，仍可在默认角色中手动选择",
      models: models.filter(
        (model) =>
          !isTextGenerationModel(model) &&
          !isVisionModel(model) &&
          !isImageGenerationModel(model) &&
          !isImageEditModel(model) &&
          !isEmbeddingOrRerankModel(model) &&
          !isAudioModel(model) &&
          !isVideoModel(model) &&
          !isModerationModel(model),
      ),
    },
  ]
    .map((group) => ({ ...group, models: uniqueModels(group.models) }))
    .filter((group) => group.models.length > 0);
}

function pickModel(models: GenericModelRecord[], predicates: Array<(model: GenericModelRecord) => boolean>) {
  for (const predicate of predicates) {
    const matched = models.find(predicate);
    if (matched?.modelId) {
      return matched.modelId;
    }
  }

  return "";
}

function buildRecommendedDefaults(models: GenericModelRecord[]): DefaultAssignments {
  const visionModels = getModelsForType(models, "vision");
  const textModels = getModelsForType(models, "text");
  const imageGenerationModels = getModelsForType(models, "image_gen");
  const imageEditModels = getModelsForType(models, "image_edit");
  const economyVision = pickModel(visionModels, [isPreferredEconomyTextModel]);
  const economyText = pickModel(textModels, [isPreferredEconomyTextModel]);
  const gptImage2Generation = pickModel(imageGenerationModels, [isPreferredGptImage2]);
  const gptImage2Edit = pickModel(imageEditModels, [isPreferredGptImage2]);

  return {
    analysisModelId: economyVision || pickModel(visionModels, [() => true]),
    planningModelId: economyText || pickModel(textModels, [() => true]),
    heroImageModelId: gptImage2Generation || pickModel(imageGenerationModels, [() => true]),
    detailImageModelId: gptImage2Generation || pickModel(imageGenerationModels, [() => true]),
    imageEditModelId: gptImage2Edit || pickModel(imageEditModels, [() => true]),
  };
}

function formatTimeLabel(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function countModelsByType(models: GenericModelRecord[], typeKey: ModelTypeKey) {
  return getModelsForType(models, typeKey).length;
}

async function fetchSavedProviders() {
  const response = await fetch("/api/providers", {
    cache: "no-store",
  });
  const payload = await response.json();

  if (!response.ok || !payload.success) {
    throw new Error(payload.error?.message ?? "加载 AI 配置失败");
  }

  return (payload.data ?? []) as ProviderRecord[];
}

export function ProviderSettings({ initialProviders }: ProviderSettingsProps) {
  const [providers, setProviders] = useState(initialProviders);
  const activeProvider = useMemo(
    () => providers.find((item) => item.isActive) ?? providers[0] ?? null,
    [providers],
  );
  const [selectedProviderId, setSelectedProviderId] = useState(activeProvider?.id ?? "");
  const [loading, setLoading] = useState<null | "test" | "discover" | "save" | "saveAsNew" | "refreshGateway" | "saveDefaults">(null);
  const [switchingProviderId, setSwitchingProviderId] = useState<string | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayStatusLoading, setGatewayStatusLoading] = useState(false);
  const [gatewayStatusError, setGatewayStatusError] = useState<string | null>(null);
  const selectedProvider = useMemo(
    () => providers.find((item) => item.id === selectedProviderId) ?? activeProvider,
    [providers, selectedProviderId, activeProvider],
  );
  const selectedProviderIsManaged = isManagedGatewayProvider(selectedProvider);
  const [models, setModels] = useState<Array<GenericModelRecord>>(selectedProvider?.models ?? []);
  const [defaults, setDefaults] = useState<DefaultAssignments>(buildDefaults(selectedProvider ?? null));

  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(providerSaveSchema),
    defaultValues: {
      id: selectedProvider?.id ?? undefined,
      name: selectedProvider?.name ?? "默认模型服务",
      baseUrl: selectedProvider?.baseUrl ?? "",
      apiKey: selectedProvider?.apiKey ?? "",
      isActive: true,
      defaultAssignments: undefined,
    },
  });
  const { reset } = form;

  useEffect(() => {
    const nextProvider = selectedProvider ?? null;
    setModels(nextProvider?.models ?? []);
    setDefaults(buildDefaults(nextProvider));
    reset({
      id: nextProvider?.id ?? undefined,
      name: nextProvider?.name ?? "默认模型服务",
      baseUrl: nextProvider?.baseUrl ?? "",
      apiKey: nextProvider?.apiKey ?? "",
      isActive: true,
      defaultAssignments: undefined,
    });
  }, [selectedProvider, reset]);

  const availableImageModels = useMemo(
    () => models.filter(isImageGenerationModel),
    [models],
  );
  const capabilityGroups = useMemo(() => buildCapabilityGroups(models), [models]);
  const selectedDefaultCount = useMemo(
    () => Object.values(defaults).filter(Boolean).length,
    [defaults],
  );
  const unavailableModelCount = useMemo(
    () => models.filter((model) => model.isAvailable === false).length,
    [models],
  );
  const modelSummary = useMemo(
    () => ({
      text: countModelsByType(models, "text"),
      vision: countModelsByType(models, "vision"),
      imageGeneration: countModelsByType(models, "image_gen"),
      imageEdit: countModelsByType(models, "image_edit"),
    }),
    [models],
  );

  useEffect(() => {
    if (!selectedProviderIsManaged) {
      setGatewayStatus(null);
      setGatewayStatusError(null);
      setGatewayStatusLoading(false);
      return;
    }

    let aborted = false;

    async function loadGatewayStatus() {
      try {
        setGatewayStatusLoading(true);
        setGatewayStatusError(null);

        const response = await fetch("/api/gateway/models", {
          cache: "no-store",
        });
        const payload = await response.json();

        if (!response.ok || !payload.success) {
          throw new Error(payload.error?.message ?? "读取智能网关状态失败");
        }

        if (!aborted) {
          setGatewayStatus(payload.data);
        }
      } catch (error) {
        if (!aborted) {
          setGatewayStatusError(error instanceof Error ? error.message : "读取智能网关状态失败");
        }
      } finally {
        if (!aborted) {
          setGatewayStatusLoading(false);
        }
      }
    }

    loadGatewayStatus();

    return () => {
      aborted = true;
    };
  }, [selectedProvider?.id, selectedProviderIsManaged]);

  function handleAutoFillDefaults() {
    setDefaults(buildRecommendedDefaults(models));
    toast.success("已按模型能力类型自动填充默认角色");
  }

  function hydrateFromSavedProviders(nextProviders: ProviderRecord[], nextSelectedId?: string | null) {
    setProviders(nextProviders);
    const fallbackId = nextSelectedId ?? nextProviders.find((item) => item.isActive)?.id ?? nextProviders[0]?.id ?? "";
    setSelectedProviderId(fallbackId);
  }

  async function handleActivateProvider(providerId: string) {
    setSwitchingProviderId(providerId);
    try {
      const response = await fetch("/api/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "切换历史服务失败");
      }

      hydrateFromSavedProviders(payload.data ?? [], providerId);
      toast.success("已切换为当前服务");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换历史服务失败");
    } finally {
      setSwitchingProviderId(null);
    }
  }

  async function handleRefreshGatewayModels() {
    if (!selectedProviderIsManaged) return;

    setLoading("refreshGateway");
    try {
      const response = await fetch("/api/gateway/models", {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "刷新智能网关模型失败");
      }

      const nextProviders = await fetchSavedProviders();
      const nextProviderId =
        nextProviders.find((item) => isManagedGatewayProvider(item))?.id ?? selectedProviderId;
      hydrateFromSavedProviders(nextProviders, nextProviderId);
      setGatewayStatus((current) =>
        current
          ? {
              ...current,
              connected: true,
              models: payload.data?.models ?? current.models,
            }
          : current,
      );
      toast.success(`已刷新 ${payload.data?.models?.length ?? 0} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新智能网关模型失败");
    } finally {
      setLoading(null);
    }
  }

  async function handleSaveDefaults() {
    if (!selectedProvider?.id) return;

    setLoading("saveDefaults");
    try {
      const response = await fetch("/api/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: selectedProvider.id,
          defaultAssignments: defaults,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "保存默认模型失败");
      }

      hydrateFromSavedProviders(payload.data ?? [], selectedProvider.id);
      toast.success("默认模型选择已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存默认模型失败");
    } finally {
      setLoading(null);
    }
  }

  const handleTest = form.handleSubmit(async (values) => {
    setLoading("test");
    try {
      const response = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "连接测试失败");
      }
      toast.success("模型服务连接成功");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setLoading(null);
    }
  });

  const handleDiscover = form.handleSubmit(async (values) => {
    setLoading("discover");
    try {
      const response = await fetch("/api/providers/discover-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "模型发现失败");
      }
      setModels(payload.data.models);
      setDefaults(payload.data.recommendations);
      toast.success(`已发现 ${payload.data.models.length} 个模型，并完成能力识别`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模型发现失败");
    } finally {
      setLoading(null);
    }
  });

  async function saveProvider(overwriteExisting: boolean) {
    return form.handleSubmit(async (values) => {
      setLoading(overwriteExisting ? "save" : "saveAsNew");
      try {
        const response = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...values,
            id: overwriteExisting ? values.id : undefined,
            defaultAssignments: defaults,
            discoveredModels: models,
          }),
        });
        const payload = await response.json();
        if (!payload.success) {
          throw new Error(payload.error?.message ?? "配置保存失败");
        }

        const nextProviders = payload.data?.providers ?? [];
        const savedProviderId = payload.data?.savedProviderId ?? values.id ?? "";
        hydrateFromSavedProviders(nextProviders, savedProviderId);
        toast.success(overwriteExisting ? "服务配置已保存" : "已另存为新的服务配置");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "配置保存失败");
      } finally {
        setLoading(null);
      }
    })();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <CardHeader>
          <CardTitle>模型服务连接</CardTitle>
          <CardDescription>当前账号独立保存服务、Key 和默认模型，不会影响其他登录用户。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-3 rounded-3xl border border-border bg-muted/40 p-4">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-medium">快捷读取已保存服务</h3>
            </div>
            <div className="flex flex-col gap-3 md:flex-row">
              <div className="flex-1 space-y-2">
                <Label htmlFor="provider-history">历史服务</Label>
                <div className="relative">
                  <select
                    id="provider-history"
                    className="flex h-10 w-full appearance-none rounded-xl border border-input bg-background px-3 pr-10 text-sm text-foreground dark:bg-black/30"
                    value={selectedProviderId}
                    onChange={(event) => setSelectedProviderId(event.target.value)}
                  >
                    {providers.length === 0 ? <option value="">暂无已保存服务</option> : null}
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name} / {isManagedGatewayProvider(provider) ? "自动配置" : provider.baseUrl}
                      </option>
                    ))}
                  </select>
                  <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => selectedProviderId && setSelectedProviderId(selectedProviderId)}
                  disabled={!selectedProviderId}
                >
                  读取到表单
                </Button>
                <Button
                  type="button"
                  variant={selectedProvider?.isActive ? "secondary" : "default"}
                  onClick={() => selectedProviderId && handleActivateProvider(selectedProviderId)}
                  disabled={!selectedProviderId || selectedProvider?.isActive || switchingProviderId !== null}
                >
                  {switchingProviderId === selectedProviderId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {selectedProvider?.isActive ? "当前使用中" : "切换为当前服务"}
                </Button>
              </div>
            </div>
            {selectedProvider ? (
              <div className="rounded-2xl border border-border bg-background p-4 dark:bg-black/20">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{selectedProvider.name}</p>
                  {selectedProvider.isActive ? <Badge variant="success">当前服务</Badge> : null}
                  {selectedProviderIsManaged ? <Badge variant="success">自动 Key 托管</Badge> : null}
                  {unavailableModelCount > 0 ? <Badge variant="destructive">{unavailableModelCount} 个不可用</Badge> : null}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{selectedProvider.baseUrl}</p>
                <p className="mt-1 text-xs text-muted-foreground">Key：{selectedProvider.maskedApiKey || "未显示"}</p>
                <p className="mt-1 text-xs text-muted-foreground">最近更新：{formatTimeLabel(selectedProvider.updatedAt)}</p>
                {selectedProviderIsManaged ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    此服务由当前登录账号自动维护，刷新模型会同步 SubRouter 当前账号权限，并保留仍然存在的默认模型选择。
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                还没有保存过服务配置。首次保存后，这里可以直接读取并快速切换。
              </div>
            )}
          </div>

          {selectedProviderIsManaged ? (
            <div className="rounded-3xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/10">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
                    <h3 className="font-medium text-emerald-950 dark:text-emerald-100">SubRouter 托管账号</h3>
                  </div>
                  <p className="text-sm text-emerald-800 dark:text-emerald-200">
                    {gatewayStatusLoading
                      ? "正在读取当前账号状态..."
                      : gatewayStatus?.account?.displayName || gatewayStatus?.account?.username || gatewayStatus?.account?.email || "已绑定当前登录账号"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={gatewayStatus?.connected !== false ? "success" : "warning"}>
                    {gatewayStatus?.connected !== false ? "网关已连接" : "网关未连接"}
                  </Badge>
                  <Badge variant={gatewayStatus?.account?.apiKeyReady !== false ? "success" : "warning"}>
                    {gatewayStatus?.account?.apiKeyReady !== false ? "自动 Key 就绪" : "Key 未就绪"}
                  </Badge>
                  <Badge variant="outline">{gatewayStatus?.models?.length ?? models.length} 个网关模型</Badge>
                </div>
              </div>
              {gatewayStatusError ? (
                <div className="mt-3 rounded-2xl border border-rose-200 bg-white/80 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-black/20 dark:text-rose-300">
                  {gatewayStatusError}
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-3">
                <Button type="button" variant="secondary" onClick={handleRefreshGatewayModels} disabled={loading !== null}>
                  {loading === "refreshGateway" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  刷新 SubRouter 模型
                </Button>
                <Button type="button" onClick={handleSaveDefaults} disabled={loading !== null || models.length === 0 || !selectedProvider?.id}>
                  {loading === "saveDefaults" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  保存默认模型
                </Button>
              </div>
            </div>
          ) : null}

          <form autoComplete="off" className="grid gap-4 md:grid-cols-2" onSubmit={(event) => event.preventDefault()}>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-name">服务名称</Label>
              <Input
                id="provider-name"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                placeholder="例如：OpenRouter / Gemini Gateway / 自建兼容网关"
                disabled={selectedProviderIsManaged}
                {...form.register("name")}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-base-url">baseURL</Label>
              <Input
                id="provider-base-url"
                inputMode="url"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                placeholder="https://your-provider.example/v1"
                disabled={selectedProviderIsManaged}
                {...form.register("baseUrl")}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-api-key">API Key</Label>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                placeholder="可留空；系统会自动复用当前服务已保存的 API Key"
                disabled={selectedProviderIsManaged}
                {...form.register("apiKey")}
              />
              <p className="text-xs text-muted-foreground">
                选择历史服务后，名称、URL 和 Key 会回填到表单；修改后可以覆盖保存，也可以另存为新的服务配置。
              </p>
            </div>
          </form>

          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" onClick={handleTest} disabled={loading !== null || selectedProviderIsManaged}>
              {loading === "test" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlugZap className="mr-2 h-4 w-4" />}
              测试连接
            </Button>
            <Button type="button" variant="secondary" onClick={handleDiscover} disabled={loading !== null || selectedProviderIsManaged}>
              {loading === "discover" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              发现模型并识别能力
            </Button>
            <Button type="button" onClick={() => saveProvider(true)} disabled={loading !== null || models.length === 0 || selectedProviderIsManaged}>
              {loading === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {selectedProvider ? "覆盖保存当前服务" : "保存当前配置"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => saveProvider(false)}
              disabled={loading !== null || models.length === 0 || selectedProviderIsManaged}
            >
              {loading === "saveAsNew" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CopyPlus className="mr-2 h-4 w-4" />}
              另存为新服务
            </Button>
            {!selectedProviderIsManaged ? (
              <Button type="button" variant="outline" onClick={handleSaveDefaults} disabled={loading !== null || models.length === 0 || !selectedProvider?.id}>
                {loading === "saveDefaults" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                仅保存默认模型
              </Button>
            ) : null}
          </div>

          {models.length > 0 ? (
            <div className="space-y-4 rounded-3xl bg-muted/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">默认模型类型分配</h3>
                  <Badge>{models.length} 个模型</Badge>
                  <Badge variant={selectedDefaultCount >= 2 ? "success" : "warning"}>{selectedDefaultCount} 项已选择</Badge>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={handleAutoFillDefaults}>
                  按能力自动填充
                </Button>
              </div>

              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                <div className="rounded-2xl border border-border bg-background px-3 py-2 dark:bg-black/20">文本：{modelSummary.text}</div>
                <div className="rounded-2xl border border-border bg-background px-3 py-2 dark:bg-black/20">识图：{modelSummary.vision}</div>
                <div className="rounded-2xl border border-border bg-background px-3 py-2 dark:bg-black/20">生图：{modelSummary.imageGeneration}</div>
                <div className="rounded-2xl border border-border bg-background px-3 py-2 dark:bg-black/20">修图：{modelSummary.imageEdit}</div>
              </div>

              {availableImageModels.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                  当前 Provider 尚未识别到图像生成模型，头图和详情图角色会被禁用。
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                {modelTypeFields.map((field) => {
                  const options = getModelsForType(models, field.key);
                  const selectedValue = getTypeDefaultValue(defaults, field.key);

                  return (
                    <div key={field.key} className="space-y-2">
                      <Label>{field.label}</Label>
                      <select
                        className="flex h-10 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground dark:bg-black/30"
                        value={selectedValue}
                        disabled={options.length === 0}
                        onChange={(event) =>
                          setDefaults((current) => setTypeDefaultValue(current, field.key, event.target.value))
                        }
                      >
                        <option value="">{options.length === 0 ? "暂无此类型模型" : "未选择"}</option>
                        {options.map((model) => (
                          <option key={field.key + "-" + model.modelId} value={model.modelId}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型能力分组</CardTitle>
          <CardDescription>按功能类型聚合模型，避免大量模型逐条铺开。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {models.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              {selectedProviderIsManaged ? "点击左侧“刷新 SubRouter 模型”后，系统会在这里展示当前账号可用的模型。" : "先测试并发现模型，系统会在这里按能力类型展示可用模型。"}
            </div>
          ) : (
            <div className="grid gap-4">
              {capabilityGroups.map((group) => {
                const visibleModels = group.models.slice(0, 18);
                const hiddenCount = Math.max(0, group.models.length - visibleModels.length);
                const isPassiveImageGroup = group.key === "image_gen" || group.key === "image_edit";

                return (
                  <div key={group.key} className="rounded-3xl border border-border p-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{group.label}</h3>
                        <Badge variant="outline">{group.models.length} 个模型</Badge>
                        {isPassiveImageGroup ? <Badge variant="outline">未实测端点</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {visibleModels.map((model) => (
                        <Badge
                          key={group.key + "-" + model.modelId}
                          variant={model.isAvailable === false ? "destructive" : "outline"}
                          className="max-w-full truncate"
                          title={model.endpointSupport?.note ?? undefined}
                        >
                          {model.label}
                        </Badge>
                      ))}
                      {hiddenCount > 0 ? <Badge>+ {hiddenCount} 个</Badge> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
