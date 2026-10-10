type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dropNullEntries(config: ConfigRecord): ConfigRecord {
  const result: ConfigRecord = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null) continue;
    if (key === "env" && isRecord(value)) {
      result[key] = dropNullEntries(value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function applyAdapterConfigPatch(
  existing: ConfigRecord,
  requested: ConfigRecord,
  options: { replace?: boolean } = {},
): ConfigRecord {
  if (options.replace) return dropNullEntries(requested);

  const result: ConfigRecord = { ...existing };
  for (const [key, value] of Object.entries(requested)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (key === "env" && isRecord(value) && Object.values(value).some((entry) => entry === null)) {
      const nextEnv: ConfigRecord = isRecord(existing.env) ? { ...existing.env } : {};
      for (const [envKey, envValue] of Object.entries(value)) {
        if (envValue === null) delete nextEnv[envKey];
        else nextEnv[envKey] = envValue;
      }
      result.env = nextEnv;
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function adapterConfigHasEnvRemoval(requested: ConfigRecord): boolean {
  return isRecord(requested.env) && Object.values(requested.env).some((entry) => entry === null);
}
