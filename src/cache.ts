// Poly SDK - Patch Cache (TTL + LRU eviction)

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
  accessOrder: number; // monotonic counter for precise LRU
}

// Configurable limits
const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
let maxSize = DEFAULT_MAX_SIZE;
let ttlMs = DEFAULT_TTL_MS;

// In-memory cache: insertion-order map (Map guarantees iteration order)
const cache = new Map<string, CacheEntry>();
let accessCounter = 0; // monotonic counter for precise LRU ordering

/**
 * Configure cache limits
 */
export function configureCache(options: { maxSize?: number; ttlMs?: number }): void {
  if (options.maxSize && options.maxSize > 0) maxSize = options.maxSize;
  if (options.ttlMs && options.ttlMs > 0) ttlMs = options.ttlMs;
}

/** Evict expired entries */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.createdAt > ttlMs) {
      cache.delete(key);
    }
  }
}

/** Evict least-recently-used entry when at or over max size */
function evictLRU(): void {
  if (cache.size < maxSize) return;

  // Find entry with smallest accessOrder (least recently used)
  let oldestKey: string | null = null;
  let oldestOrder = Infinity;

  for (const [key, entry] of cache.entries()) {
    if (entry.accessOrder < oldestOrder) {
      oldestOrder = entry.accessOrder;
      oldestKey = key;
    }
  }

  if (oldestKey) cache.delete(oldestKey);
}

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
  // Evict expired on read
  evictExpired();

  const entry = cache.get(key);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.createdAt > ttlMs) {
    cache.delete(key);
    return null;
  }

  entry.hitCount++;
  entry.lastUsed = Date.now();
  entry.accessOrder = ++accessCounter;
  return entry.patches;
}

export function setCachedPatch(
  key: string,
  tenantId: string,
  endpoint: string,
  patches: PatchOperation[],
  confidence: number
): void {
  // Evict expired + LRU before adding
  evictExpired();
  evictLRU();

  cache.set(key, {
    key,
    tenantId,
    endpoint,
    patches,
    confidence,
    hitCount: 0,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    accessOrder: ++accessCounter,
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

export function getCacheStats(): { size: number; totalHits: number; maxSize: number; ttlMs: number } {
  let totalHits = 0;
  for (const entry of cache.values()) {
    totalHits += entry.hitCount;
  }
  return { size: cache.size, totalHits, maxSize, ttlMs };
}

/** Get cache config for diagnostics */
export function getCacheConfig(): { maxSize: number; ttlMs: number } {
  return { maxSize, ttlMs };
}
