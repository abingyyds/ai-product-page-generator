"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { Loader2, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
          ...(twoFactorCode.trim() ? { twoFactorCode: twoFactorCode.trim() } : {}),
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        if (payload.error?.code === "GATEWAY_TWO_FACTOR_REQUIRED") setRequiresTwoFactor(true);
        throw new Error(payload.error?.message ?? "登录失败");
      }

      const next = searchParams.get("next");
      router.replace(next && next.startsWith("/") ? next : "/settings/providers?onboarding=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md border-white/80 bg-white/82 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-[#101012]/88">
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm dark:border-white/10">
            <img src="/brand-icon.ico" alt="banana-mall" className="h-full w-full object-cover" />
          </div>
          <div>
            <CardTitle className="text-xl">账号登录</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">使用平台账号进入工作台。</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="username">账号</Label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="邮箱或用户名"
              required
            />
          </div>
          {requiresTwoFactor ? (
            <div className="space-y-2">
              <Label htmlFor="twoFactorCode">双重验证码</Label>
              <Input
                id="twoFactorCode"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={twoFactorCode}
                onChange={(event) => setTwoFactorCode(event.target.value)}
                placeholder="请输入 2FA 验证码"
                required
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
              required
            />
          </div>
          {error ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/8 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <Button type="submit" className="w-full gap-2" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            登录
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
