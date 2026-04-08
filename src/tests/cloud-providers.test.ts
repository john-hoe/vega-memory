import assert from "node:assert/strict";
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
  await exerciseProvider(
    new S3Provider({
      bucket: "vega-backups",
      region: "us-east-1",
      enabled: true
    }),
    "s3",
    true
  );
});

test("GDriveProvider supports upload download list and delete", async () => {
  await exerciseProvider(
    new GDriveProvider({
      folderId: "folder-123",
      credentialsPath: "/tmp/gdrive-creds.json",
      enabled: true
    }),
    "gdrive",
    true
  );
});

test("ICloudProvider supports upload download list and delete", async () => {
  await exerciseProvider(
    new ICloudProvider({
      containerPath: "/tmp/icloud-container",
      enabled: true
    }),
    "icloud",
    true
  );
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
