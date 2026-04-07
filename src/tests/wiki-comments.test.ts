import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DASHBOARD_AUTH_COOKIE,
  registerDashboardSession,
  revokeDashboardSession
} from "../api/auth.js";
import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { TenantService } from "../core/tenant.js";
import { UserService, type User } from "../core/user.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { CommentService } from "../wiki/comments.js";
import { NotificationService } from "../wiki/notifications.js";
import { PageManager } from "../wiki/page-manager.js";
import { SpaceService } from "../wiki/spaces.js";

interface ApiHarness {
  config: VegaConfig;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const createApiHarness = async (): Promise<ApiHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiki-comments-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const server = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config
  );
  const port = await server.start(0);

  return {
    config,
    repository,
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
    request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      if (init?.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      return fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers
      });
    }
  };
};

const withSession = (token: string): HeadersInit => ({
  cookie: `${DASHBOARD_AUTH_COOKIE}=${token}`
});

test("CommentService supports CRUD, mentions, replies, and notification read state", () => {
  const repository = new Repository(":memory:");
  const tenantService = new TenantService(repository);
  const userService = new UserService(repository);
  const spaceService = new SpaceService(repository);
  const pageManager = new PageManager(repository);
  const commentService = new CommentService(repository);
  const notificationService = new NotificationService(repository);

  try {
    const tenant = tenantService.createTenant("Wiki Tenant", "pro");
    const author = userService.createUser("alice@example.com", "alice", "member", tenant.id);
    const mentioned = userService.createUser("bob@example.com", "bob", "member", tenant.id);
    const admin = userService.createUser("admin@example.com", "admin", "admin", tenant.id);
    const space = spaceService.createSpace("Engineering", "engineering", tenant.id);
    const page = pageManager.createPage({
      title: "Commentable Page",
      content: "Body",
      summary: "Summary",
      page_type: "reference",
      space_id: space.id
    });

    assert.deepEqual(
      commentService.extractMentions("Ping @bob and @alice.sre plus @bob"),
      ["bob", "alice.sre"]
    );

    const comment = commentService.addComment(page.id, author.id, "Hello @bob and @bob");

    assert.equal(comment.page_id, page.id);
    assert.equal(comment.user_id, author.id);
    assert.deepEqual(comment.mentions, ["bob"]);
    assert.equal(repository.getWikiComment(comment.id)?.mentions[0], "bob");
    assert.equal(commentService.getComments(page.id, { limit: 1 })[0]?.id, comment.id);

    const mentionedUnread = notificationService.getUnread(mentioned.id);

    assert.equal(mentionedUnread.length, 1);
    assert.equal(mentionedUnread[0]?.type, "mention");

    const reply = commentService.addComment(page.id, mentioned.id, "Replying", comment.id);

    assert.equal(commentService.getThread(comment.id)[0]?.id, reply.id);
    assert.equal(notificationService.getUnread(author.id)[0]?.type, "reply");

    const updated = commentService.updateComment(comment.id, author.id, "Updated for @admin");

    assert.deepEqual(updated.mentions, ["admin"]);
    assert.equal(notificationService.getUnread(admin.id)[0]?.type, "mention");

    notificationService.markRead(mentionedUnread[0]!.id);
    assert.equal(notificationService.getUnread(mentioned.id).length, 0);

    notificationService.createNotification(mentioned.id, "page_update", page.id, "Page updated");
    notificationService.markAllRead(mentioned.id);
    assert.equal(notificationService.getUnread(mentioned.id).length, 0);

    assert.throws(
      () => commentService.deleteComment(comment.id, mentioned.id),
      /Only the author or an admin can delete this comment/
    );

    commentService.deleteComment(comment.id, admin.id);
    assert.equal(commentService.getComments(page.id).length, 0);
  } finally {
    repository.close();
  }
});

test("wiki comment and notification API routes support session users", async () => {
  const harness = await createApiHarness();
  const tenantService = new TenantService(harness.repository);
  const userService = new UserService(harness.repository);
  const spaceService = new SpaceService(harness.repository);
  const pageManager = new PageManager(harness.repository);
  const aliceToken = "wiki-comments-alice";
  const bobToken = "wiki-comments-bob";
  const adminToken = "wiki-comments-admin";
  let alice: User | undefined;
  let bob: User | undefined;
  let admin: User | undefined;

  try {
    const tenant = tenantService.createTenant("API Tenant", "pro");
    alice = userService.createUser("alice@example.com", "alice", "member", tenant.id);
    bob = userService.createUser("bob@example.com", "bob", "member", tenant.id);
    admin = userService.createUser("admin@example.com", "admin", "admin", tenant.id);
    const space = spaceService.createSpace("Docs", "docs", tenant.id);
    const page = pageManager.createPage({
      title: "API Comment Page",
      content: "Body",
      summary: "Summary",
      page_type: "reference",
      space_id: space.id
    });

    registerDashboardSession(harness.config, aliceToken, alice);
    registerDashboardSession(harness.config, bobToken, bob);
    registerDashboardSession(harness.config, adminToken, admin);

    const createResponse = await harness.request(`/api/wiki/pages/${page.id}/comments`, {
      method: "POST",
      headers: withSession(aliceToken),
      body: JSON.stringify({
        content: "Hello @bob"
      })
    });
    const createdComment = await readJson<{
      id: string;
      page_id: string;
      user_id: string;
      mentions: string[];
    }>(createResponse);
    const listResponse = await harness.request(`/api/wiki/pages/${page.id}/comments`);
    const listedComments = await readJson<
      Array<{
        id: string;
        user_id: string;
        mentions: string[];
      }>
    >(listResponse);
    const bobNotificationsResponse = await harness.request("/api/wiki/notifications", {
      headers: withSession(bobToken)
    });
    const bobNotifications = await readJson<
      Array<{
        id: string;
        type: string;
      }>
    >(bobNotificationsResponse);
    const replyResponse = await harness.request(`/api/wiki/pages/${page.id}/comments`, {
      method: "POST",
      headers: withSession(bobToken),
      body: JSON.stringify({
        content: "Reply",
        parent_comment_id: createdComment.id
      })
    });
    const reply = await readJson<{ id: string }>(replyResponse);
    const aliceNotificationsResponse = await harness.request("/api/wiki/notifications", {
      headers: withSession(aliceToken)
    });
    const aliceNotifications = await readJson<
      Array<{
        id: string;
        type: string;
      }>
    >(aliceNotificationsResponse);
    const updateResponse = await harness.request(`/api/wiki/comments/${createdComment.id}`, {
      method: "PATCH",
      headers: withSession(aliceToken),
      body: JSON.stringify({
        content: "Updated @admin"
      })
    });
    const updatedComment = await readJson<{
      id: string;
      mentions: string[];
      updated_at?: string;
    }>(updateResponse);
    const adminNotificationsResponse = await harness.request("/api/wiki/notifications", {
      headers: withSession(adminToken)
    });
    const adminNotifications = await readJson<
      Array<{
        type: string;
      }>
    >(adminNotificationsResponse);
    const markReadResponse = await harness.request("/api/wiki/notifications/read", {
      method: "POST",
      headers: withSession(bobToken),
      body: JSON.stringify({})
    });
    const bobNotificationsAfterRead = await readJson<Array<{ id: string }>>(
      await harness.request("/api/wiki/notifications", {
        headers: withSession(bobToken)
      })
    );
    const deleteResponse = await harness.request(`/api/wiki/comments/${createdComment.id}`, {
      method: "DELETE",
      headers: withSession(adminToken)
    });
    const deleteBody = await readJson<{ action: string }>(deleteResponse);
    const commentsAfterDelete = await readJson<Array<{ id: string }>>(
      await harness.request(`/api/wiki/pages/${page.id}/comments`)
    );

    assert.equal(createResponse.status, 201);
    assert.equal(createdComment.page_id, page.id);
    assert.equal(createdComment.user_id, alice.id);
    assert.deepEqual(createdComment.mentions, ["bob"]);

    assert.equal(listResponse.status, 200);
    assert.equal(listedComments.length, 1);
    assert.equal(listedComments[0]?.id, createdComment.id);

    assert.equal(bobNotificationsResponse.status, 200);
    assert.equal(bobNotifications.length, 1);
    assert.equal(bobNotifications[0]?.type, "mention");

    assert.equal(replyResponse.status, 201);
    assert.ok(reply.id.length > 0);

    assert.equal(aliceNotificationsResponse.status, 200);
    assert.equal(aliceNotifications.length, 1);
    assert.equal(aliceNotifications[0]?.type, "reply");

    assert.equal(updateResponse.status, 200);
    assert.equal(updatedComment.id, createdComment.id);
    assert.deepEqual(updatedComment.mentions, ["admin"]);
    assert.equal(typeof updatedComment.updated_at, "string");

    assert.equal(adminNotificationsResponse.status, 200);
    assert.equal(adminNotifications.length, 1);
    assert.equal(adminNotifications[0]?.type, "mention");

    assert.equal(markReadResponse.status, 200);
    assert.equal(bobNotificationsAfterRead.length, 0);

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteBody.action, "deleted");
    assert.equal(commentsAfterDelete.length, 0);
  } finally {
    if (alice !== undefined) {
      revokeDashboardSession(harness.config, aliceToken);
    }
    if (bob !== undefined) {
      revokeDashboardSession(harness.config, bobToken);
    }
    if (admin !== undefined) {
      revokeDashboardSession(harness.config, adminToken);
    }
    await harness.cleanup();
  }
});
