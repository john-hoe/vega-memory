import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCloudProvider,
  GDriveProvider,
  ICloudProvider,
  S3Provider,
  type CloudStorageProvider
} from "../db/cloud-providers.js";

const exerciseProvider = async (
  provider: CloudStorageProvider,
  prefix: string,
  expectedConfigured: boolean
): Promise<void> => {
  assert.equal(provider.isConfigured(), expectedConfigured);

  const firstKey = `${prefix}/memory-1.db`;
  const secondKey = `${prefix}/memory-2.db`;
  const firstData = Buffer.from(`${prefix}-one`);
  const secondData = Buffer.from(`${prefix}-two`);

  assert.equal(await provider.upload(firstKey, firstData), firstKey);
  await provider.upload(secondKey, secondData);

  const listed = await provider.list(prefix);
  assert.deepEqual(
    listed.map((entry) => entry.key),
    [firstKey, secondKey]
  );
  assert.equal(listed[0]?.size, firstData.byteLength);
  assert.equal(listed[1]?.size, secondData.byteLength);
  assert.equal(listed.every((entry) => entry.lastModified instanceof Date), true);

  assert.deepEqual(await provider.download(firstKey), firstData);
  assert.equal(await provider.delete(firstKey), true);
  assert.equal(await provider.delete(firstKey), false);
  assert.deepEqual(
    (await provider.list(prefix)).map((entry) => entry.key),
    [secondKey]
  );
};

test("S3Provider supports upload download list and delete", async () => {
  const objects = new Map<string, Buffer>();
  await exerciseProvider(
    new S3Provider({
      bucket: "vega-backups",
      region: "us-east-1",
      enabled: true
    }, {
      async send(command: { input?: Record<string, unknown>; constructor?: { name?: string } }): Promise<unknown> {
        const input = command.input ?? {};
        const key = String(input.Key ?? "");
        const commandName = command.constructor?.name;

        if (commandName === "PutObjectCommand") {
          objects.set(key, Buffer.from(input.Body as Buffer));
          return {};
        }

        if (commandName === "ListObjectsV2Command") {
          return {
            Contents: [...objects.entries()].map(([storedKey, buffer]) => ({
              Key: storedKey,
              Size: buffer.byteLength,
              LastModified: new Date(0)
            }))
          };
        }

        if (commandName === "GetObjectCommand" && objects.has(key)) {
          const value = objects.get(key)!;
          return {
            Body: value
          };
        }

        if (commandName === "DeleteObjectCommand") {
          return objects.delete(key) ? {} : {};
        }

        return {};
      }
    }),
    "s3",
    true
  );
});

test("GDriveProvider supports upload download list and delete", async () => {
  const files = new Map<string, { id: string; data: Buffer }>();
  await exerciseProvider(
    new GDriveProvider({
      folderId: "folder-123",
      credentialsPath: "/tmp/gdrive-creds.json",
      enabled: true
    }, async () => ({
      files: {
        async create(args: Record<string, unknown>) {
          const requestBody = args.requestBody as { name?: string };
          const media = args.media as { body?: Buffer };
          const id = `file-${requestBody.name}`;
          files.set(String(requestBody.name), { id, data: Buffer.from(media.body ?? "") });
          return { data: { id } };
        },
        async get(args: Record<string, unknown>) {
          const match = [...files.values()].find((entry) => entry.id === args.fileId);
          return { data: match?.data };
        },
        async list(args: Record<string, unknown>) {
          const q = String(args.q ?? "");
          if (q.includes("name =")) {
            const name = q.split("name = '")[1]?.split("'")[0] ?? "";
            const entry = files.get(name);
            return { data: { files: entry ? [{ id: entry.id, name }] : [] } };
          }

          return {
            data: {
              files: [...files.entries()].map(([name, entry]) => ({
                id: entry.id,
                name,
                size: entry.data.byteLength,
                modifiedTime: new Date(0).toISOString(),
                md5Checksum: "checksum"
              }))
            }
          };
        },
        async delete(args: Record<string, unknown>) {
          const match = [...files.entries()].find(([, entry]) => entry.id === args.fileId);
          if (match) {
            files.delete(match[0]);
          }
          return {};
        }
      }
    })),
    "gdrive",
    true
  );
});

test("GDriveProvider keeps old backup when new upload fails", async () => {
  const key = "backup.db";
  const files = [{ id: "file-old", name: key, data: Buffer.from("old-data") }];
  const provider = new GDriveProvider(
    {
      folderId: "folder-123",
      credentialsPath: "/tmp/gdrive-creds.json",
      enabled: true
    },
    async () => ({
      files: {
        async create() {
          throw new Error("upload failed");
        },
        async get(args: Record<string, unknown>) {
          const match = files.find((entry) => entry.id === args.fileId);
          return { data: match?.data };
        },
        async list(args: Record<string, unknown>) {
          const q = String(args.q ?? "");
          if (q.includes("name =")) {
            return {
              data: {
                files: files.map((entry) => ({
                  id: entry.id,
                  name: entry.name
                }))
              }
            };
          }

          return {
            data: {
              files: files.map((entry) => ({
                id: entry.id,
                name: entry.name,
                size: entry.data.byteLength,
                modifiedTime: new Date(0).toISOString(),
                md5Checksum: "checksum"
              }))
            }
          };
        },
        async delete() {
          assert.fail("delete should not be called when create fails");
        }
      }
    })
  );

  await assert.rejects(provider.upload(key, Buffer.from("new-data")), /upload failed/);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.id, "file-old");
  assert.deepEqual(await provider.download(key), Buffer.from("old-data"));
});

test("GDriveProvider successful upload replaces old backup after create succeeds", async () => {
  const key = "backup.db";
  const files: Array<{ id: string; name: string; data: Buffer }> = [
    { id: "file-old", name: key, data: Buffer.from("old-data") }
  ];
  let createCount = 0;
  const provider = new GDriveProvider(
    {
      folderId: "folder-123",
      credentialsPath: "/tmp/gdrive-creds.json",
      enabled: true
    },
    async () => ({
      files: {
        async create(args: Record<string, unknown>) {
          createCount += 1;
          const requestBody = args.requestBody as { name?: string };
          const media = args.media as { body?: Buffer };
          const id = `file-new-${createCount}`;
          files.push({
            id,
            name: String(requestBody.name),
            data: Buffer.from(media.body ?? "")
          });
          return { data: { id } };
        },
        async get(args: Record<string, unknown>) {
          const match = files.find((entry) => entry.id === args.fileId);
          return { data: match?.data };
        },
        async list(args: Record<string, unknown>) {
          const q = String(args.q ?? "");
          if (q.includes("name =")) {
            return {
              data: {
                files: files
                  .filter((entry) => entry.name === key)
                  .map((entry) => ({
                    id: entry.id,
                    name: entry.name
                  }))
              }
            };
          }

          return {
            data: {
              files: files.map((entry) => ({
                id: entry.id,
                name: entry.name,
                size: entry.data.byteLength,
                modifiedTime: new Date(0).toISOString(),
                md5Checksum: "checksum"
              }))
            }
          };
        },
        async delete(args: Record<string, unknown>) {
          const index = files.findIndex((entry) => entry.id === args.fileId);
          if (index >= 0) {
            files.splice(index, 1);
          }
          return {};
        }
      }
    })
  );

  assert.equal(await provider.upload(key, Buffer.from("new-data")), key);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.id, "file-new-1");
  assert.deepEqual(await provider.download(key), Buffer.from("new-data"));
});

test("ICloudProvider supports upload download list and delete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-icloud-"));
  await exerciseProvider(
    new ICloudProvider({
      containerPath: directory,
      enabled: true
    }),
    "icloud",
    true
  );
  rmSync(directory, { recursive: true, force: true });
});

test("ICloudProvider rejects path traversal outside the container root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-icloud-traversal-"));
  const provider = new ICloudProvider({
    containerPath: directory,
    enabled: true
  });

  try {
    await assert.rejects(
      provider.upload("../outside.txt", Buffer.from("bad")),
      /escapes container root/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createCloudProvider builds provider instances", () => {
  assert.equal(
    createCloudProvider("s3", {
      bucket: "vega-backups",
      region: "us-east-1",
      enabled: true
    }) instanceof S3Provider,
    true
  );
  assert.equal(
    createCloudProvider("gdrive", {
      folderId: "folder-123",
      credentialsPath: "/tmp/gdrive-creds.json",
      enabled: true
    }) instanceof GDriveProvider,
    true
  );
  assert.equal(
    createCloudProvider("icloud", {
      containerPath: "/tmp/icloud-container",
      enabled: true
    }) instanceof ICloudProvider,
    true
  );
});

test("unconfigured providers report false", () => {
  assert.equal(
    new S3Provider({
      bucket: "",
      region: "us-east-1",
      enabled: true
    }).isConfigured(),
    false
  );
  assert.equal(
    new GDriveProvider({
      enabled: true
    }).isConfigured(),
    false
  );
  assert.equal(
    new ICloudProvider({
      enabled: true
    }).isConfigured(),
    false
  );
});
