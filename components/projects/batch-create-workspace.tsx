"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Images, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fileToAssetUploadFormData } from "@/lib/utils/base64-upload";

function buildBatchProjectName(file: File, index: number) {
  const baseName = file.name.replace(/\.[^.]+$/, "").trim() || `批量商品-${index + 1}`;
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");

  return `${baseName}-${stamp}`;
}

type BatchStatus = {
  fileName: string;
  state: "pending" | "running" | "done" | "failed";
  message: string;
  projectId?: string;
};

export function BatchCreateWorkspace() {
  const router = useRouter();
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchStatuses, setBatchStatuses] = useState<BatchStatus[]>([]);

  function updateBatchStatus(index: number, patch: Partial<BatchStatus>) {
    setBatchStatuses((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  }

  async function createAnalyzedPlannedProject(fileItem: File, index: number) {
    let projectId: string | null = null;
    let uploadCompleted = false;

    try {
      const createResponse = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: buildBatchProjectName(fileItem, index),
          platform: "general_ecommerce",
          style: "generic_clean",
          description: "由批量创建自动生成",
        }),
      });
      const createdPayload = await createResponse.json();
      if (!createdPayload.success) {
        throw new Error(createdPayload.error?.message ?? "创建项目失败");
      }

      projectId = createdPayload.data.id as string;

      const uploadResponse = await fetch(`/api/projects/${projectId}/assets/upload`, {
        method: "POST",
        body: fileToAssetUploadFormData("MAIN", fileItem),
      });
      const uploadPayload = await uploadResponse.json();
      if (!uploadPayload.success) {
        throw new Error(uploadPayload.error?.message ?? "主商品图上传失败");
      }
      uploadCompleted = true;

      const analyzeResponse = await fetch(`/api/projects/${projectId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const analyzePayload = await analyzeResponse.json();
      if (!analyzePayload.success) {
        throw new Error(analyzePayload.error?.message ?? "商品分析失败");
      }

      const planResponse = await fetch(`/api/projects/${projectId}/plan-sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoDecideCounts: true }),
      });
      const planPayload = await planResponse.json();
      if (!planPayload.success) {
        throw new Error(planPayload.error?.message ?? "详情页规划失败");
      }

      return {
        projectId,
        analysisFallback: analyzePayload.data?.rawResult?.mode === "local_fallback",
        planningFallback: planPayload.data?.fallbackMode === "template_plan",
      };
    } catch (error) {
      if (projectId && !uploadCompleted) {
        await fetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => null);
      }
      throw error;
    }
  }

  async function handleBatchStart() {
    if (batchFiles.length === 0) {
      toast.error("请先批量上传产品图。");
      return;
    }

    setBatchSubmitting(true);
    setBatchStatuses(
      batchFiles.map((item) => ({
        fileName: item.name,
        state: "pending",
        message: "等待处理",
      })),
    );

    let successCount = 0;
    try {
      for (let index = 0; index < batchFiles.length; index += 1) {
        const fileItem = batchFiles[index];
        updateBatchStatus(index, { state: "running", message: "正在创建、分析并规划详情页" });
        try {
          const result = await createAnalyzedPlannedProject(fileItem, index);
          successCount += 1;
          updateBatchStatus(index, {
            state: "done",
            message:
              result.analysisFallback || result.planningFallback
                ? "已生成可编辑草稿与详情页规划"
                : "已完成分析与详情页规划",
            projectId: result.projectId,
          });
        } catch (error) {
          updateBatchStatus(index, {
            state: "failed",
            message: error instanceof Error ? error.message : "处理失败",
          });
        }
      }

      if (successCount > 0) {
        toast.success(`批量创建完成：${successCount}/${batchFiles.length} 个项目已生成详情页规划。`);
        router.push("/history");
      } else {
        toast.error("批量创建未完成，请检查失败原因后重试。");
      }
    } finally {
      setBatchSubmitting(false);
    }
  }

  const visibleStatuses =
    batchStatuses.length > 0
      ? batchStatuses
      : batchFiles.map((item) => ({
          fileName: item.name,
          state: "pending" as const,
          message: "待开始",
        }));

  return (
    <section className="mx-auto max-w-6xl space-y-8">
      <div className="grid gap-6 lg:grid-cols-[0.88fr_1.12fr]">
        <div className="rounded-[2rem] border border-slate-200 bg-white/84 p-6 shadow-soft backdrop-blur-xl dark:border-white/10 dark:bg-white/6 md:p-8">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-sm dark:border-white/10 dark:bg-black/30 dark:text-white">
                <Images className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-950 dark:text-white">批量上传产品图</h2>
                <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
                  每张图会生成一个独立项目，并自动完成商品分析和详情页规划。
                </p>
              </div>
            </div>

            <Input
              id="batch-create-files"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => setBatchFiles(Array.from(event.target.files ?? []))}
              className="hidden"
            />
            <label
              htmlFor="batch-create-files"
              className="flex min-h-[360px] cursor-pointer flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-300 bg-white/50 p-6 text-center transition hover:bg-slate-50/80 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Images className="h-11 w-11 text-slate-400" />
              <p className="mt-5 text-lg font-medium text-slate-900 dark:text-white">选择多个产品图</p>
              <p className="mt-2 max-w-md text-sm leading-7 text-slate-400 dark:text-slate-500">
                支持 JPG、PNG、WEBP。建议每张图片都是清晰主商品图，系统会按文件逐个处理。
              </p>
              {batchFiles.length > 0 ? (
                <p className="mt-5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 dark:border-white/10 dark:bg-black/30 dark:text-slate-300">
                  已选择 {batchFiles.length} 张图片
                </p>
              ) : null}
            </label>

            <Button
              type="button"
              onClick={handleBatchStart}
              disabled={batchSubmitting || batchFiles.length === 0}
              className="w-full rounded-full"
            >
              {batchSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
              {batchSubmitting ? "正在批量创建..." : "批量创建详情页"}
            </Button>
          </div>
        </div>

        <div className="rounded-[2rem] border border-slate-200 bg-white/84 p-6 shadow-soft backdrop-blur-xl dark:border-white/10 dark:bg-white/6 md:p-8">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-950 dark:text-white">处理进度</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                完成后会自动进入历史记录，你可以继续打开项目生成图片。
              </p>
            </div>
          </div>

          <div className="mt-5 min-h-[360px] rounded-[1.5rem] border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-black/20">
            {batchFiles.length === 0 ? (
              <div className="flex h-full min-h-[328px] items-center justify-center text-center text-sm leading-7 text-slate-400 dark:text-slate-500">
                上传后这里会显示每个文件的处理状态。
              </div>
            ) : (
              <div className="space-y-3">
                {visibleStatuses.map((item) => (
                  <div
                    key={item.fileName}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-white/10 dark:bg-white/[0.04]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-800 dark:text-slate-100">{item.fileName}</p>
                      <p className="mt-1 truncate text-xs text-slate-400 dark:text-slate-500">{item.message}</p>
                    </div>
                    <div className="shrink-0">
                      {item.state === "running" ? <Loader2 className="h-4 w-4 animate-spin text-slate-500" /> : null}
                      {item.state === "done" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
                      {item.state === "failed" ? <AlertCircle className="h-4 w-4 text-rose-500" /> : null}
                      {item.state === "pending" ? (
                        <span className="block h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
