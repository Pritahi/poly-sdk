// Poly SDK - Main Entry Point
// npm install poly-sdk
//
// import { Poly } from "poly-sdk"
//
// // Simple (singleton):
// Poly.init({ apiKey: "poly_live_xxx" })
// Poly.wrap(axios)
//
// // Multi-instance:
// const poly1 = Poly.createInstance({ apiKey: "key_1" })
// const poly2 = Poly.createInstance({ apiKey: "key_2" })
// poly1.wrap(axios1)
// poly2.wrapFetch()

import {
  PolyConfig,
  DriftEvent,
  PatchOperation,
  DriftAnalysisResponse,
  AxiosInstance,
  SchemaField,
} from "./types";

import { inferSchema, detectDrift, serializeSchema } from "./schema";
import { applyPatches } from "./transformer";
import {
  generateCacheKey,
  getCachedPatch,
  setCachedPatch,
  invalidateCache,
  invalidateEndpoint,
  clearCache as clearPatchCache,
  getCacheStats,
  configureCache,
  getCacheConfig,
} from "./cache";

const DEFAULT_ENDPOINT = "https://api.poly.dev";
const DEFAULT_CONFIDENCE_THRESHOLD = 98;

type Listener = (event: DriftEvent | PatchOperation | Error) => void;

// ═══════════════════════════════════════════════
// PolyInstance — fully isolated instance
// ═══════════════════════════════════════════════
export class PolyInstance {
  private config: PolyConfig | null = null;
  private baselineSchemas = new Map<string, SchemaField[]>();
  private disabled = false;
  private originalFetch: typeof fetch | null = null;
  private listeners = new Map<string, Listener[]>();
  private offlineQueue: Array<{ endpoint: string; method: string; expected: SchemaField[]; actual: SchemaField[]; timestamp: number }> = [];
  private queueMaxSize = 100;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  // ─── Init ───
  init(options: PolyConfig): void {
    this.config = options;
    this.disabled = false;
    this.baselineSchemas.clear();
  }

  // ─── Helpers ───
  private emit(event: string, data: unknown): void {
    const cbs = this.listeners.get(event) || [];
    for (const cb of cbs) cb(data as never);
  }

  private isDisabled(): boolean {
    if (this.disabled) return true;
    if (this.config?.disable) return true;
    if (typeof process !== "undefined" && process.env.POLY_DISABLE === "1") return true;
    return false;
  }

  private getEndpoint(): string {
    return this.config?.endpoint || DEFAULT_ENDPOINT;
  }

  private getConfidenceThreshold(): number {
    return this.config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  }

  // ─── Axios ───
  wrap(axios: AxiosInstance): AxiosInstance {
    if (this.isDisabled()) return axios;

    axios.interceptors.response.use(
      async (response) => {
        await this.handleResponse(response.config as Record<string, unknown>, response.data);
        return response;
      },
      (error) => {
        if (this.config?.onError) this.config.onError(error instanceof Error ? error : new Error(String(error)));
        return Promise.reject(error);
      }
    );
    return axios;
  }

  // ─── Fetch ───
  wrapFetch(): typeof fetch {
    if (this.isDisabled()) return fetch.bind(typeof globalThis !== "undefined" ? globalThis : global);
    if (!this.originalFetch) {
      this.originalFetch = (typeof globalThis !== "undefined" ? globalThis.fetch : (global as any).fetch);
    }
    const self = this;
    const orig = this.originalFetch;

    const polyFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const method = init?.method?.toUpperCase() || "GET";
      const response = await orig!(input, init);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) return response;
      const clone = response.clone();
      try {
        const bodyText = await clone.text();
        let responseData: unknown;
        try { responseData = JSON.parse(bodyText); } catch { return response; }
        if (!responseData || typeof responseData !== "object") return response;
        const patchedData = await self.handleFetchResponse({ url, method }, JSON.parse(JSON.stringify(responseData)));
        if (patchedData) {
          return new Response(JSON.stringify(patchedData), { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
      } catch { return response; }
    };

    if (typeof globalThis !== "undefined") (globalThis as any).fetch = polyFetch;
    else (global as any).fetch = polyFetch;
    return polyFetch as any;
  }

  createFetch(): typeof fetch {
    const baseFetch = (typeof globalThis !== "undefined" ? globalThis.fetch : (global as any).fetch).bind(globalThis || global);
    const self = this;

    return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (self.isDisabled()) return baseFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const method = init?.method?.toUpperCase() || "GET";
      const response = await baseFetch(input, init);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) return response;
      const clone = response.clone();
      try {
        const bodyText = await clone.text();
        let responseData: unknown;
        try { responseData = JSON.parse(bodyText); } catch { return response; }
        if (!responseData || typeof responseData !== "object") return response;
        const patchedData = await self.handleFetchResponse({ url, method }, JSON.parse(JSON.stringify(responseData)));
        if (patchedData) {
          return new Response(JSON.stringify(patchedData), { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
      } catch { return response; }
    }) as any;
  }

  unwrapFetch(): void {
    if (this.originalFetch) {
      if (typeof globalThis !== "undefined") (globalThis as any).fetch = this.originalFetch;
      else (global as any).fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  // ─── Manual analysis ───
  analyzeResponse(requestConfig: Record<string, unknown>, responseData: unknown): void {
    if (this.isDisabled()) return;
    this.handleResponse(requestConfig, responseData);
  }

  // ─── Cache ───
  invalidateCache(endpoint: string): number {
    if (!this.config) return 0;
    return invalidateEndpoint(this.config.apiKey, endpoint);
  }

  clearCache(): number { return clearPatchCache(); }

  getCacheStats(): { size: number; totalHits: number; maxSize: number; ttlMs: number } { return getCacheStats(); }

  configureCache(options: { maxSize?: number; ttlMs?: number }): void { configureCache(options); }

  getCacheConfig(): { maxSize: number; ttlMs: number } { return getCacheConfig(); }

  // ─── Kill switch ───
  disable(): void { this.disabled = true; }
  enable(): void { this.disabled = false; }
  isPolyDisabled(): boolean { return this.isDisabled(); }

  // ─── Events ───
  on(event: string, callback: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback: Listener): void {
    const cbs = this.listeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx > -1) cbs.splice(idx, 1);
    }
  }

  // ─── Misc ───
  async rollback(patchId: string): Promise<void> {
    console.log(`[Poly] Rollback requested for patch: ${patchId}`);
  }

  getBaseline(endpoint: string): SchemaField[] | null {
    return this.baselineSchemas.get(endpoint) || null;
  }

  // ══════════════════════════════════════
  // INTERNAL
  // ══════════════════════════════════════

  private async handleFetchResponse(
    requestConfig: Record<string, unknown>,
    responseData: unknown
  ): Promise<unknown | null> {
    if (!this.config || this.isDisabled()) return null;
    if (!responseData || typeof responseData !== "object") return null;

    const url = (requestConfig.url as string) || "";
    const method = ((requestConfig.method as string) || "GET").toUpperCase();

    try {
      const currentSchema = inferSchema(responseData);
      const endpoint = this.extractEndpoint(url);

      if (!this.baselineSchemas.has(endpoint)) {
        this.baselineSchemas.set(endpoint, currentSchema);
        return null;
      }

      const expectedSchema = this.baselineSchemas.get(endpoint)!;
      const driftResults = detectDrift(expectedSchema, currentSchema);
      if (driftResults.length === 0) return null;

      for (const drift of driftResults) {
        const event: DriftEvent = {
          type: drift.type as DriftEvent["type"], path: drift.path,
          expected: drift.expected, actual: drift.actual,
          severity: drift.severity, timestamp: Date.now(),
        };
        this.emit("drift", event);
        if (this.config.onDrift) this.config.onDrift(event);
      }

      const sig = JSON.stringify(responseData).slice(0, 100);
      const cacheKey = generateCacheKey(this.config.apiKey, method, this.extractHost(url), endpoint, sig);
      const cached = getCachedPatch(cacheKey);

      if (cached) {
        if (!this.config.dryRun) return applyPatches(responseData, cached);
        return null;
      }

      const result = await this.requestAnalysis(endpoint, method, expectedSchema, currentSchema);
      if (!result || result.mapping.length === 0) {
        // Cloud unreachable — queue for later
        if (!result) this.enqueueOffline(endpoint, method, expectedSchema, currentSchema);
        return null;
      }

      setCachedPatch(cacheKey, this.config.apiKey, endpoint, result.mapping, result.confidence);

      if (result.confidence >= this.getConfidenceThreshold() && !this.config.dryRun) {
        const patched = applyPatches(responseData, result.mapping);
        for (const p of result.mapping) { this.emit("patch", p); if (this.config.onPatch) this.config.onPatch(p); }
        if (result.autoPatch) this.baselineSchemas.set(endpoint, currentSchema);
        return patched;
      }
      return null;
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      if (this.config?.onError) this.config.onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private async handleResponse(
    requestConfig: Record<string, unknown>,
    responseData: unknown
  ): Promise<void> {
    if (!this.config || this.isDisabled()) return;
    if (!responseData || typeof responseData !== "object") return;

    const url = (requestConfig.url as string) || "";
    const method = ((requestConfig.method as string) || "GET").toUpperCase();

    try {
      const currentSchema = inferSchema(responseData);
      const endpoint = this.extractEndpoint(url);

      if (!this.baselineSchemas.has(endpoint)) {
        this.baselineSchemas.set(endpoint, currentSchema);
        return;
      }

      const expectedSchema = this.baselineSchemas.get(endpoint)!;
      const driftResults = detectDrift(expectedSchema, currentSchema);
      if (driftResults.length === 0) return;

      for (const drift of driftResults) {
        const event: DriftEvent = {
          type: drift.type as DriftEvent["type"], path: drift.path,
          expected: drift.expected, actual: drift.actual,
          severity: drift.severity, timestamp: Date.now(),
        };
        this.emit("drift", event);
        if (this.config.onDrift) this.config.onDrift(event);
      }

      const sig = JSON.stringify(responseData).slice(0, 100);
      const cacheKey = generateCacheKey(this.config.apiKey, method, this.extractHost(url), endpoint, sig);
      const cached = getCachedPatch(cacheKey);

      if (cached) {
        if (!this.config.dryRun) {
          Object.assign(responseData as Record<string,unknown>, applyPatches(responseData, cached) as Record<string,unknown>);
        }
        return;
      }

      const result = await this.requestAnalysis(endpoint, method, expectedSchema, currentSchema);
      if (!result || result.mapping.length === 0) {
        if (!result) this.enqueueOffline(endpoint, method, expectedSchema, currentSchema);
        return;
      }

      setCachedPatch(cacheKey, this.config.apiKey, endpoint, result.mapping, result.confidence);

      if (result.confidence >= this.getConfidenceThreshold() && !this.config.dryRun) {
        Object.assign(responseData as Record<string,unknown>, applyPatches(responseData, result.mapping) as Record<string,unknown>);
        for (const p of result.mapping) { this.emit("patch", p); if (this.config.onPatch) this.config.onPatch(p); }
      }

      if (result.autoPatch) this.baselineSchemas.set(endpoint, currentSchema);
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      if (this.config?.onError) this.config.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async requestAnalysis(
    endpoint: string, method: string,
    expected: SchemaField[], actual: SchemaField[]
  ): Promise<DriftAnalysisResponse | null> {
    if (!this.config) return null;
    try {
      const response = await fetch(`${this.getEndpoint()}/api/analyze-drift`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Poly-API-Key": this.config.apiKey },
        body: JSON.stringify({
          tenantId: this.config.apiKey, endpoint, method,
          expectedSchema: serializeSchema(expected),
          actualSchema: serializeSchema(actual),
          rules: this.config.rules || [],
        }),
      });
      if (!response.ok) {
        console.error(`[Poly] Analysis request failed: ${response.status}`);
        return null;
      }
      return await response.json() as DriftAnalysisResponse;
    } catch (error) {
      console.error("[Poly] Failed to reach Poly Cloud:", error);
      return null;
    }
  }

  private extractEndpoint(url: string): string {
    try { return new URL(url).pathname; } catch { return url; }
  }

  private extractHost(url: string): string {
    try { return new URL(url).host; } catch { return "unknown"; }
  }

  // ─── Offline Queue ───

  /** Number of pending offline drift events */
  get pendingQueueSize(): number { return this.offlineQueue.length; }

  /** Manually flush the offline queue (auto-flushes every 60s) */
  async flushQueue(): Promise<number> {
    if (this.flushing || this.offlineQueue.length === 0) return 0;
    this.flushing = true;
    let flushed = 0;
    const batch = [...this.offlineQueue];
    this.offlineQueue = [];

    for (const item of batch) {
      try {
        const result = await this.requestAnalysis(item.endpoint, item.method, item.expected, item.actual);
        if (result) flushed++;
        else this.offlineQueue.push(item); // Re-queue if failed
      } catch {
        this.offlineQueue.push(item); // Re-queue on error
      }
    }
    this.flushing = false;
    return flushed;
  }

  private enqueueOffline(endpoint: string, method: string, expected: SchemaField[], actual: SchemaField[]): void {
    if (this.offlineQueue.length >= this.queueMaxSize) this.offlineQueue.shift(); // Drop oldest
    this.offlineQueue.push({ endpoint, method, expected, actual, timestamp: Date.now() });
    // Auto-flush every 60s
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushQueue(); this.flushTimer = null; }, 60_000);
    }
  }
}

// ═══════════════════════════════════════════════
// Static Poly — singleton + factory (backward compatible)
// ═══════════════════════════════════════════════
const defaultInstance = new PolyInstance();

export const Poly = {
  /** Create a new independent Poly instance (for multi-tenant / multi-config use) */
  createInstance(options?: PolyConfig): PolyInstance {
    const instance = new PolyInstance();
    if (options) instance.init(options);
    return instance;
  },

  // ─── Delegated to default instance (backward compatible) ───
  init: (o: PolyConfig) => defaultInstance.init(o),
  wrap: (a: AxiosInstance) => defaultInstance.wrap(a),
  wrapFetch: () => defaultInstance.wrapFetch(),
  createFetch: () => defaultInstance.createFetch(),
  unwrapFetch: () => defaultInstance.unwrapFetch(),
  analyzeResponse: (c: Record<string, unknown>, d: unknown) => defaultInstance.analyzeResponse(c, d),
  invalidateCache: (e: string) => defaultInstance.invalidateCache(e),
  clearCache: () => defaultInstance.clearCache(),
  getCacheStats: () => defaultInstance.getCacheStats(),
  configureCache: (o: { maxSize?: number; ttlMs?: number }) => defaultInstance.configureCache(o),
  getCacheConfig: () => defaultInstance.getCacheConfig(),
  disable: () => defaultInstance.disable(),
  enable: () => defaultInstance.enable(),
  isDisabled: () => defaultInstance.isPolyDisabled(),
  on: (e: string, c: Listener) => defaultInstance.on(e, c),
  off: (e: string, c: Listener) => defaultInstance.off(e, c),
  rollback: (id: string) => defaultInstance.rollback(id),
  getBaseline: (e: string) => defaultInstance.getBaseline(e),
  get pendingQueueSize() { return defaultInstance.pendingQueueSize; },
  flushQueue: () => defaultInstance.flushQueue(),
};
