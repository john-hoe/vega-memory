import assert from "node:assert/strict";
import test from "node:test";

import type { Request, Response } from "express";

import { requireRole, requireTenantAccess } from "../api/permissions.js";
import { UserService, type User } from "../core/user.js";
import { Repository } from "../db/repository.js";

interface MockResponse {
  locals: Record<string, unknown>;
  statusCode?: number;
  jsonBody?: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

const createMockResponse = (locals: Record<string, unknown> = {}): MockResponse => ({
  locals,
  status(code: number): MockResponse {
    this.statusCode = code;
    return this;
  },
  json(payload: unknown): MockResponse {
    this.jsonBody = payload;
    return this;
  }
});

const createMockUser = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  tenant_id: "tenant-a",
  created_at: "2026-04-07T00:00:00.000Z",
  ...overrides
});

test("UserService supports create, update, list, and SSO subject lookup", () => {
  const repository = new Repository(":memory:");
  const userService = new UserService(repository);

  try {
    const created = userService.createUser("Alice@Example.com", "Alice", "admin", "tenant-a");

    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.email, "alice@example.com");
    assert.equal(userService.getUserByEmail("ALICE@example.com")?.id, created.id);

    userService.updateUser(created.id, {
      name: "Alice Admin",
      role: "member",
      sso_provider: "https://issuer.example.com",
      sso_subject: "alice-subject"
    });

    const updated = userService.getUserBySsoSubject(
      "https://issuer.example.com",
      "alice-subject"
    );

    assert.ok(updated);
    assert.equal(updated.name, "Alice Admin");
    assert.equal(updated.role, "member");

    userService.createUser("bob@example.com", "Bob", "viewer", "tenant-b");

    assert.equal(userService.listUsers().length, 2);
    assert.deepEqual(
      userService.listUsers("tenant-a").map((user) => user.email),
      ["alice@example.com"]
    );
  } finally {
    repository.close();
  }
});

test("requireRole forbids users without an allowed role", () => {
  const middleware = requireRole("admin");
  const req = {} as Request;
  const res = createMockResponse({
    user: createMockUser({
      role: "member"
    })
  }) as unknown as Response;
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal((res as unknown as MockResponse).statusCode, 403);
  assert.deepEqual((res as unknown as MockResponse).jsonBody, {
    error: "forbidden"
  });
});

test("requireRole allows users with a permitted role", () => {
  const middleware = requireRole("admin", "member");
  const req = {} as Request;
  const res = createMockResponse({
    user: createMockUser({
      role: "member"
    })
  }) as unknown as Response;
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal((res as unknown as MockResponse).statusCode, undefined);
});

test("requireTenantAccess forbids tenant mismatches for authenticated users", () => {
  const middleware = requireTenantAccess();
  const req = ({
    params: {},
    query: {
      tenant_id: "tenant-b"
    }
  } as unknown) as Request;
  const res = createMockResponse({
    tenantId: "tenant-a",
    user: createMockUser({
      tenant_id: "tenant-a"
    })
  }) as unknown as Response;
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal((res as unknown as MockResponse).statusCode, 403);
  assert.deepEqual((res as unknown as MockResponse).jsonBody, {
    error: "forbidden"
  });
});

test("requireTenantAccess allows matching tenant access", () => {
  const middleware = requireTenantAccess();
  const req = ({
    params: {
      tenantId: "tenant-a"
    },
    query: {}
  } as unknown) as Request;
  const res = createMockResponse({
    tenantId: "tenant-a",
    user: createMockUser({
      tenant_id: "tenant-a"
    })
  }) as unknown as Response;
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal((res as unknown as MockResponse).statusCode, undefined);
});
