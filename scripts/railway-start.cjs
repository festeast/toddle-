/**
 * Старт для Railway (стадия `railway` в Dockerfile): применяет миграции, при SEED_DEMO=true
 * заполняет пустую базу демо-данными, затем запускает Next.js. Миграции идемпотентны.
 */
const { spawnSync } = require("node:child_process");

function run(args, label) {
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`railway-start: ${label} завершилась с ошибкой (код ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

run(["node_modules/prisma/build/index.js", "migrate", "deploy"], "prisma migrate deploy");
run(["node_modules/tsx/dist/cli.mjs", "scripts/seed-if-empty.ts"], "seed-if-empty");

const port = process.env.PORT || "3000";
run(["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", port], "next start");
