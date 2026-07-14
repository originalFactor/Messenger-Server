function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  jwtSecret: () => requireEnv("JWT_SECRET"),
  adminPassword: () => requireEnv("ADMIN_PASSWORD"),
  appBaseUrl: () => process.env.APP_BASE_URL ?? "http://localhost:3000",
  upstashRedisUrl: () => requireEnv("UPSTASH_REDIS_REST_URL"),
  upstashRedisToken: () => requireEnv("UPSTASH_REDIS_REST_TOKEN"),
};
