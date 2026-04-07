import { Repository } from "../db/repository.js";

export interface PagePermission {
  page_id: string;
  user_id?: string;
  role?: string;
  level: "read" | "write" | "admin";
}

const LEVEL_ORDER: Record<PagePermission["level"], number> = {
  read: 1,
  write: 2,
  admin: 3
};

const normalizeIdentifier = (value: string, field: string): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`${field} is required`);
  }

  return normalized;
};

const normalizeLevel = (level: PagePermission["level"]): PagePermission["level"] => {
  if (!(level in LEVEL_ORDER)) {
    throw new Error(`Unsupported permission level: ${level}`);
  }

  return level;
};

const mapPermission = (permission: {
  page_id: string;
  user_id: string | null;
  role: string | null;
  level: PagePermission["level"];
}): PagePermission => ({
  page_id: permission.page_id,
  ...(permission.user_id === null ? {} : { user_id: permission.user_id }),
  ...(permission.role === null ? {} : { role: permission.role }),
  level: permission.level
});

const hasRequiredLevel = (
  granted: PagePermission["level"],
  required: PagePermission["level"]
): boolean => LEVEL_ORDER[granted] >= LEVEL_ORDER[required];

export class PagePermissionService {
  constructor(private readonly repository: Repository) {}

  setPermission(pageId: string, userId: string, level: PagePermission["level"]): void {
    this.repository.setWikiPageUserPermission(
      normalizeIdentifier(pageId, "page_id"),
      normalizeIdentifier(userId, "user_id"),
      normalizeLevel(level)
    );
  }

  setRolePermission(pageId: string, role: string, level: PagePermission["level"]): void {
    this.repository.setWikiPageRolePermission(
      normalizeIdentifier(pageId, "page_id"),
      normalizeIdentifier(role, "role"),
      normalizeLevel(level)
    );
  }

  getPermissions(pageId: string): PagePermission[] {
    return this.repository
      .listWikiPagePermissions(normalizeIdentifier(pageId, "page_id"))
      .map(mapPermission);
  }

  canAccess(
    pageId: string,
    userId: string | undefined,
    userRole: string | undefined,
    requiredLevel: PagePermission["level"]
  ): boolean {
    const normalizedPageId = normalizeIdentifier(pageId, "page_id");
    const normalizedRequiredLevel = normalizeLevel(requiredLevel);
    const normalizedUserId = userId?.trim() || undefined;
    const normalizedUserRole = userRole?.trim() || undefined;

    if (normalizedUserRole === "admin") {
      return true;
    }

    const permissions = this.getPermissions(normalizedPageId);
    const matchingPermissions = permissions.filter(
      (permission) =>
        (permission.user_id !== undefined && permission.user_id === normalizedUserId) ||
        (permission.role !== undefined && permission.role === normalizedUserRole)
    );

    if (
      matchingPermissions.some((permission) =>
        hasRequiredLevel(permission.level, normalizedRequiredLevel)
      )
    ) {
      return true;
    }

    if (normalizedRequiredLevel !== "read") {
      return false;
    }

    const visibility = this.repository.getWikiPageSpaceVisibility(normalizedPageId);
    if (visibility === "public") {
      return true;
    }

    if (visibility === "internal") {
      return normalizedUserId !== undefined || normalizedUserRole !== undefined;
    }

    return false;
  }

  removePermission(pageId: string, userId: string): void {
    this.repository.deleteWikiPageUserPermission(
      normalizeIdentifier(pageId, "page_id"),
      normalizeIdentifier(userId, "user_id")
    );
  }
}
