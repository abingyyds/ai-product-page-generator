"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ProviderSettings } from "@/components/providers/provider-settings";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";

type ProviderPageData = Array<{
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  maskedApiKey: string;
  isActive: boolean;
  updatedAt: string | Date;
  models: Array<{
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
  }>;
}>;

function LoadingState() {
  return (
    <Card>
      <CardContent className="flex min-h-[260px] items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载 AI 配置...
      </CardContent>
    </Card>
  );
}

export default function ProviderSettingsPageClient() {
  const [mounted, setMounted] = useState(false);
  const [providers, setProviders] = useState<ProviderPageData>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    let aborted = false;

    async function loadProviders() {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch("/api/providers", {
          cache: "no-store",
        });
        const payload = await response.json();

        if (!response.ok || !payload.success) {
          throw new Error(payload.error?.message ?? "加载 AI 配置失败");
        }

        if (!aborted) {
          setProviders(payload.data ?? []);
        }
      } catch (err) {
        if (!aborted) {
          setError(err instanceof Error ? err.message : "加载 AI 配置失败");
        }
      } finally {
        if (!aborted) {
          setLoading(false);
        }
      }
    }

    loadProviders();

    return () => {
      aborted = true;
    };
  }, [mounted]);

  if (!mounted) {
    return (
      <div className="space-y-8" suppressHydrationWarning>
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="space-y-8" suppressHydrationWarning>
      <PageHeader
        eyebrow="个人模型设置"
        title="AI 模型与可用性"
        description="每个登录账号都有独立的模型服务和默认模型选择。使用智能网关登录时，系统会自动托管 Key；你只需要刷新模型、检查状态并选择默认模型。"
      />

      {loading ? (
        <LoadingState />
      ) : error ? (
        <Card>
          <CardContent className="min-h-[180px] space-y-2 pt-6 text-sm">
            <p className="font-medium text-destructive">加载失败</p>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      ) : (
        <ProviderSettings initialProviders={providers} />
      )}
    </div>
  );
}
