-- Закрыть таблицы схемы public от прямого доступа в обход приложения.
--
-- Зачем: Supabase автоматически публикует схему public через REST/GraphQL API (PostgREST) с ролями anon и authenticated.
-- Без этой миграции любой, кто знает URL проекта и публичный anon-ключ, мог бы читать и менять таблицы журнала.
--
-- Что делаем:
--   1) включаем Row Level Security на всех таблицах public без политик: для anon/authenticated доступ запрещён;
--      приложение подключается владельцем таблиц (Prisma), владелец RLS не подчиняется — работа сайта не меняется;
--   2) если роли anon/authenticated существуют (Supabase), отзываем у них все права на схему public,
--      включая права по умолчанию для будущих таблиц.
-- На обычном PostgreSQL (Docker, сервер в РК) миграция безвредна: шаг 2 пропускается.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
