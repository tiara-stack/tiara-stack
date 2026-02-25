import { createStorage, type Driver } from "unstorage";

/**
 * Create Better Auth secondary storage from an unstorage driver.
 * This allows easy switching between drivers (Redis, fs, S3, etc.)
 *
 * @see https://unstorage.unjs.io/drivers
 */
export interface SecondaryStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

export function createSecondaryStorage(driver: Driver): SecondaryStorage {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const storage = createStorage<Uint8Array>({ driver });

  return {
    async get(key: string) {
      const item = await storage.getItemRaw<Uint8Array>(key);
      const decoded = item ? decoder.decode(item) : null;
      return decoded;
    },
    async set(key: string, value: string, ttl?: number) {
      const encoded = encoder.encode(value);
      if (ttl) {
        await storage.setItemRaw<Uint8Array>(key, encoded, { ttl });
      } else {
        await storage.setItemRaw<Uint8Array>(key, encoded);
      }
    },
    async delete(key: string) {
      await storage.removeItem(key);
    },
    async close() {
      // Unstorage drivers expose dispose or underlying instance
      const driverInstance = driver as {
        dispose?: () => Promise<void>;
        getInstance?: () => { quit: () => Promise<void> };
      };
      if (driverInstance.dispose) {
        await driverInstance.dispose();
      } else if (driverInstance.getInstance) {
        // ioredis-specific: quit gracefully
        await driverInstance.getInstance().quit();
      } else {
        console.warn("Storage driver does not expose cleanup method");
      }
    },
  };
}
