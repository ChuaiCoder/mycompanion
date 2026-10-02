import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bindBrowserPort, buildApp } from "@mycompanion/local-service";

interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Own SQLite/model service; no Tavern process, frontend or data conversion. */
export async function startIndependentService(options: {
  dataRoot: string;
  rendererRoot: string;
  storage: SecretStorage;
}) {
  await mkdir(options.dataRoot, { recursive: true });
  if (!options.storage.isEncryptionAvailable()) throw new Error("系统密钥加密不可用，无法打开本地服务。");
  const databasePath = join(options.dataRoot, "mycompanion.sqlite");
  const service = buildApp({
    databasePath, rendererRoot: options.rendererRoot,
    secretCodec: {
      seal: value => options.storage.encryptString(value).toString("base64"),
      unseal: value => options.storage.decryptString(Buffer.from(value, "base64")),
    },
  });
  try {
    const origin = await bindBrowserPort(port => service.listen({ host: "127.0.0.1", port }));
    return { origin, databasePath, stop: () => service.close() };
  } catch (error) {
    await service.close();
    throw error;
  }
}
