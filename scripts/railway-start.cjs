const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function volumeRoot() {
  return process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.APP_DATA_DIR || "/app/data";
}

function ensureRuntimeEnv() {
  const root = volumeRoot();
  const storageRoot = process.env.STORAGE_ROOT || path.join(root, "storage");
  const databasePath = path.join(root, "db", "banana-mall.db");

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${databasePath}`;
  process.env.STORAGE_ROOT = storageRoot;
  process.env.APP_RUNTIME = process.env.APP_RUNTIME || "web";
  process.env.HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
  process.env.PORT = process.env.PORT || "3000";
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  ensureRuntimeEnv();
  await runNode(["scripts/apply-prisma-migrations.cjs"]);
  await runNode(["server.js"]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
