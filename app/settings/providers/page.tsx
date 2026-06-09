import ProviderSettingsPageClient from "@/components/providers/provider-settings-page-client";
import { getCurrentAdmin } from "@/lib/auth/admin";
import { notFound } from "next/navigation";

export default async function ProviderSettingsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) notFound();

  return <ProviderSettingsPageClient />;
}
