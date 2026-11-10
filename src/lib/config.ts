/** Настройки из переменных окружения (без секретов в коде). */
export const config = {
  isProd: process.env.NODE_ENV === "production",
  /** Демо-вход по ролям без пароля. Только для демо-стендов с вымышленными данными! */
  demoMode: process.env.DEMO_MODE === "true",
  /** Адрес сайта для ссылок-приглашений и Google. На Vercel по умолчанию берётся производственный домен проекта. */
  appUrl: (process.env.APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")).replace(/\/$/, ""),
  /** Secure-cookie: включено по умолчанию в production (сайт за HTTPS). */
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  sessionIdleHours: Number(process.env.SESSION_IDLE_HOURS ?? 72),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    /** Домены Google Workspace школы через запятую. Сотрудники и ученики могут входить только с них. */
    allowedDomains: (process.env.GOOGLE_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
  },
  get googleEnabled() {
    return !!(this.google.clientId && this.google.clientSecret);
  },
};
