import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "dist", "web", "public");
const src = join(root, "src", "web", "public");

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
