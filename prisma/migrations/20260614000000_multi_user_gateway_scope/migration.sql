-- Scope gateway account lookup by distHost instead of forcing one account per baseUrl.
DROP INDEX IF EXISTS "GatewayAccount_userId_provider_baseUrl_key";
CREATE INDEX IF NOT EXISTS "GatewayAccount_userId_provider_baseUrl_distHost_idx" ON "GatewayAccount"("userId", "provider", "baseUrl", "distHost");
