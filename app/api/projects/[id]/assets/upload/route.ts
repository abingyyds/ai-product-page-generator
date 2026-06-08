import { NextRequest } from "next/server";
import { z } from "zod";

import { requireProjectAccess } from "@/lib/auth/authorization";
import { prisma } from "@/lib/db/prisma";
import { saveUploadAsset } from "@/lib/storage/asset-manager";
import { handleRouteError, ok } from "@/lib/utils/route";

const uploadAssetSchema = z.object({
  type: z.enum(["MAIN", "ANGLE", "DETAIL", "REFERENCE"]),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  base64Data: z.string().min(1),
});

const uploadTypeSchema = z.enum(["MAIN", "ANGLE", "DETAIL", "REFERENCE"]);

export const runtime = "nodejs";

function isFormDataUpload(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    typeof value.arrayBuffer === "function"
  );
}

async function parseUploadInput(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!isFormDataUpload(file)) {
      throw new Error("请上传有效的图片文件。");
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    if (fileBuffer.byteLength === 0) {
      throw new Error("上传文件为空，请重新选择图片。");
    }

    return {
      type: uploadTypeSchema.parse(formData.get("type")),
      fileName: String(formData.get("fileName") || file.name || "upload"),
      mimeType: String(formData.get("mimeType") || file.type || "application/octet-stream"),
      fileBuffer,
    };
  }

  const input = uploadAssetSchema.parse(await request.json());
  return {
    type: input.type,
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileBuffer: Buffer.from(input.base64Data, "base64"),
  };
}

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    await requireProjectAccess(context.params.id);
    const input = await parseUploadInput(request);
    const existingCount = await prisma.productAsset.count({
      where: { projectId: context.params.id },
    });

    const asset = await saveUploadAsset({
      projectId: context.params.id,
      type: input.type,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileBuffer: input.fileBuffer,
      sortOrder: existingCount,
      isMain: input.type === "MAIN",
    });

    return ok(asset, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
