import { prisma } from "@/lib/db/prisma";
import { requireCurrentUser } from "@/lib/auth/session";

export async function requireProjectAccess(projectId: string) {
  const user = await requireCurrentUser();
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId: user.id },
    select: { id: true },
  });

  if (!project) {
    throw new Error("Project not found.");
  }

  return user;
}

export async function requireSectionAccess(sectionId: string) {
  const user = await requireCurrentUser();
  const section = await prisma.pageSection.findFirst({
    where: {
      id: sectionId,
      project: {
        userId: user.id,
      },
    },
    select: {
      id: true,
      projectId: true,
    },
  });

  if (!section) {
    throw new Error("Section not found.");
  }

  return { user, section };
}

export async function requireAssetAccess(assetId: string) {
  const user = await requireCurrentUser();
  const asset = await prisma.productAsset.findFirst({
    where: {
      id: assetId,
      project: {
        userId: user.id,
      },
    },
    select: {
      id: true,
      projectId: true,
    },
  });

  if (!asset) {
    throw new Error("Asset not found.");
  }

  return { user, asset };
}

export async function requireTaskAccess(taskId: string) {
  const user = await requireCurrentUser();
  const task = await prisma.generationTask.findFirst({
    where: {
      id: taskId,
      project: {
        userId: user.id,
      },
    },
    select: {
      id: true,
      projectId: true,
    },
  });

  if (!task) {
    throw new Error("Task not found.");
  }

  return { user, task };
}
