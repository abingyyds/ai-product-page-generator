"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <Button type="button" variant="outline" size="sm" className="gap-2" onClick={logout}>
      <LogOut className="h-4 w-4" />
      退出
    </Button>
  );
}
