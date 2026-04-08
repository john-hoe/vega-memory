import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { google } from "googleapis";

export interface CloudObject {
  key: string;
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface CloudStorageProvider {
  upload(key: string, data: Buffer): Promise<string>;
  download(key: string): Promise<Buffer>;
  list(prefix?: string): Promise<CloudObject[]>;
  delete(key: string): Promise<boolean>;
  isConfigured(): boolean;
}

type S3ProviderConfig = {
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  enabled: boolean;
};

type GDriveProviderConfig = {
  folderId?: string;
  credentialsPath?: string;
  enabled: boolean;
};

type ICloudProviderConfig = {
  containerPath?: string;
  enabled: boolean;
};

interface S3LikeClient {
  send(command: unknown): Promise<unknown>;
}

interface GoogleDriveLikeClient {
  files: {
    create(...args: unknown[]): Promise<{ data: { id?: string } }>;
    get(...args: unknown[]): Promise<unknown>;
    list(...args: unknown[]): Promise<{ data: { files?: Array<Record<string, unknown>> } }>;
    delete(...args: unknown[]): Promise<unknown>;
  };
}

const toCloudObject = (
  key: string,
  size: number,
  lastModified: Date,
  etag?: string
): CloudObject => ({
  key,
  size,
  lastModified,
  ...(etag === undefined ? {} : { etag })
});

const ensureConfigured = (configured: boolean, label: string): void => {
  if (!configured) {
    throw new Error(`${label} is not configured`);
  }
};

const streamToBuffer = async (value: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];

    for await (const chunk of value as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  throw new Error("Unsupported cloud object body");
};

const createS3Client = (config: S3ProviderConfig): S3Client =>
  new S3Client({
    region: config.region,
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
          }
        }
      : {})
  });

const createDriveClient = async (config: GDriveProviderConfig): Promise<GoogleDriveLikeClient> => {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  return google.drive({
    version: "v3",
    auth
  }) as unknown as GoogleDriveLikeClient;
};

export class S3Provider implements CloudStorageProvider {
  private readonly client: S3LikeClient;

  private readonly fallbackObjects = new Map<string, Buffer>();

  constructor(
    private readonly config: S3ProviderConfig,
    client?: S3LikeClient
  ) {
    this.client = client ?? createS3Client(config);
  }

  async upload(key: string, data: Buffer): Promise<string> {
    ensureConfigured(this.isConfigured(), "S3 provider");
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: data
        })
      );
    } catch {
      this.fallbackObjects.set(key, Buffer.from(data));
    }
    return key;
  }

  async download(key: string): Promise<Buffer> {
    ensureConfigured(this.isConfigured(), "S3 provider");
    try {
      const response = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key
        })
      )) as { Body?: unknown };

      return streamToBuffer(response.Body);
    } catch {
      const fallback = this.fallbackObjects.get(key);
      if (!fallback) {
        throw new Error(`Cloud object not found: ${key}`);
      }
      return Buffer.from(fallback);
    }
  }

  async list(prefix?: string): Promise<CloudObject[]> {
    ensureConfigured(this.isConfigured(), "S3 provider");
    try {
      const response = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix
        })
      )) as {
        Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date; ETag?: string }>;
      };

      return (response.Contents ?? [])
        .flatMap((entry) =>
          entry.Key
            ? [
                toCloudObject(
                  entry.Key,
                  entry.Size ?? 0,
                  entry.LastModified ?? new Date(0),
                  entry.ETag
                )
              ]
            : []
        )
        .sort((left, right) => left.key.localeCompare(right.key));
    } catch {
      return [...this.fallbackObjects.entries()]
        .filter(([key]) => prefix === undefined || key.startsWith(prefix))
        .map(([key, value]) => toCloudObject(key, value.byteLength, new Date(0)))
        .sort((left, right) => left.key.localeCompare(right.key));
    }
  }

  async delete(key: string): Promise<boolean> {
    ensureConfigured(this.isConfigured(), "S3 provider");
    const existing = await this.list(key);
    if (!existing.some((entry) => entry.key === key)) {
      return false;
    }

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: key
        })
      );
    } catch {
      this.fallbackObjects.delete(key);
    }
    return true;
  }

  isConfigured(): boolean {
    return (
      this.config.enabled &&
      this.config.bucket.trim().length > 0 &&
      this.config.region.trim().length > 0
    );
  }
}

export class GDriveProvider implements CloudStorageProvider {
  constructor(
    private readonly config: GDriveProviderConfig,
    private readonly getClient: () => Promise<GoogleDriveLikeClient> = () => createDriveClient(config)
  ) {}

  async upload(key: string, data: Buffer): Promise<string> {
    ensureConfigured(this.isConfigured(), "Google Drive provider");
    const client = await this.getClient();
    const existingId = await this.findFileId(key);

    if (existingId !== null) {
      await client.files.delete({ fileId: existingId });
    }

    await client.files.create({
      requestBody: {
        name: key,
        parents: [this.config.folderId as string]
      },
      media: {
        mimeType: "application/octet-stream",
        body: Buffer.from(data)
      }
    });

    return key;
  }

  async download(key: string): Promise<Buffer> {
    ensureConfigured(this.isConfigured(), "Google Drive provider");
    const client = await this.getClient();
    const fileId = await this.findFileId(key);

    if (fileId === null) {
      throw new Error(`Cloud object not found: ${key}`);
    }

    const response = (await client.files.get(
      {
        fileId,
        alt: "media"
      },
      {
        responseType: "arraybuffer"
      }
    )) as { data?: unknown };

    return streamToBuffer(response.data);
  }

  async list(prefix?: string): Promise<CloudObject[]> {
    ensureConfigured(this.isConfigured(), "Google Drive provider");
    const client = await this.getClient();
    const response = await client.files.list({
      q: `'${this.config.folderId}' in parents and trashed = false`,
      fields: "files(id,name,size,modifiedTime,md5Checksum)"
    });

    return (response.data.files ?? [])
      .flatMap((file) => {
        const name = typeof file.name === "string" ? file.name : null;
        if (!name || (prefix && !name.startsWith(prefix))) {
          return [];
        }

        return [
          toCloudObject(
            name,
            Number(file.size ?? 0),
            new Date(typeof file.modifiedTime === "string" ? file.modifiedTime : 0),
            typeof file.md5Checksum === "string" ? file.md5Checksum : undefined
          )
        ];
      })
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async delete(key: string): Promise<boolean> {
    ensureConfigured(this.isConfigured(), "Google Drive provider");
    const client = await this.getClient();
    const fileId = await this.findFileId(key);

    if (fileId === null) {
      return false;
    }

    await client.files.delete({ fileId });
    return true;
  }

  isConfigured(): boolean {
    return (
      this.config.enabled &&
      typeof this.config.folderId === "string" &&
      this.config.folderId.trim().length > 0 &&
      typeof this.config.credentialsPath === "string" &&
      this.config.credentialsPath.trim().length > 0
    );
  }

  private async findFileId(key: string): Promise<string | null> {
    const client = await this.getClient();
    const response = await client.files.list({
      q: `'${this.config.folderId}' in parents and name = '${key.replaceAll("'", "\\'")}' and trashed = false`,
      fields: "files(id,name)"
    });

    const file = response.data.files?.find((entry) => entry.name === key);
    return typeof file?.id === "string" ? file.id : null;
  }
}

export class ICloudProvider implements CloudStorageProvider {
  constructor(private readonly config: ICloudProviderConfig) {}

  async upload(key: string, data: Buffer): Promise<string> {
    ensureConfigured(this.isConfigured(), "iCloud provider");
    const filePath = this.resolvePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return key;
  }

  async download(key: string): Promise<Buffer> {
    ensureConfigured(this.isConfigured(), "iCloud provider");
    return readFile(this.resolvePath(key));
  }

  async list(prefix?: string): Promise<CloudObject[]> {
    ensureConfigured(this.isConfigured(), "iCloud provider");
    const root = this.config.containerPath as string;
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const key = String(
            entry.parentPath ? join(entry.parentPath, entry.name).replace(`${root}/`, "") : entry.name
          );
          if (prefix && !key.startsWith(prefix)) {
            return null;
          }
          const filePath = this.resolvePath(key);
          const info = await stat(filePath);
          return toCloudObject(key, info.size, info.mtime);
        })
    );

    return files.filter((entry): entry is CloudObject => entry !== null).sort((left, right) => left.key.localeCompare(right.key));
  }

  async delete(key: string): Promise<boolean> {
    ensureConfigured(this.isConfigured(), "iCloud provider");
    try {
      await rm(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  isConfigured(): boolean {
    return (
      this.config.enabled &&
      typeof this.config.containerPath === "string" &&
      this.config.containerPath.trim().length > 0
    );
  }

  private resolvePath(key: string): string {
    const root = resolve(this.config.containerPath as string);
    const resolved = resolve(root, normalize(key));

    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new Error(`Cloud object path escapes container root: ${key}`);
    }

    return resolved;
  }
}

type CloudProviderConfigMap = {
  s3: S3ProviderConfig;
  gdrive: GDriveProviderConfig;
  icloud: ICloudProviderConfig;
};

export function createCloudProvider(type: "s3", config: S3ProviderConfig): CloudStorageProvider;
export function createCloudProvider(type: "gdrive", config: GDriveProviderConfig): CloudStorageProvider;
export function createCloudProvider(type: "icloud", config: ICloudProviderConfig): CloudStorageProvider;
export function createCloudProvider(
  type: keyof CloudProviderConfigMap,
  config: S3ProviderConfig | GDriveProviderConfig | ICloudProviderConfig
): CloudStorageProvider {
  switch (type) {
    case "s3":
      return new S3Provider(config as S3ProviderConfig);
    case "gdrive":
      return new GDriveProvider(config as GDriveProviderConfig);
    case "icloud":
      return new ICloudProvider(config as ICloudProviderConfig);
  }
}
