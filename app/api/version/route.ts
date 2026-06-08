import { ok } from "@/lib/utils/route";

export async function GET() {
  return ok({
    app: "banana-mall",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_COMMIT_SHA ?? null,
    deployedAt: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
  });
}
