// Poly SDK - Core Types

export interface PolyConfig {
  apiKey: string;
  endpoint?: string;
  confidenceThreshold?: number;
  dryRun?: boolean;
  disable?: boolean;
  rules?: RuleDefinition[];
  openApiSpec?: Record<string, unknown>;
  zodSchemas?: Record<string, unknown>;
  onDrift?: (event: DriftEvent) => void;
  onPatch?: (patch: PatchOperation) => void;
  onError?: (error: Error) => void;
}

export interface RuleDefinition {
  type: "protected" | "safe" | "custom";
  field: string;
  action: "block" | "allow" | "warn";
}

export interface SchemaField {
  name: string;
  type: string;
  path: string;
  nullable: boolean;
  isArray: boolean;
  children?: SchemaField[];
}

export type DriftType =
  | "missing_field"
  | "new_field"
  | "type_change"
  | "rename"
  | "nullability"
  | "enum_change"
  | "array_change";

export interface DriftEvent {
  type: DriftType;
  path: string;
  expected: SchemaField | null;
  actual: SchemaField | null;
  severity: "critical" | "high" | "medium" | "low";
  timestamp: number;
}

export type PatchType = "rename" | "remove" | "add_default" | "type_conversion";

export interface PatchOperation {
  type: PatchType;
  from: string;
  to: string;
  value?: unknown;
  confidence: number;
  reason: string;
}

export interface DriftAnalysisResponse {
  mapping: PatchOperation[];
  blocked: PatchOperation[];
  confidence: number;
  reason: string;
  autoPatch: boolean;
  cached: boolean;
  driftEvents: Array<{
    type: string;
    path: string;
    expectedType: string;
    actualType: string;
    severity: string;
  }>;
}

export interface PatchCacheEntry {
  key: string;
  patches: PatchOperation[];
  confidence: number;
  createdAt: number;
  hitCount: number;
}

export interface AxiosResponse {
  data: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: Record<string, unknown>;
}

export interface AxiosInstance {
  request<T = unknown>(config: Record<string, unknown>): Promise<{ data: T; status: number; statusText: string; headers: Record<string, string>; config: Record<string, unknown> }>;
  get<T = unknown>(url: string, config?: Record<string, unknown>): Promise<{ data: T; status: number; statusText: string; headers: Record<string, string>; config: Record<string, unknown> }>;
  post<T = unknown>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<{ data: T; status: number; statusText: string; headers: Record<string, string>; config: Record<string, unknown> }>;
  put<T = unknown>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<{ data: T; status: number; statusText: string; headers: Record<string, string>; config: Record<string, unknown> }>;
  patch<T = unknown>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<{ data: T; status: number; statusText: string; headers: Record<string, string>; config: Record<string, unknown> }>;
  delete<T = unknown>(url: string, config?: Record<string, unknown>): Promise<{ data: T; status: number; statusText: string; headers: Record<string, string>; config: Record<string, unknown> }>;
  interceptors: {
    request: { use: (fulfilled?: (config: Record<string, unknown>) => Record<string, unknown>, rejected?: (error: unknown) => unknown) => number; eject: (id: number) => void };
    response: { use: (fulfilled?: (response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>, rejected?: (error: unknown) => unknown) => number; eject: (id: number) => void };
  };
  defaults: Record<string, unknown>;
}
