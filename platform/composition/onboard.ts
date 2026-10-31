/* Writing and probing the app config files; building their text is the app-catalog's. */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function writeConfig(name: string, yaml: string, root = process.cwd()): string {
  const dir = join(root, "config", "apps");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, yaml, "utf8");
  return path;
}

export function configExists(name: string, root = process.cwd()): boolean {
  return existsSync(join(root, "config", "apps", `${name}.yaml`));
}
