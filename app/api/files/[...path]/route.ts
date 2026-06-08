import { NextRequest } from "next/server";

import { requireCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { readStorageFile } from "@/lib/storage/asset-manager";
import { handleRouteError } from "@/lib/utils/route";

function getContentType(pathname: string) {
  const normalized = pathname.toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (normalized.endsWith(".json")) return "application/json; charset=utf-8";
  if (normalized.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

export async function GET(
  request: NextRequest,
  context: { params: { path: string[] } },
) {
  try {
    const user = await requireCurrentUser(request);
    const relativePath = context.params.path.join("/");
    const asset = await prisma.productAsset.findFirst({
      where: {
        filePath: relativePath,
        project: {
          userId: user.id,
        },
      },
      select: { id: true },
    });

    if (!asset) {
      throw new Error("Asset not found.");
    }

    const buffer = await readStorageFile(relativePath);
    const contentType = getContentType(relativePath);

    return new Response(buffer, {
      headers: {
        "Content-Type": String(contentType),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
