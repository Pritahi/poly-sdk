// Poly SDK - Main Entry Point
// npm install poly-sdk
//
// import { Poly } from "poly-sdk"
// Poly.init({ apiKey: "poly_live_xxx" })
// Poly.wrap(axios)

import {
  PolyConfig,
  DriftEvent,
  PatchOperation,
  DriftAnalysisResponse,
  AxiosInstance,
  RuleDefinition,
  SchemaField,
} from "./types";

import { inferSchema, detectDrift, serializeSchema, DriftResult } from "./schema";
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

// Singleton state
let config: PolyConfig | null = null;
let baselineSchemas = new Map<string, SchemaField[]>();
let disabled = false;
let originalFetch: typeof fetch | null = null;

// Event listeners
type Listener = (event: DriftEvent | PatchOperation | Error) => void;
const listeners = new Map<string, Listener[]>();

function emit(event: string, data: unknown): void {
  const cbs = listeners.get(event) || [];
  for (const cb of cbs) cb(data as never);
}

function isDisabled(): boolean {
  if (disabled) return true;
  if (config?.disable) return true;
  if (typeof process !== "undefined" && process.env.POLY_DISABLE === "1") return true;
  return false;
}

function getEndpoint(): string {
  return config?.endpoint || DEFAULT_ENDPOINT;
}

function getConfidenceThreshold(): number {
  return config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
}

// ─── PUBLIC API ────────────────────────────────────────────

export const Poly = {
  /**
   * Initialize the Poly SDK with your API key and options
   */
  init(options: PolyConfig): void {
    config = options;
    disabled = false;
    baselineSchemas.clear();
  },

  /**
   * Wrap an Axios instance to intercept responses and detect drift
   */
  wrap(axios: AxiosInstance): AxiosInstance {
    if (isDisabled()) return axios;

    // Add response interceptor
    axios.interceptors.response.use(
      async (response) => {
        await handleResponse(response.config as Record<string, unknown>, response.data);
        return response;
      },
      (error) => {
        if (config?.onError) config.onError(error instanceof Error ? error : new Error(String(error)));
        return Promise.reject(error);
      }
    );

    return axios;
  },

  /**
   * Wrap the global fetch function to intercept responses and detect drift.
   * Works with native fetch, node-fetch, undici, etc.
   *
   * @example
   * Poly.wrapFetch()
   * const res = await fetch("https://api.example.com/users")
   * const data = await res.json() // automatically drift-protected
   */
  wrapFetch(): typeof fetch {
    if (isDisabled()) return fetch.bind(typeof globalThis !== "undefined" ? globalThis : global);

    // Save original fetch before replacing
    if (!originalFetch) {
      originalFetch = (typeof globalThis !== "undefined" ? globalThis.fetch : global.fetch);
    }

    const polyFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const method = init?.method?.toUpperCase() || "GET";

      // Call original fetch
      const response = await originalFetch!(input, init);

      // Only process JSON responses
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) return response;

      // Clone so we can read body without consuming it
      const clone = response.clone();

      try {
        const bodyText = await clone.text();
        let responseData: unknown;
        try { responseData = JSON.parse(bodyText); } catch { return response; }

        if (!responseData || typeof responseData !== "object") return response;

        // Run drift detection (may patch in-place via handleResponse)
        const patchedData = await handleFetchResponse(
          { url, method },
          JSON.parse(JSON.stringify(responseData)) // deep copy for analysis
        );

        if (patchedData) {
          // Patches applied — return new Response with modified body
          return new Response(JSON.stringify(patchedData), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return response;
      } catch {
        return response; // If anything fails, return original
      }
    };

    // Replace global fetch
    if (typeof globalThis !== "undefined") {
      (globalThis as Record<string, unknown>).fetch = polyFetch as typeof fetch;
    } else {
      (global as Record<string, unknown>).fetch = polyFetch as typeof fetch;
    }

    return polyFetch as unknown as typeof fetch;
  },

  /**
   * Create a stand-alone Poly-wrapped fetch without replacing the global.
   * Use this when you want to keep the original fetch available.
   *
   * @example
   * const polyFetch = Poly.createFetch()
   * const res = await polyFetch("https://api.example.com/users")
   */
  createFetch(): typeof fetch {
    const baseFetch = (typeof globalThis !== "undefined" ? globalThis.fetch : global.fetch).bind(globalThis || global);

    return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (isDisabled()) return baseFetch(input, init);

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

        const patchedData = await handleFetchResponse(
          { url, method },
          JSON.parse(JSON.stringify(responseData))
        );

        if (patchedData) {
          return new Response(JSON.stringify(patchedData), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      } catch {
        return response;
      }
    }) as unknown as typeof fetch;
  },

  /**
   * Restore the original global fetch (undo Poly.wrapFetch)
   */
  unwrapFetch(): void {
    if (originalFetch) {
      if (typeof globalThis !== "undefined") {
        (globalThis as Record<string, unknown>).fetch = originalFetch;
      } else {
        (global as Record<string, unknown>).fetch = originalFetch;
      }
      originalFetch = null;
    }
  },

  /**
   * Manually process a response (for non-Axios clients)
   */
  analyzeResponse(requestConfig: Record<string, unknown>, responseData: unknown): void {
    if (isDisabled()) return;
    handleResponse(requestConfig, responseData);
  },

  /**
   * Invalidate cache for a specific endpoint
   */
  invalidateCache(endpoint: string): number {
    if (!config) return 0;
    return invalidateEndpoint(config.apiKey, endpoint);
  },

  /**
   * Clear all cached patches
   */
  clearCache(): number {
    return clearPatchCache();
  },

  /**
   * Disable Poly entirely (kill switch)
   */
  disable(): void {
    disabled = true;
  },

  /**
   * Re-enable Poly
   */
  enable(): void {
    disabled = false;
  },

  /**
   * Check if Poly is disabled
   */
  isDisabled(): boolean {
    return isDisabled();
  },

  /**
   * Subscribe to events: "drift" | "patch" | "error"
   */
  on(event: string, callback: Listener): void {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(callback);
  },

  /**
   * Unsubscribe from events
   */
  off(event: string, callback: Listener): void {
    const cbs = listeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx > -1) cbs.splice(idx, 1);
    }
  },

  /**
   * Rollback a previously applied patch (marks it as rolled back)
   */
  async rollback(patchId: string): Promise<void> {
    // In a real implementation, this would notify the cloud
    console.log(`[Poly] Rollback requested for patch: ${patchId}`);
  },

  /**
   * Get the current baseline schema for an endpoint
   */
  getBaseline(endpoint: string): SchemaField[] | null {
    return baselineSchemas.get(endpoint) || null;
  },

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; totalHits: number; maxSize: number; ttlMs: number } {
    return getCacheStats();
  },

  /**
   * Configure cache limits (max entries + TTL)
   * @example Poly.configureCache({ maxSize: 1000, ttlMs: 60 * 60 * 1000 }) // 1000 entries, 1 hour TTL
   */
  configureCache(options: { maxSize?: number; ttlMs?: number }): void {
    configureCache(options);
  },

  /**
   * Get current cache configuration
   */
  getCacheConfig(): { maxSize: number; ttlMs: number } {
    return getCacheConfig();
  },
};

// ─── INTERNAL ──────────────────────────────────────────────

/**
 * Handle response for fetch — returns patched data if drift was fixed, null if no changes.
 * Unlike handleResponse (axios, mutates in-place), this returns a new object.
 */
async function handleFetchResponse(
  requestConfig: Record<string, unknown>,
  responseData: unknown
): Promise<unknown | null> {
  if (!config || isDisabled()) return null;
  if (!responseData || typeof responseData !== "object") return null;

  const url = (requestConfig.url as string) || "";
  const method = ((requestConfig.method as string) || "GET").toUpperCase();

  try {
    const currentSchema = inferSchema(responseData);
    const endpoint = extractEndpoint(url);

    if (!baselineSchemas.has(endpoint)) {
      baselineSchemas.set(endpoint, currentSchema);
      return null;
    }

    const expectedSchema = baselineSchemas.get(endpoint)!;
    const driftResults = detectDrift(expectedSchema, currentSchema);

    if (driftResults.length === 0) return null;

    // Emit drift events
    for (const drift of driftResults) {
      const event: DriftEvent = {
        type: drift.type as DriftEvent["type"],
        path: drift.path,
        expected: drift.expected,
        actual: drift.actual,
        severity: drift.severity,
        timestamp: Date.now(),
      };
      emit("drift", event);
      if (config.onDrift) config.onDrift(event);
    }

    // Check cache
    const responseSignature = JSON.stringify(responseData).slice(0, 100);
    const cacheKey = generateCacheKey(config.apiKey, method, extractHost(url), endpoint, responseSignature);
    const cachedPatches = getCachedPatch(cacheKey);

    if (cachedPatches) {
      if (!config.dryRun) {
        const patched = applyPatches(responseData, cachedPatches);
        return patched;
      }
      return null;
    }

    // Cloud analysis
    const analysisResult = await requestAnalysis(endpoint, method, expectedSchema, currentSchema);
    if (!analysisResult || analysisResult.mapping.length === 0) return null;

    setCachedPatch(cacheKey, config.apiKey, endpoint, analysisResult.mapping, analysisResult.confidence);

    if (analysisResult.confidence >= getConfidenceThreshold() && !config.dryRun) {
      const patched = applyPatches(responseData, analysisResult.mapping);
      for (const patch of analysisResult.mapping) {
        emit("patch", patch);
        if (config.onPatch) config.onPatch(patch);
      }
      if (analysisResult.autoPatch) {
        baselineSchemas.set(endpoint, currentSchema);
      }
      return patched;
    }

    return null;
  } catch (error) {
    emit("error", error instanceof Error ? error : new Error(String(error)));
    if (config.onError) config.onError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

async function handleResponse(
  requestConfig: Record<string, unknown>,
  responseData: unknown
): Promise<void> {
  if (!config || isDisabled()) return;
  if (!responseData || typeof responseData !== "object") return;

  const url = (requestConfig.url as string) || "";
  const method = ((requestConfig.method as string) || "GET").toUpperCase();

  try {
    // 1. Learn baseline schema
    const currentSchema = inferSchema(responseData);
    const endpoint = extractEndpoint(url);

    if (!baselineSchemas.has(endpoint)) {
      // First time seeing this endpoint — learn the baseline
      baselineSchemas.set(endpoint, currentSchema);
      return; // No drift on first observation
    }

    const expectedSchema = baselineSchemas.get(endpoint)!;

    // 2. Detect drift
    const driftResults = detectDrift(expectedSchema, currentSchema);

    if (driftResults.length === 0) return; // No drift, all good

    // 3. Emit drift events
    for (const drift of driftResults) {
      const event: DriftEvent = {
        type: drift.type as DriftEvent["type"],
        path: drift.path,
        expected: drift.expected,
        actual: drift.actual,
        severity: drift.severity,
        timestamp: Date.now(),
      };
      emit("drift", event);
      if (config.onDrift) config.onDrift(event);
    }

    // 4. Check patch cache
    const responseSignature = JSON.stringify(responseData).slice(0, 100);
    const cacheKey = generateCacheKey(config.apiKey, method, extractHost(url), endpoint, responseSignature);
    const cachedPatches = getCachedPatch(cacheKey);

    if (cachedPatches) {
      // Apply cached patches locally
      if (!config.dryRun) {
        Object.assign(responseData as Record<string,unknown>, applyPatches(responseData, cachedPatches) as Record<string,unknown>);
      }
      return;
    }

    // 5. Request analysis from Poly Cloud
    const analysisResult = await requestAnalysis(
      endpoint,
      method,
      expectedSchema,
      currentSchema
    );

    if (!analysisResult || analysisResult.mapping.length === 0) return;

    // 6. Cache the patches
    setCachedPatch(cacheKey, config.apiKey, endpoint, analysisResult.mapping, analysisResult.confidence);

    // 7. Apply patches if confidence is above threshold
    if (analysisResult.confidence >= getConfidenceThreshold() && !config.dryRun) {
      Object.assign(responseData as Record<string,unknown>, applyPatches(responseData, analysisResult.mapping) as Record<string,unknown>);

      for (const patch of analysisResult.mapping) {
        emit("patch", patch);
        if (config.onPatch) config.onPatch(patch);
      }
    }

    // 8. Update baseline if auto-patched successfully
    if (analysisResult.autoPatch) {
      baselineSchemas.set(endpoint, currentSchema);
    }
  } catch (error) {
    emit("error", error instanceof Error ? error : new Error(String(error)));
    if (config.onError) config.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function requestAnalysis(
  endpoint: string,
  method: string,
  expected: SchemaField[],
  actual: SchemaField[]
): Promise<DriftAnalysisResponse | null> {
  if (!config) return null;

  try {
    const response = await fetch(`${getEndpoint()}/api/analyze-drift`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Poly-API-Key": config.apiKey,
      },
      body: JSON.stringify({
        tenantId: config.apiKey, // API key identifies the tenant
        endpoint,
        method,
        expectedSchema: serializeSchema(expected),
        actualSchema: serializeSchema(actual),
        rules: config.rules || [],
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

function extractEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

function extractHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return "unknown";
  }
}
