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
  mongoUri: () => requireEnv("MONGODB_URI"),
  mongoDbName: () => process.env.MONGODB_DB_NAME ?? "messenger",
};

export function appUrl(path: string): string {
  return new URL(path, `${env.appBaseUrl().replace(/\/+$/, "")}/`).toString();
}
