# Демо-стенд: Supabase (база данных) + Vercel (сайт)

Быстрый способ получить работающий сайт со ссылкой. Обе службы бесплатны для старта. Займёт около 30 минут.

> ⚠️ Серверы Supabase и Vercel находятся **вне Казахстана**: здесь только **вымышленные демо-данные**. Реальные данные учеников — только на сервере в РК (`docs/ИНСТРУКЦИЯ.md`).

Схема: Vercel берёт код из GitHub, при каждой сборке применяет миграции к базе Supabase и при первом запуске заполняет базу демо-данными.

---

## Шаг 1. Влить новую версию в основную ветку GitHub

Vercel публикует основную ветку `main`, а новая версия пока лежит в ветке `claude/production-db-security`.

1. Откройте https://github.com/festeast/toddle-/compare/main...claude/production-db-security
2. Нажмите **Create pull request** и ещё раз **Create pull request**.
3. Нажмите **Merge pull request**, затем **Confirm merge**.

## Шаг 2. Создать базу данных в Supabase

1. Зайдите на **https://supabase.com** → **Start your project** → войдите через GitHub (**Continue with GitHub**).
2. **New project**:
   - **Organization** — ваша (создаётся автоматически);
   - **Project name** — `ib-journal`;
   - **Database Password** — нажмите **Generate a password** и **сохраните пароль** в надёжном месте: он понадобится в шаге 3;
   - **Region** — **Central EU (Frankfurt)**, ближайший к Казахстану;
   - **Create new project**. Подождите 1–2 минуты, пока проект создаётся.
3. Рекомендуется дополнительно отключить ненужный REST API. Он уже закрыт миграцией, это вторая линия защиты:
   **Project Settings** → **Data API** → выключите **Enable Data API** (или уберите `public` из *Exposed schemas*) → **Save**.
   Если такого пункта нет — пропустите шаг: доступ всё равно закрыт.

## Шаг 3. Скопировать адреса подключения

1. В проекте Supabase нажмите кнопку **Connect** вверху страницы.
2. Откройте вкладку **ORMs** и выберите **Prisma**. Будут показаны две строки:
   ```
   DATABASE_URL="postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
   DIRECT_URL="postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
   ```
3. Скопируйте обе строки в блокнот и замените `[YOUR-PASSWORD]` на пароль из шага 2 (квадратные скобки тоже убрать).
4. В конец **первой** строки допишите `&connection_limit=1`:
   `...:6543/postgres?pgbouncer=true&connection_limit=1`

Это пароль от базы — не публикуйте его и не отправляйте в чаты.

## Шаг 4. Подключить сайт в Vercel

1. Зайдите на **https://vercel.com** → **Sign Up** → **Continue with GitHub**. Тариф **Hobby** (бесплатный).
2. **Add New…** → **Project**.
3. В списке репозиториев найдите **toddle-** → **Import**.
   Если его нет: **Adjust GitHub App Permissions** → разрешите доступ к `festeast/toddle-`.
4. На экране настройки:
   - **Framework Preset**: Next.js — определится сам;
   - **Build Command** не меняйте: Vercel сам выполнит `vercel-build` (миграции, демо-данные и сборку);
   - раскройте **Environment Variables** и добавьте по одной:

| Name | Value |
|---|---|
| `DATABASE_URL` | первая строка из шага 3 (с `pgbouncer=true&connection_limit=1`), **без кавычек** |
| `DIRECT_URL` | вторая строка из шага 3, без кавычек |
| `DEMO_MODE` | `true` |
| `SEED_DEMO` | `true` |

5. Нажмите **Deploy**.

**Первая сборка займёт 5–15 минут:** база заполняется демо-школой (55 учеников, 25 курсов, оценки, посещаемость). Следующие сборки занимают 2–3 минуты и данные не трогают.

## Шаг 5. Открыть сайт

После надписи **Congratulations!** нажмите на картинку сайта или **Continue to Dashboard** → **Visit**. Адрес будет вида `https://toddle-xxxx.vercel.app`.

На странице входа выберите любую роль (демо-режим): учитель, координатор, администратор, ученик, родитель. Всё, что вы меняете (оценки, посещаемость, блокировки), **сохраняется в базе**.

## Полезно знать

- **Обновления.** Каждое изменение в ветке `main` на GitHub Vercel публикует автоматически.
- **Сброс демо-данных к исходным.**
  1. Supabase → **SQL Editor** → выполните `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`.
  2. Vercel → проект → **Deployments** → у последней сборки «⋯» → **Redeploy**. Миграции и демо-данные создадутся заново.
- **Пауза бесплатного проекта.** Supabase останавливает бесплатный проект после 7 дней без активности. В Supabase нажмите **Restore project**, и всё вернётся.
- **Кто может войти.** В демо-режиме зайти под любой ролью может каждый, у кого есть ссылка. Это нормально для показа на вымышленных данных; ссылку можно не публиковать широко.
- **Вход по паролю вместо демо-ролей.** Уберите `DEMO_MODE` (или поставьте `false`) в Vercel → **Settings** → **Environment Variables**, затем **Redeploy**. Ссылки-приглашения создаются в «Люди» → «Доступ».
- **Защита базы:**
  - таблицы закрыты от REST API Supabase миграцией `0002_lock_down_public_schema` (Row Level Security + отзыв прав у ролей `anon`/`authenticated`);
  - сайт подключается к базе по TLS через пулер Supabase;
  - ограничение частоты попыток входа на Vercel работает в пределах одного экземпляра функции, блокировка аккаунта после 5 ошибок хранится в базе и работает всегда.
