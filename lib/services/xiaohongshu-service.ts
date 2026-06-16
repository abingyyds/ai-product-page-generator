import { z } from "zod";

import { xiaohongshuPlanSchema, type XiaohongshuPlan } from "@/lib/ai/schemas/xiaohongshu";
import type { ImageGenerationResult } from "@/lib/ai/provider-client";
import { getProviderAdapter } from "@/lib/services/provider-service";

export type XiaohongshuPlanInput = {
  topic: string;
  images?: string[];
};

const rawXiaohongshuPlanSchema = z.unknown();
const minPageCount = 5;
const maxPageCount = 8;

function buildXiaohongshuPrompt(input: XiaohongshuPlanInput) {
  return [
    "You are a senior Xiaohongshu content strategist and visual director.",
    "Return strict JSON only. Do not wrap the response in markdown.",
    "Create a complete carousel graphic post plan for a mobile 3:4 Xiaohongshu layout.",
    "The result must be immediately usable by a designer or image generation agent.",
    "",
    "Required JSON shape:",
    '- Top-level keys: "topic", "audience", "coreInsight", "titleOptions", "coverTitle", "coverSubtitle", "pages", "caption", "hashtags", "exportNote".',
    '- "titleOptions" must contain 3 to 8 strings.',
    '- "hashtags" must contain 5 to 12 Chinese tags.',
    '- "pages" must contain 5 to 8 objects.',
    '- Every page object must contain "pageNumber", "title", "subtitle", "body", "visualDirection", "layout", "imagePrompt", and "negativePrompt".',
    "",
    "Requirements:",
    "- Write in Simplified Chinese.",
    "- Create 5 to 8 pages including cover, insight/value pages, practical steps, and a final summary or CTA page.",
    "- Every page needs a concrete visual direction, layout, text hierarchy, and negativePrompt.",
    "- Every page also needs imagePrompt: a complete prompt that can be sent directly to an image generation model after the user edits it.",
    "- Avoid vague image directions. Mention foreground, background, key objects, crop, color atmosphere, and text placement.",
    "- Include realistic constraints when the topic involves products, bodies, tools, food, appliances, wires, airflow, liquids, heat, light, weight, or motion.",
    "- Do not make impossible physical phenomena: reversed airflow, cables disappearing into furniture, floating unsupported objects, liquid flowing upward, handles/doors opening through solid parts, or hands passing through objects.",
    "- Avoid absolute medical, legal, financial, or guaranteed-result claims.",
    "- Caption should feel native to Xiaohongshu: useful, lightly conversational, and skimmable.",
    "- Hashtags should be Chinese, without spaces.",
    input.images?.length
      ? "- The user uploaded reference images. Analyze the product/object/style shown in those images and reflect them in page strategy, visualDirection, imagePrompt, and negativePrompt."
      : "- No reference image was uploaded; infer the visual plan from the topic only.",
    "",
    `Topic: ${input.topic}`,
  ].join("\n");
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getRecordValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}

function cleanText(value: string) {
  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function stripListPrefix(value: string) {
  return value.replace(/^\s*(?:[-*•]|\d+[.)、]|[一二三四五六七八九十]+[、.])\s*/, "").trim();
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return cleanText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return cleanText(value.map(textFromUnknown).filter(Boolean).join("\n"));
  }

  const record = asRecord(value);
  if (record) {
    return cleanText(Object.values(record).map(textFromUnknown).filter(Boolean).join("\n"));
  }

  return "";
}

function listFromText(value: string) {
  const normalized = cleanText(value);
  if (!normalized) {
    return [];
  }

  const separator = normalized.includes("#") ? /[#\s]+/ : /\r?\n|[，,、;；]/;
  return normalized
    .split(separator)
    .map(stripListPrefix)
    .filter(Boolean);
}

function textArrayFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = textFromUnknown(item);
      return text.includes("\n") ? listFromText(text) : [text].filter(Boolean);
    });
  }

  const record = asRecord(value);
  if (record) {
    return Object.values(record).flatMap(textArrayFromUnknown);
  }

  if (typeof value === "string") {
    return listFromText(value);
  }

  const text = textFromUnknown(value);
  return text ? [text] : [];
}

function pickText(record: Record<string, unknown>, keys: string[]) {
  return textFromUnknown(getRecordValue(record, keys));
}

function pickTextArray(record: Record<string, unknown>, keys: string[]) {
  return textArrayFromUnknown(getRecordValue(record, keys));
}

function positiveIntFromUnknown(value: unknown) {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[^\d.-]/g, ""))
        : Number.NaN;

  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return null;
  }

  return Math.floor(numberValue);
}

function dedupeText(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = cleanText(value);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function ensureTextRange(values: string[], fallbackValues: string[], min: number, max: number) {
  const result = dedupeText([...values, ...fallbackValues]).slice(0, max);

  let fallbackIndex = 0;
  while (result.length < min) {
    result.push(fallbackValues[fallbackIndex % fallbackValues.length] ?? `补充内容 ${result.length + 1}`);
    fallbackIndex += 1;
  }

  return result.slice(0, max);
}

function compactTopicTag(topic: string) {
  return topic.replace(/[#\s，,。.!！?？、;；:：/\\]+/g, "").slice(0, 12) || "小红书图文";
}

function buildFallbackPages(topic: string): XiaohongshuPlan["pages"] {
  return [
    {
      pageNumber: 1,
      title: `${topic}，夏日高级感这样拿捏`,
      subtitle: "封面钩子：一眼清爽、显贵、不费力",
      body: "把重点放在版型、面料、颜色和场景搭配，让读者快速知道这篇值得收藏。",
      visualDirection: "竖版 3:4 封面，主体居中，浅色夏日背景，保留大面积留白，标题在上方或左侧清晰排版。",
      layout: "封面大标题 + 1 句副标题 + 1 个核心视觉主体，文字不超过三层。",
      imagePrompt: `小红书 3:4 封面图，主题是“${topic}”，夏日清爽高级感，主体清晰，背景简洁，有中文大标题和短副标题，留白充足，真实可发布的图文封面。`,
      negativePrompt: "避免文字乱码、过度堆叠、主体变形、背景杂乱、低清晰度、夸张滤镜。",
    },
    {
      pageNumber: 2,
      title: "先看氛围：高级感来自这 3 点",
      subtitle: "颜色、线条、留白",
      body: "优先选择低饱和配色、干净轮廓和轻盈材质；搭配上减少复杂元素，让整体更显质感。",
      visualDirection: "三栏信息页，每栏用一个局部细节或搭配画面表达，整体色彩克制、干净。",
      layout: "顶部标题，下方三点并列，每点配短句和细节图。",
      imagePrompt: `小红书 3:4 信息页，围绕“${topic}”拆解高级感来源，三栏结构，包含颜色、线条、留白三个中文要点，画面清爽有质感。`,
      negativePrompt: "避免元素过密、字太小、廉价贴纸感、错误中文、透视混乱。",
    },
    {
      pageNumber: 3,
      title: "挑选公式：先版型，再细节",
      subtitle: "照着这个顺序不容易踩雷",
      body: "先判断是否适合自己的身形和使用场景，再看细节做工、颜色耐看度和搭配空间。",
      visualDirection: "流程型页面，用箭头或步骤卡展示挑选顺序，配局部细节示意。",
      layout: "标题 + 4 步流程 + 右侧或底部细节视觉。",
      imagePrompt: `小红书 3:4 教程页，主题“${topic}”的挑选公式，中文步骤清晰：版型、材质、颜色、搭配，画面像真实穿搭或好物攻略。`,
      negativePrompt: "避免步骤错乱、箭头穿模、文字重叠、细节失真。",
    },
    {
      pageNumber: 4,
      title: "搭配场景：通勤、约会、旅行都能用",
      subtitle: "一件单品延展多种氛围",
      body: "用鞋包、配饰和外搭改变风格；同一主题可以做出清爽通勤、温柔约会和松弛度假感。",
      visualDirection: "场景拼贴页，三个场景分区，人物或产品主体比例稳定，配色统一。",
      layout: "三场景分区 + 每区 1 句搭配建议。",
      imagePrompt: `小红书 3:4 场景搭配页，展示“${topic}”在通勤、约会、旅行三个场景中的高级感搭配，中文标签清晰，真实生活质感。`,
      negativePrompt: "避免人物肢体异常、产品细节错误、场景混乱、文字被遮挡。",
    },
    {
      pageNumber: 5,
      title: "收藏清单：照着买更省心",
      subtitle: "最后一页做决策总结",
      body: "总结最值得关注的选择标准，并提醒读者按自己的预算、身形和真实使用频率做取舍。",
      visualDirection: "总结清单页，重点信息用勾选项呈现，底部放轻 CTA。",
      layout: "标题 + 5 条 checklist + 收藏/评论 CTA。",
      imagePrompt: `小红书 3:4 总结清单页，主题“${topic}”，包含中文 checklist、收藏提示和简洁 CTA，设计清爽高级。`,
      negativePrompt: "避免绝对化承诺、夸张功效、价格误导、文字乱码、排版拥挤。",
    },
  ];
}

function fallbackTitleOptions(topic: string) {
  return [
    `${topic}：高级感这样选`,
    `夏日显气质的 ${topic} 攻略`,
    `${topic} 收藏清单，一篇讲清楚`,
  ];
}

function fallbackHashtags(topic: string) {
  return [compactTopicTag(topic), "夏日穿搭", "高级感", "种草笔记", "穿搭灵感", "好物推荐"];
}

function unwrapPlanRecord(value: unknown) {
  if (Array.isArray(value)) {
    return { pages: value };
  }

  const root = asRecord(value);
  if (!root) {
    return null;
  }

  for (const key of ["plan", "data", "result", "output", "content"]) {
    const nested = asRecord(root[key]);
    if (nested) {
      return nested;
    }
  }

  return root;
}

function extractRawPages(record: Record<string, unknown>) {
  const pagesValue = getRecordValue(record, [
    "pages",
    "slides",
    "carouselPages",
    "pageScripts",
    "page_scripts",
    "分页脚本",
    "页面",
  ]);

  if (Array.isArray(pagesValue)) {
    return pagesValue;
  }

  const pagesRecord = asRecord(pagesValue);
  if (pagesRecord) {
    return Object.values(pagesRecord);
  }

  return [];
}

function normalizePage(
  raw: unknown,
  index: number,
  topic: string,
  fallback: XiaohongshuPlan["pages"][number],
) {
  const record = asRecord(raw);
  const rawText = record ? "" : textFromUnknown(raw);
  const title =
    (record ? pickText(record, ["title", "heading", "pageTitle", "page_title", "标题"]) : rawText.split("\n")[0]) ||
    fallback.title;
  const subtitle =
    (record ? pickText(record, ["subtitle", "subTitle", "sub_title", "副标题"]) : "") || fallback.subtitle;
  const body =
    (record ? pickText(record, ["body", "copy", "content", "text", "points", "正文", "文案"]) : rawText) ||
    fallback.body;
  const visualDirection =
    (record
      ? pickText(record, [
          "visualDirection",
          "visual_direction",
          "visual",
          "scene",
          "imageDescription",
          "image_description",
          "画面",
          "视觉方向",
        ])
      : "") || fallback.visualDirection;
  const layout =
    (record ? pickText(record, ["layout", "layoutDescription", "layout_description", "composition", "版式", "布局"]) : "") ||
    fallback.layout;
  const imagePrompt =
    (record ? pickText(record, ["imagePrompt", "image_prompt", "prompt", "图像提示词", "生图提示词"]) : "") ||
    `小红书 3:4 图文第 ${index + 1} 页，主题“${topic}”，标题“${title}”，正文要点“${body}”，画面方向：${visualDirection}，版式：${layout}。`;
  const negativePrompt =
    (record ? pickText(record, ["negativePrompt", "negative_prompt", "negative", "avoid", "禁止", "避免"]) : "") ||
    fallback.negativePrompt;

  return {
    pageNumber:
      (record
        ? positiveIntFromUnknown(getRecordValue(record, ["pageNumber", "page_number", "page", "index", "页码"]))
        : null) ?? index + 1,
    title,
    subtitle,
    body,
    visualDirection,
    layout,
    imagePrompt,
    negativePrompt,
  };
}

function normalizeXiaohongshuPlan(raw: unknown, topic: string): XiaohongshuPlan {
  const record = unwrapPlanRecord(raw);
  if (!record) {
    throw new Error("AI 返回的小红书图文规划不是有效 JSON 对象，请重试。");
  }

  const fallbackPages = buildFallbackPages(topic);
  const fallbackLastPage = fallbackPages[fallbackPages.length - 1]!;
  const rawPages = extractRawPages(record);
  const pages = rawPages
    .slice(0, maxPageCount)
    .map((page, index) => normalizePage(page, index, topic, fallbackPages[index] ?? fallbackLastPage));

  while (pages.length < minPageCount) {
    const fallback = fallbackPages[pages.length] ?? fallbackLastPage;
    pages.push({ ...fallback, pageNumber: pages.length + 1 });
  }

  const normalized = {
    topic: pickText(record, ["topic", "theme", "subject", "选题", "主题"]) || topic,
    audience:
      pickText(record, ["audience", "targetAudience", "target_audience", "用户人群", "目标人群", "人群", "适用人群"]) ||
      "关注穿搭质感、希望快速获得可执行建议的小红书用户",
    coreInsight:
      pickText(record, ["coreInsight", "core_insight", "insight", "核心洞察", "洞察"]) ||
      `围绕“${topic}”提供可直接照做的选择和搭配思路，降低读者决策成本。`,
    titleOptions: ensureTextRange(
      pickTextArray(record, ["titleOptions", "title_options", "titles", "标题备选", "标题选项"]),
      fallbackTitleOptions(topic),
      3,
      8,
    ),
    coverTitle:
      pickText(record, ["coverTitle", "cover_title", "title", "封面标题"]) || `${topic}，高级感这样做`,
    coverSubtitle:
      pickText(record, ["coverSubtitle", "cover_subtitle", "subtitle", "封面副标题"]) ||
      "清爽、显气质、照着用",
    pages: pages.map((page, index) => ({ ...page, pageNumber: index + 1 })),
    caption:
      pickText(record, ["caption", "postCaption", "post_caption", "copywriting", "发布文案", "文案"]) ||
      `整理了一份“${topic}”小红书图文脚本，从选择逻辑到搭配场景都拆好了，适合直接继续改图生成。\n\n你会先看哪一页？`,
    hashtags: ensureTextRange(
      pickTextArray(record, ["hashtags", "tags", "topics", "话题标签", "标签"]),
      fallbackHashtags(topic),
      5,
      12,
    ).map((tag) => tag.replace(/^#+/, "").replace(/\s+/g, "")),
    exportNote:
      pickText(record, ["exportNote", "export_note", "note", "备注", "导出备注"]) ||
      "已自动补齐为可继续生成图片的标准小红书图文规划。",
  };

  const parsed = xiaohongshuPlanSchema.safeParse(normalized);
  if (!parsed.success) {
    console.error("[Xiaohongshu] Normalized plan validation failed", parsed.error.flatten());
    throw new Error(
      "AI 返回的小红书图文规划格式不完整，已尝试自动修复但仍未通过校验。请重试，或在 AI 配置里换用更稳定的文本模型。",
    );
  }

  return parsed.data;
}

function imageResultToUrl(result: ImageGenerationResult) {
  if (result.b64Json) {
    return `data:image/png;base64,${result.b64Json}`;
  }

  if (result.url) {
    return result.url;
  }

  throw new Error("图像模型没有返回可用图片。");
}

function unique(values: Array<string | null | undefined>) {
  return values.filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
}

function getImageGenerationModels(provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"]) {
  return unique([
    provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
    provider.models.find((item) => item.isDefaultDetailImage)?.modelId,
    provider.models.find((item) => Boolean((item.capabilities as Record<string, boolean>).image_gen))?.modelId,
  ]);
}

function getImageEditModels(provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"]) {
  return unique([
    provider.models.find((item) => item.isDefaultImageEdit)?.modelId,
    provider.models.find((item) => Boolean((item.capabilities as Record<string, boolean>).image_edit))?.modelId,
    provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
  ]);
}

function buildPageImagePrompt(plan: XiaohongshuPlan, page: XiaohongshuPlan["pages"][number]) {
  const basePrompt =
    page.imagePrompt.trim() ||
    [
      `小红书 3:4 图文第 ${page.pageNumber} 页。`,
      `页面标题：${page.title}`,
      page.subtitle ? `副标题：${page.subtitle}` : "",
      `正文要点：${page.body}`,
      `画面描述：${page.visualDirection}`,
      `版式：${page.layout}`,
      page.negativePrompt ? `禁止：${page.negativePrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  return [
    basePrompt,
    "",
    "生成一张适合小红书图文轮播的竖版 3:4 图片。",
    "图内必须包含中文标题、核心短句和必要的视觉信息层级，文字要清晰、不要乱码、不要挤压。",
    "整体要像真实可发布的小红书图文页，而不是网页截图或空白海报。",
    `整组内容主题：${plan.topic}`,
    `目标人群：${plan.audience}`,
    `核心洞察：${plan.coreInsight}`,
  ].join("\n");
}

async function runImageModel<T>(
  models: string[],
  runner: (model: string) => Promise<T>,
  emptyMessage: string,
) {
  const errors: string[] = [];

  for (const model of models) {
    try {
      return { model, result: await runner(model) };
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  throw new Error(models.length === 0 ? emptyMessage : errors.join(" | "));
}

export async function planXiaohongshuPost(input: XiaohongshuPlanInput) {
  const topic = input.topic.trim();
  if (!topic) {
    throw new Error("请输入小红书图文选题。");
  }

  const { provider, adapter } = await getProviderAdapter();
  const model =
    provider.models.find((item) => item.isDefaultPlanning)?.modelId ??
    provider.models.find((item) => (item.capabilities as Record<string, boolean>).structured_output)?.modelId ??
    provider.models.find((item) => (item.capabilities as Record<string, boolean>).text)?.modelId;

  if (!model) {
    throw new Error("当前没有可用的小红书图文规划模型。");
  }

  const result = await adapter.generateStructured({
    model,
    systemPrompt: "Return strict JSON only.",
    userPrompt: buildXiaohongshuPrompt({ topic, images: input.images }),
    images: input.images,
    schema: rawXiaohongshuPlanSchema,
    timeoutMs: 300000,
    monitor: {
      operation: "xiaohongshu_planning",
    },
  });

  return normalizeXiaohongshuPlan(result.parsed, topic);
}

export async function generateXiaohongshuImages(plan: XiaohongshuPlan, referenceImages: string[] = []) {
  const { provider, adapter } = await getProviderAdapter();
  const models = getImageGenerationModels(provider);

  const images = [];
  for (const page of plan.pages) {
    const prompt = buildPageImagePrompt(plan, page);
    const generated = await runImageModel(
      models,
      (model) =>
        adapter.generateImage({
          model,
          prompt,
          aspectRatio: "3:4",
          referenceImages,
          monitor: {
            operation: "xiaohongshu_image_generate",
          },
        }),
      "当前没有可用的小红书图像生成模型。",
    );

    images.push({
      pageNumber: page.pageNumber,
      title: page.title,
      prompt,
      model: generated.model,
      imageUrl: imageResultToUrl(generated.result),
      revisedPrompt: generated.result.revisedPrompt ?? "",
      updatedAt: new Date().toISOString(),
    });
  }

  return images;
}

export async function editXiaohongshuImage(input: {
  imageUrl: string;
  prompt: string;
  page?: XiaohongshuPlan["pages"][number] | null;
}) {
  const { provider, adapter } = await getProviderAdapter();
  const models = getImageEditModels(provider);
  const prompt = [
    input.prompt,
    "",
    input.page ? `当前页标题：${input.page.title}` : "",
    input.page ? `当前页正文：${input.page.body}` : "",
    "保留原图的小红书 3:4 图文风格和主体结构，只修改用户指出的问题。",
    "中文文字必须清晰，不要产生乱码，不要把文字压到边缘。",
  ]
    .filter(Boolean)
    .join("\n");

  const edited = await runImageModel(
    models,
    (model) =>
      adapter.editImage({
        model,
        image: input.imageUrl,
        prompt,
        aspectRatio: "3:4",
        monitor: {
          operation: "xiaohongshu_image_edit",
        },
      }),
    "当前没有可用的小红书图像编辑模型。",
  );

  return {
    imageUrl: imageResultToUrl(edited.result),
    model: edited.model,
    revisedPrompt: edited.result.revisedPrompt ?? "",
    updatedAt: new Date().toISOString(),
  };
}
