// Poly SDK - Patch Cache

import { PatchOperation } from "./types";

interface CacheEntry {
  key: string;
  tenantId: string;
  endpoint: string;
  patches: PatchOperation[];
  confidence: number;
  hitCount: number;
  createdAt: number;
  lastUsed: number;
}

const cache = new Map<string, CacheEntry>();

export function generateCacheKey(
  tenantId: string,
  method: string,
  host: string,
  endpointPath: string,
  responseSignature: string
): string {
  const raw = `${tenantId}:${method}:${host}:${endpointPath}:${responseSignature}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function getCachedPatch(key: string): PatchOperation[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  entry.hitCount++;
  entry.lastUsed = Date.now();
  return entry.patches;
}

export function setCachedPatch(
  key: string,
  tenantId: string,
  endpoint: string,
  patches: PatchOperation[],
  confidence: number
): void {
  cache.set(key, {
    key,
    tenantId,
    endpoint,
    patches,
    confidence,
    hitCount: 0,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  });
}

export function invalidateCache(key: string): boolean {
  return cache.delete(key);
}

export function invalidateEndpoint(tenantId: string, endpoint: string): number {
  let count = 0;
  for (const [key, entry] of cache.entries()) {
    if (entry.tenantId === tenantId && entry.endpoint === endpoint) {
      cache.delete(key);
      count++;
    }
  }
  return count;
}

export function clearCache(): number {
  const size = cache.size;
  cache.clear();
  return size;
}

export function getCacheStats(): { size: number; totalHits: number } {
  let totalHits = 0;
  for (const entry of cache.values()) {
    totalHits += entry.hitCount;
  }
  return { size: cache.size, totalHits };
}
