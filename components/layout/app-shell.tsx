import Link from "next/link";
import { BookOpenText, FolderKanban, GalleryVerticalEnd, History, Images, Settings2, UserCircle2 } from "lucide-react";

import { LogoutButton } from "@/components/auth/logout-button";
import { ApiUsageIndicator } from "@/components/layout/api-usage-indicator";
import { FloatingThemeToggle } from "@/components/layout/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { isAppAdmin } from "@/lib/auth/admin";
import { getCurrentUser } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "快速开始", icon: FolderKanban },
  { href: "/batch-create", label: "批量创建", icon: Images },
  { href: "/history", label: "历史记录", icon: History },
  { href: "/xiaohongshu/plan", label: "小红书图文", icon: BookOpenText },
  { href: "/projects/new", label: "高级创建", icon: GalleryVerticalEnd },
  { href: "/settings/providers", label: "AI 模型设置", icon: Settings2 },
];

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const isAdmin = isAppAdmin(user);

  if (!user) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen text-slate-900 dark:text-slate-100">
      <div className="fixed bottom-4 left-4 z-[60]">
        <FloatingThemeToggle />
      </div>
      <div className="mx-auto min-h-screen max-w-[1600px] px-4 py-5 md:px-6">
        <aside
          className="scrollbar-hidden fixed top-5 z-40 hidden h-[calc(100vh-2.5rem)] w-72 overflow-y-auto rounded-[2rem] border border-white/70 bg-white/76 p-5 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-[#0b0b0c]/88 dark:shadow-[0_24px_60px_-38px_rgba(0,0,0,0.72)] md:flex md:flex-col"
          style={{ left: "max(1.5rem, calc((100vw - 1600px) / 2 + 1.5rem))" }}
        >
          <Link
            href="/"
            className="flex items-center gap-3 rounded-2xl border border-white/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(245,245,245,0.82))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
          >
            <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-white">
              <img src="/brand-icon.ico" alt="banana-mall" className="h-full w-full object-cover" />
            </div>
            <div>
              <p className="text-lg font-semibold tracking-[-0.03em] text-slate-950 dark:text-white">banana-mall</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">AI 电商详情页生成与编辑工作台</p>
            </div>
          </Link>

          <nav className="mt-6 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition-all duration-200",
                    "text-slate-600 hover:bg-white/85 hover:text-slate-950 hover:shadow-sm",
                    "dark:text-slate-300 dark:hover:bg-white/8 dark:hover:text-white",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto space-y-3">
            <div className="rounded-[2rem] border border-white/80 bg-white/68 p-5 text-slate-700 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-[#141416]/88 dark:text-slate-300">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Created By</p>
                  <p className="mt-2 text-base font-semibold tracking-[0.02em] text-slate-900 dark:text-white">
                    灵矩绘境 MatrixInspire Inc
                  </p>
                </div>
                <div className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500 dark:border-white/10 dark:bg-white/8 dark:text-slate-300">
                  V2
                </div>
              </div>

              <div className="mt-5 space-y-3">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-black/30">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400 dark:text-slate-500">公司</p>
                  <p className="mt-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                    灵矩绘境 MatrixInspire Inc
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-black/30">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400 dark:text-slate-500">开发者</p>
                  <p className="mt-2 text-sm font-medium text-slate-800 dark:text-slate-100">子圭时安 &amp; AI</p>
                </div>
              </div>

              <p className="mt-5 text-xs leading-6 text-slate-500 dark:text-slate-400">
                面向真实电商详情页工作流打造，从商品分析到规划、生成、编辑与导出，保持模块化与可扩展性。
              </p>
            </div>
          </div>
        </aside>

        <main className="min-w-0 rounded-[2rem] border border-white/80 bg-white/74 p-5 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-[#0f0f10]/82 dark:shadow-[0_24px_60px_-38px_rgba(0,0,0,0.78)] md:ml-[19.5rem] md:p-8">
          <div className="mb-6 flex flex-wrap items-center justify-end gap-3">
            <Link
              href="/settings/providers"
              className={cn(
                buttonVariants({ variant: "default" }),
                "h-10 gap-2 rounded-2xl px-3 shadow-sm",
              )}
            >
              <Settings2 className="h-4 w-4" />
              <span className="text-sm font-medium">AI 模型</span>
            </Link>
            <div className="flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 text-sm shadow-sm dark:border-white/10 dark:bg-black/30">
              <UserCircle2 className="h-4 w-4 text-slate-500 dark:text-slate-300" />
              <span className="max-w-[180px] truncate font-medium">{user.name ?? "当前账号"}</span>
            </div>
            {isAdmin ? (
              <>
                <Link
                  href="/monitor/usage"
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "h-10 gap-2 rounded-2xl border-slate-200 bg-white px-3 shadow-sm hover:bg-white dark:border-white/10 dark:bg-black/30 dark:hover:border-white/20 dark:hover:bg-white/8",
                  )}
                >
                  <span className="text-sm font-medium">API 监控</span>
                  <ApiUsageIndicator />
                </Link>
              </>
            ) : null}
            <LogoutButton />
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
