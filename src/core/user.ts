import { randomUUID } from "node:crypto";

import { Repository } from "../db/repository.js";

export type UserRole = "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  tenant_id: string;
  created_at: string;
  sso_provider?: string;
  sso_subject?: string;
}

const USER_ROLES = new Set<UserRole>(["admin", "member", "viewer"]);

const now = (): string => new Date().toISOString();

const normalizeEmail = (email: string): string => {
  const normalized = email.trim().toLowerCase();

  if (normalized.length === 0) {
    throw new Error("User email is required");
  }

  return normalized;
};

const normalizeName = (name: string): string => {
  const normalized = name.trim();

  if (normalized.length === 0) {
    throw new Error("User name is required");
  }

  return normalized;
};

const normalizeTenantId = (tenantId: string): string => {
  const normalized = tenantId.trim();

  if (normalized.length === 0) {
    throw new Error("User tenant_id is required");
  }

  return normalized;
};

const normalizeOptionalIdentity = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
};

const normalizeRole = (role: UserRole): UserRole => {
  if (!USER_ROLES.has(role)) {
    throw new Error(`Unsupported user role: ${role}`);
  }

  return role;
};

export class UserService {
  constructor(private readonly repository: Repository) {}

  createUser(email: string, name: string, role: UserRole, tenantId: string): User {
    const user: User = {
      id: randomUUID(),
      email: normalizeEmail(email),
      name: normalizeName(name),
      role: normalizeRole(role),
      tenant_id: normalizeTenantId(tenantId),
      created_at: now()
    };

    this.repository.createUser(user);
    return user;
  }

  getUserByEmail(email: string): User | null {
    return this.repository.getUserByEmail(normalizeEmail(email));
  }

  getUserBySsoSubject(provider: string, subject: string): User | null {
    const normalizedProvider = normalizeOptionalIdentity(provider);
    const normalizedSubject = normalizeOptionalIdentity(subject);

    if (normalizedProvider === undefined || normalizedSubject === undefined) {
      return null;
    }

    return this.repository.getUserBySsoSubject(normalizedProvider, normalizedSubject);
  }

  updateUser(
    id: string,
    updates: Partial<Pick<User, "email" | "name" | "role" | "tenant_id" | "sso_provider" | "sso_subject">>
  ): void {
    const normalizedUpdates = {
      ...(updates.email === undefined ? {} : { email: normalizeEmail(updates.email) }),
      ...(updates.name === undefined ? {} : { name: normalizeName(updates.name) }),
      ...(updates.role === undefined ? {} : { role: normalizeRole(updates.role) }),
      ...(updates.tenant_id === undefined ? {} : { tenant_id: normalizeTenantId(updates.tenant_id) }),
      ...(updates.sso_provider === undefined
        ? {}
        : { sso_provider: normalizeOptionalIdentity(updates.sso_provider) }),
      ...(updates.sso_subject === undefined
        ? {}
        : { sso_subject: normalizeOptionalIdentity(updates.sso_subject) })
    };

    this.repository.updateUser(id, normalizedUpdates);
  }

  listUsers(tenantId?: string): User[] {
    const normalizedTenantId =
      tenantId === undefined ? undefined : normalizeTenantId(tenantId);

    return this.repository.listUsers(normalizedTenantId);
  }
}
