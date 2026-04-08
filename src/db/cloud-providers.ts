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

type StoredObject = {
  data: Buffer;
  meta: CloudObject;
};

const cloneCloudObject = (object: CloudObject): CloudObject => ({
  ...object,
  lastModified: new Date(object.lastModified)
});

const requireStoredObject = (object: StoredObject | undefined, key: string): StoredObject => {
  if (object === undefined) {
    throw new Error(`Cloud object not found: ${key}`);
  }

  return object;
};

abstract class StubCloudStorageProvider implements CloudStorageProvider {
  private readonly objects = new Map<string, StoredObject>();

  protected abstract readonly label: string;

  protected abstract canConfigure(): boolean;

  protected getUploadTarget(key: string): string {
    return key;
  }

  async upload(key: string, data: Buffer): Promise<string> {
    const buffer = Buffer.from(data);
    const now = new Date();

    this.objects.set(key, {
      data: buffer,
      meta: {
        key,
        size: buffer.byteLength,
        lastModified: now,
        etag: `stub-${buffer.byteLength}-${now.getTime()}`
      }
    });

    console.log(`${this.label}: would upload to ${this.getUploadTarget(key)}`);
    return key;
  }

  async download(key: string): Promise<Buffer> {
    return Buffer.from(requireStoredObject(this.objects.get(key), key).data);
  }

  async list(prefix?: string): Promise<CloudObject[]> {
    return [...this.objects.values()]
      .map((object) => cloneCloudObject(object.meta))
      .filter((object) => prefix === undefined || object.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  isConfigured(): boolean {
    return this.canConfigure();
  }
}

export class S3Provider extends StubCloudStorageProvider {
  protected readonly label = "S3 stub";

  constructor(private readonly config: S3ProviderConfig) {
    super();
  }

  protected canConfigure(): boolean {
    return (
      this.config.enabled &&
      this.config.bucket.trim().length > 0 &&
      this.config.region.trim().length > 0
    );
  }

  protected getUploadTarget(key: string): string {
    return `s3://${this.config.bucket}/${key}`;
  }
}

export class GDriveProvider extends StubCloudStorageProvider {
  protected readonly label = "GDrive stub";

  constructor(private readonly config: GDriveProviderConfig) {
    super();
  }

  protected canConfigure(): boolean {
    return (
      this.config.enabled &&
      typeof this.config.folderId === "string" &&
      this.config.folderId.trim().length > 0 &&
      typeof this.config.credentialsPath === "string" &&
      this.config.credentialsPath.trim().length > 0
    );
  }
}

export class ICloudProvider extends StubCloudStorageProvider {
  protected readonly label = "iCloud stub";

  constructor(private readonly config: ICloudProviderConfig) {
    super();
  }

  protected canConfigure(): boolean {
    return (
      this.config.enabled &&
      typeof this.config.containerPath === "string" &&
      this.config.containerPath.trim().length > 0
    );
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
