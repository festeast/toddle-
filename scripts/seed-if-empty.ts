/**
 * Демо-заполнение только для пустой базы. Используется при сборке на Vercel (npm run vercel-build):
 * первый деплой заполняет базу вымышленными данными, последующие деплои данные не трогают.
 * Работает только при SEED_DEMO=true (иначе ничего не делает).
 */
import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";

async function main() {
  if (process.env.SEED_DEMO !== "true") {
    console.log("seed-if-empty: SEED_DEMO не включён — пропускаю");
    return;
  }
  const db = new PrismaClient();
  const schools = await db.school.count();
  await db.$disconnect();
  if (schools > 0) {
    console.log("seed-if-empty: в базе уже есть данные — пропускаю");
    return;
  }
  console.log("seed-if-empty: база пустая — заполняю демо-данными");
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"], {
    stdio: "inherit",
    env: { ...process.env, ALLOW_DEMO_SEED: "true" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
