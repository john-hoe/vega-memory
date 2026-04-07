import { randomUUID } from "node:crypto";

import { Repository } from "../db/repository.js";
import {
  WIKI_SPACE_VISIBILITIES,
  type WikiSpace,
  type WikiSpaceVisibility
} from "./types.js";

const WIKI_SPACE_VISIBILITY_VALUES = new Set<WikiSpaceVisibility>(WIKI_SPACE_VISIBILITIES);

const now = (): string => new Date().toISOString();

const normalizeName = (name: string): string => {
  const normalized = name.trim();

  if (normalized.length === 0) {
    throw new Error("Wiki space name is required");
  }

  return normalized;
};

const normalizeSlug = (slug: string): string => {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (normalized.length === 0) {
    throw new Error("Wiki space slug is required");
  }

  return normalized;
};

const normalizeTenantId = (tenantId: string): string => {
  const normalized = tenantId.trim();

  if (normalized.length === 0) {
    throw new Error("Wiki space tenant_id is required");
  }

  return normalized;
};

const normalizeVisibility = (visibility: WikiSpaceVisibility | undefined): WikiSpaceVisibility => {
  const normalized = visibility ?? "internal";

  if (!WIKI_SPACE_VISIBILITY_VALUES.has(normalized)) {
    throw new Error(`Unsupported wiki space visibility: ${visibility}`);
  }

  return normalized;
};

export class SpaceService {
  constructor(private readonly repository: Repository) {}

  createSpace(
    name: string,
    slug: string,
    tenantId: string,
    visibility?: WikiSpaceVisibility
  ): WikiSpace {
    const space: WikiSpace = {
      id: randomUUID(),
      name: normalizeName(name),
      slug: normalizeSlug(slug),
      tenant_id: normalizeTenantId(tenantId),
      visibility: normalizeVisibility(visibility),
      created_at: now()
    };

    this.repository.createWikiSpace(space);
    return space;
  }

  getSpace(id: string): WikiSpace | null {
    return this.repository.getWikiSpace(id.trim());
  }

  getSpaceBySlug(slug: string, tenantId: string): WikiSpace | null {
    return this.repository.getWikiSpaceBySlug(normalizeSlug(slug), normalizeTenantId(tenantId));
  }

  listSpaces(tenantId: string): WikiSpace[] {
    return this.repository.listWikiSpaces(normalizeTenantId(tenantId));
  }

  updateSpace(
    id: string,
    updates: Partial<Pick<WikiSpace, "name" | "slug" | "visibility">>
  ): void {
    const normalizedUpdates = {
      ...(updates.name === undefined ? {} : { name: normalizeName(updates.name) }),
      ...(updates.slug === undefined ? {} : { slug: normalizeSlug(updates.slug) }),
      ...(updates.visibility === undefined
        ? {}
        : { visibility: normalizeVisibility(updates.visibility) })
    };

    this.repository.updateWikiSpace(id.trim(), normalizedUpdates);
  }

  deleteSpace(id: string): void {
    this.repository.deleteWikiSpace(id.trim());
  }
}
