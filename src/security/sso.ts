import type { SSOUser } from "../core/types.js";

export class SSOProvider {
  constructor(private readonly _config: unknown) {}

  async validateToken(_token: string): Promise<SSOUser | null> {
    return null;
  }

  isConfigured(): boolean {
    return false;
  }
}
