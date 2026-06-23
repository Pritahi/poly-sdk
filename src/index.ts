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
} from "./cache";

const DEFAULT_ENDPOINT = "https://api.poly.dev";
const DEFAULT_CONFIDENCE_THRESHOLD = 98;

// Singleton state
let config: PolyConfig | null = null;
let baselineSchemas = new Map<string, SchemaField[]>();
let disabled = false;

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
  getCacheStats(): { size: number; totalHits: number } {
    return getCacheStats();
  },
};

// ─── INTERNAL ──────────────────────────────────────────────

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
