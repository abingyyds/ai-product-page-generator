-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalProvider" TEXT,
    "externalUserId" TEXT,
    "username" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GatewayAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "externalUserId" TEXT,
    "username" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "sessionCookieEncrypted" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "apiKeyEncrypted" TEXT,
    "apiKeyId" TEXT,
    "modelsSnapshot" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GatewayAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "platform" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "description" TEXT,
    "modelSnapshot" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("createdAt", "description", "id", "modelSnapshot", "name", "platform", "status", "style", "updatedAt") SELECT "createdAt", "description", "id", "modelSnapshot", "name", "platform", "status", "style", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE TABLE "new_ProviderConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProviderConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProviderConfig" ("apiKeyEncrypted", "baseUrl", "createdAt", "id", "isActive", "name", "updatedAt") SELECT "apiKeyEncrypted", "baseUrl", "createdAt", "id", "isActive", "name", "updatedAt" FROM "ProviderConfig";
DROP TABLE "ProviderConfig";
ALTER TABLE "new_ProviderConfig" RENAME TO "ProviderConfig";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_externalProvider_externalUserId_key" ON "AppUser"("externalProvider", "externalUserId");

-- CreateIndex
CREATE INDEX "AppUser_username_idx" ON "AppUser"("username");

-- CreateIndex
CREATE INDEX "AppUser_email_idx" ON "AppUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayAccount_userId_provider_baseUrl_key" ON "GatewayAccount"("userId", "provider", "baseUrl");

-- CreateIndex
CREATE INDEX "GatewayAccount_userId_updatedAt_idx" ON "GatewayAccount"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ProviderConfig_userId_updatedAt_idx" ON "ProviderConfig"("userId", "updatedAt");
