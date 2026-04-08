import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface SecurityHardeningConfig {
  byokEnabled: boolean;
  encryptionKeyPath?: string;
  csrfEnabled: boolean;
  corsOrigins?: string[];
}

export interface ByokValidationResult {
  valid: boolean;
  algorithm: string;
  keyLength: number;
}

const getAlgorithmForKey = (key: Buffer): "aes-128-gcm" | "aes-256-gcm" => {
  if (key.length === 16) {
    return "aes-128-gcm";
  }

  if (key.length === 32) {
    return "aes-256-gcm";
  }

  throw new Error("BYOK key must decode to 16 or 32 bytes");
};

const decodeBase64 = (value: string): Buffer => {
  const normalized = value.trim();

  if (normalized.length === 0 || !BASE64_PATTERN.test(normalized)) {
    throw new Error("BYOK key must be a valid base64 string");
  }

  return Buffer.from(normalized, "base64");
};

export class SecurityHardening {
  constructor(private readonly config: SecurityHardeningConfig) {}

  validateByokKey(keyBase64: string): ByokValidationResult {
    try {
      const key = decodeBase64(keyBase64);
      const algorithm = getAlgorithmForKey(key);

      return {
        valid: true,
        algorithm,
        keyLength: key.length
      };
    } catch {
      try {
        const decoded = decodeBase64(keyBase64);

        return {
          valid: false,
          algorithm: "unknown",
          keyLength: decoded.length
        };
      } catch {
        return {
          valid: false,
          algorithm: "unknown",
          keyLength: 0
        };
      }
    }
  }

  generateByokKey(algorithm: "aes-256-gcm" | "aes-128-gcm" = "aes-256-gcm"): string {
    const size = algorithm === "aes-128-gcm" ? 16 : 32;

    return randomBytes(size).toString("base64");
  }

  encryptWithByok(
    plaintext: string,
    keyBase64: string
  ): { ciphertext: string; iv: string; tag: string } {
    if (!this.config.byokEnabled) {
      throw new Error("BYOK encryption is disabled");
    }

    const key = decodeBase64(keyBase64);
    const algorithm = getAlgorithmForKey(key);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(algorithm, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64")
    };
  }

  decryptWithByok(ciphertext: string, iv: string, tag: string, keyBase64: string): string {
    if (!this.config.byokEnabled) {
      throw new Error("BYOK encryption is disabled");
    }

    const key = decodeBase64(keyBase64);
    const algorithm = getAlgorithmForKey(key);
    const decipher = createDecipheriv(algorithm, key, decodeBase64(iv));
    const authTag = decodeBase64(tag);

    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new Error("BYOK auth tag must decode to 16 bytes");
    }

    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(decodeBase64(ciphertext)),
      decipher.final()
    ]).toString("utf8");
  }

  getCorsHeaders(origin: string): Record<string, string> {
    const allowedOrigins = this.config.corsOrigins;

    if (allowedOrigins === undefined || allowedOrigins.length === 0) {
      return {};
    }

    if (allowedOrigins.includes("*")) {
      return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
        Vary: "Origin"
      };
    }

    if (!allowedOrigins.includes(origin)) {
      return {};
    }

    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin"
    };
  }

  generateCsrfToken(): string {
    if (!this.config.csrfEnabled) {
      throw new Error("CSRF protection is disabled");
    }

    return randomBytes(32).toString("hex");
  }

  validateCsrfToken(token: string, sessionToken: string): boolean {
    if (!this.config.csrfEnabled) {
      return false;
    }

    const normalizedToken = token.trim();
    const normalizedSessionToken = sessionToken.trim();

    if (
      normalizedToken.length === 0 ||
      normalizedSessionToken.length === 0 ||
      normalizedToken.length !== normalizedSessionToken.length
    ) {
      return false;
    }

    return timingSafeEqual(
      Buffer.from(normalizedToken, "utf8"),
      Buffer.from(normalizedSessionToken, "utf8")
    );
  }
}
