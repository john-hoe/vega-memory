import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";

export class AlertFileWriter {
  readonly #alertDir: string;

  constructor(alertDir: string = resolve(process.cwd(), "data", "alerts")) {
    this.#alertDir = alertDir;
  }

  write(message: string): void {
    mkdirSync(this.#alertDir, { recursive: true });
    writeFileSync(this.#getAlertPath(), message, "utf8");
  }

  clear(): void {
    const alertPath = this.#getAlertPath();

    if (existsSync(alertPath)) {
      unlinkSync(alertPath);
    }
  }

  read(): string | null {
    const alertPath = this.#getAlertPath();

    if (!existsSync(alertPath)) {
      return null;
    }

    return readFileSync(alertPath, "utf8");
  }

  #getAlertPath(): string {
    return join(this.#alertDir, "active-alert.md");
  }
}
