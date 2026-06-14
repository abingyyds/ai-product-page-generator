import ProviderSettingsPageClient from "@/components/providers/provider-settings-page-client";
import { getCurrentUser } from "@/lib/auth/session";
import { notFound } from "next/navigation";

export default async function ProviderSettingsPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  return <ProviderSettingsPageClient />;
}
