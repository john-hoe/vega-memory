export interface AuditCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface AuditReportData {
  checks: AuditCheck[];
  score: number;
  generatedAt: string;
  recommendations: string[];
}

const STATUS_SCORES: Record<AuditCheck["status"], number> = {
  pass: 100,
  warn: 50,
  fail: 0
};

const HASHING_ALGORITHMS = new Set(["argon2", "argon2id", "bcrypt", "scrypt", "pbkdf2"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }

  return undefined;
};

const readString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
};

const readConfigValue = (config: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (key in config) {
      return config[key];
    }
  }

  return undefined;
};

const createCheck = (
  name: string,
  status: AuditCheck["status"],
  detail: string
): AuditCheck => ({
  name,
  status,
  detail
});

export class SecurityAuditReport {
  constructor(private readonly config: Record<string, unknown>) {}

  async generate(): Promise<AuditReportData> {
    const checks = [
      this.checkHttps(),
      this.checkApiKeyLength(),
      this.checkCors(),
      this.checkRateLimiting(),
      this.checkCsrf(),
      this.checkEncryptionAtRest(),
      this.checkPasswordHashing()
    ];
    const score = Math.round(
      checks.reduce((sum, check) => sum + STATUS_SCORES[check.status], 0) / checks.length
    );
    const recommendations = checks
      .filter((check) => check.status !== "pass")
      .map((check) => `${check.name}: ${check.detail}`);

    return {
      checks,
      score,
      generatedAt: new Date().toISOString(),
      recommendations
    };
  }

  private checkHttps(): AuditCheck {
    const explicit = readBoolean(
      readConfigValue(this.config, ["httpsEnforced", "enforceHttps", "https"])
    );
    const url = readString(
      readConfigValue(this.config, ["serverUrl", "publicUrl", "apiBaseUrl", "baseUrl"])
    );

    if (explicit === true || url?.startsWith("https://")) {
      return createCheck("HTTPS enforced", "pass", "HTTPS enforcement is enabled.");
    }

    if (explicit === false || url?.startsWith("http://")) {
      return createCheck("HTTPS enforced", "fail", "HTTPS is not enforced for external traffic.");
    }

    return createCheck("HTTPS enforced", "warn", "No explicit HTTPS enforcement setting was found.");
  }

  private checkApiKeyLength(): AuditCheck {
    const apiKey = readString(readConfigValue(this.config, ["apiKey", "apiToken", "serviceApiKey"]));

    if (apiKey === undefined) {
      return createCheck("API key length", "warn", "No API key was configured for the audit target.");
    }

    if (apiKey.length >= 32) {
      return createCheck("API key length", "pass", `API key length is ${apiKey.length} characters.`);
    }

    return createCheck(
      "API key length",
      "fail",
      `API key length is ${apiKey.length}; expected at least 32 characters.`
    );
  }

  private checkCors(): AuditCheck {
    const origins = readStringArray(
      readConfigValue(this.config, ["corsOrigins", "allowedOrigins", "origins"])
    );
    const corsEnabled = readBoolean(readConfigValue(this.config, ["corsEnabled", "enableCors"]));

    if (origins !== undefined && origins.length > 0) {
      return createCheck("CORS configured", "pass", `CORS allows ${origins.length} configured origin(s).`);
    }

    if (corsEnabled === true) {
      return createCheck(
        "CORS configured",
        "warn",
        "CORS is enabled but no explicit origin allowlist was configured."
      );
    }

    return createCheck("CORS configured", "fail", "No CORS configuration was detected.");
  }

  private checkRateLimiting(): AuditCheck {
    const value = readConfigValue(this.config, [
      "rateLimit",
      "rateLimiting",
      "rateLimitEnabled",
      "rateLimitingEnabled"
    ]);

    if (typeof value === "boolean") {
      return value
        ? createCheck("Rate limiting", "pass", "Rate limiting is enabled.")
        : createCheck("Rate limiting", "fail", "Rate limiting is explicitly disabled.");
    }

    if (isRecord(value)) {
      const enabled = readBoolean(value.enabled);

      if (enabled === true) {
        return createCheck("Rate limiting", "pass", "Rate limiting is enabled.");
      }

      if (enabled === false) {
        return createCheck("Rate limiting", "fail", "Rate limiting is explicitly disabled.");
      }

      return createCheck("Rate limiting", "warn", "Rate limiting config exists but enabled state is unclear.");
    }

    return createCheck("Rate limiting", "warn", "No rate limiting configuration was detected.");
  }

  private checkCsrf(): AuditCheck {
    const csrfEnabled = readBoolean(readConfigValue(this.config, ["csrfEnabled", "enableCsrf"]));

    if (csrfEnabled === true) {
      return createCheck("CSRF protection", "pass", "CSRF protection is enabled.");
    }

    if (csrfEnabled === false) {
      return createCheck("CSRF protection", "fail", "CSRF protection is disabled.");
    }

    return createCheck("CSRF protection", "warn", "No CSRF protection setting was found.");
  }

  private checkEncryptionAtRest(): AuditCheck {
    const encrypted = readBoolean(
      readConfigValue(this.config, ["dbEncryption", "encryptionAtRest", "storageEncryption"])
    );

    if (encrypted === true) {
      return createCheck("Encryption at rest", "pass", "Encryption at rest is enabled.");
    }

    if (encrypted === false) {
      return createCheck("Encryption at rest", "fail", "Encryption at rest is disabled.");
    }

    return createCheck("Encryption at rest", "warn", "No encryption-at-rest setting was found.");
  }

  private checkPasswordHashing(): AuditCheck {
    const algorithm = readString(
      readConfigValue(this.config, [
        "passwordHashAlgorithm",
        "passwordHashingAlgorithm",
        "passwordHasher"
      ])
    )?.toLowerCase();
    const hashing = readConfigValue(this.config, ["passwordHashing", "passwordSecurity"]);

    if (algorithm !== undefined) {
      return HASHING_ALGORITHMS.has(algorithm)
        ? createCheck("Password hashing", "pass", `Password hashing uses ${algorithm}.`)
        : createCheck("Password hashing", "warn", `Password hashing uses unrecognized algorithm ${algorithm}.`);
    }

    if (typeof hashing === "boolean") {
      return hashing
        ? createCheck("Password hashing", "warn", "Password hashing is enabled but no algorithm was specified.")
        : createCheck("Password hashing", "fail", "Password hashing is disabled.");
    }

    if (isRecord(hashing)) {
      const enabled = readBoolean(hashing.enabled);
      const nestedAlgorithm = readString(hashing.algorithm)?.toLowerCase();

      if (nestedAlgorithm !== undefined && HASHING_ALGORITHMS.has(nestedAlgorithm)) {
        return createCheck("Password hashing", "pass", `Password hashing uses ${nestedAlgorithm}.`);
      }

      if (enabled === false) {
        return createCheck("Password hashing", "fail", "Password hashing is disabled.");
      }

      return createCheck(
        "Password hashing",
        "warn",
        "Password hashing config exists but the algorithm is missing or unrecognized."
      );
    }

    return createCheck("Password hashing", "warn", "No password hashing configuration was detected.");
  }
}
