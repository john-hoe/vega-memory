import { Command } from "commander";

import { generateKey } from "../../security/encryption.js";
import {
  VEGA_ENCRYPTION_ACCOUNT,
  VEGA_KEYCHAIN_SERVICE,
  getKey,
  setKey
} from "../../security/keychain.js";

export function registerEncryptionCommand(program: Command): void {
  program
    .command("init-encryption")
    .description("Generate and store an encryption key in the macOS Keychain")
    .action(async () => {
      if (process.platform !== "darwin") {
        throw new Error("init-encryption is only supported on macOS");
      }

      const existingKey = await getKey(
        VEGA_KEYCHAIN_SERVICE,
        VEGA_ENCRYPTION_ACCOUNT
      );

      if (existingKey !== null) {
        console.log("Encryption key already configured");
        return;
      }

      await setKey(
        VEGA_KEYCHAIN_SERVICE,
        VEGA_ENCRYPTION_ACCOUNT,
        generateKey()
      );
      console.log("Encryption key configured in macOS Keychain");
    });
}
