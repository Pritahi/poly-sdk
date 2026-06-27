// Poly SDK - Schema Learning Engine

import { SchemaField } from "./types";

export function inferSchema(data: unknown, prefix = ""): SchemaField[] {
  if (data === null || data === undefined) return [];

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return [{ name: "[]", type: "array", path: prefix, nullable: false, isArray: true, children: [] }];
    }
    // Merge schemas across all array items to capture full structure + enum sets
    const allChildren: SchemaField[][] = [];
    for (const item of data) {
      allChildren.push(inferSchema(item, `${prefix}[]`));
    }
    const mergedChildren = mergeArraySchemas(allChildren);
    return [{ name: "[]", type: "array", path: prefix, nullable: false, isArray: true, children: mergedChildren }];
  }

  if (typeof data === "object") {
    const fields: SchemaField[] = [];
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value === null) {
        fields.push({ name: key, type: "null", path, nullable: true, isArray: false });
      } else if (Array.isArray(value)) {
        const allChildren: SchemaField[][] = [];
        for (const item of value) {
          allChildren.push(inferSchema(item, `${path}[]`));
        }
        const mergedChildren = allChildren.length > 0 ? mergeArraySchemas(allChildren) : [];
        fields.push({ name: key, type: "array", path, nullable: false, isArray: true, children: mergedChildren });
      } else if (typeof value === "object") {
        const children = inferSchema(value, path);
        fields.push({ name: key, type: "object", path, nullable: false, isArray: false, children });
      } else {
        const field: SchemaField = { name: key, type: typeof value, path, nullable: false, isArray: false };
        // Track enum values for string fields (up to 20 values)
        if (typeof value === "string") {
          field.enumValues = [value];
        }
        fields.push(field);
      }
    }
    return fields;
  }

  return [];
}

/** Merge schemas from multiple array items to capture the union of all fields and enum values */
function mergeArraySchemas(allSchemas: SchemaField[][]): SchemaField[] {
  if (allSchemas.length === 0) return [];

  const merged = new Map<string, SchemaField>();
  for (const schemas of allSchemas) {
    for (const field of schemas) {
      const existing = merged.get(field.path);
      if (!existing) {
        merged.set(field.path, { ...field, children: field.children ? [...field.children] : undefined, enumValues: field.enumValues ? [...field.enumValues] : undefined });
      } else {
        // Merge enum values
        if (field.enumValues) {
          if (!existing.enumValues) existing.enumValues = [];
          for (const v of field.enumValues) {
            if (!existing.enumValues.includes(v)) {
              existing.enumValues.push(v);
            }
          }
        }
        // If type differs, widen to "string" (nullable vs non-nullable union)
        if (existing.type !== field.type) {
          if ((existing.type === "null" && field.type !== "null") || (field.type === "null" && existing.type !== "null")) {
            existing.nullable = true;
            if (existing.type === "null") existing.type = field.type;
          } else if (existing.type === "string" && field.type === "number") {
            existing.type = "string"; // widest
          }
        }
        // Merge children recursively
        if (field.children && existing.children) {
          existing.children = mergeArraySchemas([existing.children, field.children]);
        } else if (field.children) {
          existing.children = field.children;
        }
      }
    }
  }
  return Array.from(merged.values());
}

function fieldToMap(fields: SchemaField[], map: Map<string, SchemaField> = new Map()): Map<string, SchemaField> {
  for (const field of fields) {
    map.set(field.path, field);
    if (field.children) fieldToMap(field.children, map);
  }
  return map;
}

export interface DriftResult {
  type: "missing_field" | "new_field" | "type_change" | "rename" | "nullability" | "array_change" | "nested_change" | "enum_change";
  path: string;
  expected: SchemaField | null;
  actual: SchemaField | null;
  severity: "critical" | "high" | "medium" | "low";
}

export function detectDrift(expected: SchemaField[], actual: SchemaField[]): DriftResult[] {
  const events: DriftResult[] = [];
  const expectedMap = fieldToMap(expected);
  const actualMap = fieldToMap(actual);

  const criticalPatterns = ["amount", "price", "payment", "auth", "token", "order", "currency"];

  // Missing fields
  for (const [path, field] of expectedMap) {
    if (!actualMap.has(path)) {
      // Check if this field was renamed — only consider fields in the same parent scope
      let renamed = false;
      const parentPath = path.includes('.') ? path.substring(0, path.lastIndexOf('.')) : '';
      for (const [actualPath, actualField] of actualMap) {
        if (!expectedMap.has(actualPath) && actualField.type === field.type) {
          // Only match rename if fields share the same parent (or both are top-level)
          const actualParent = actualPath.includes('.') ? actualPath.substring(0, actualPath.lastIndexOf('.')) : '';
          if (parentPath === actualParent) {
            events.push({ type: "rename", path, expected: field, actual: actualField, severity: "medium" });
            renamed = true;
            break;
          }
        }
      }
      if (!renamed) {
        const isCritical = criticalPatterns.some((p) => path.toLowerCase().includes(p));
        events.push({
          type: "missing_field",
          path,
          expected: field,
          actual: null,
          severity: isCritical ? "critical" : "high",
        });
      }
    }
  }

  // New fields, type changes, enum changes, nested changes
  for (const [path, field] of actualMap) {
    if (!expectedMap.has(path)) {
      const isRenameTarget = events.some((e) => e.type === "rename" && e.actual?.path === path);
      if (!isRenameTarget) {
        events.push({ type: "new_field", path, expected: null, actual: field, severity: "low" });
      }
    } else {
      const expectedField = expectedMap.get(path)!;

      // Type change
      if (expectedField.type !== field.type) {
        const isCritical = criticalPatterns.some((p) => path.toLowerCase().includes(p));
        events.push({ type: "type_change", path, expected: expectedField, actual: field, severity: isCritical ? "critical" : "high" });
      }

      // Nullability change
      if (expectedField.nullable !== field.nullable) {
        events.push({ type: "nullability", path, expected: expectedField, actual: field, severity: "medium" });
      }

      // Enum change — only when baseline has ≥2 values (real enum), and values differ
      if (
        expectedField.enumValues && expectedField.enumValues.length >= 2 &&
        field.enumValues && field.enumValues.length > 0
      ) {
        const oldSet = new Set(expectedField.enumValues);
        const newSet = new Set(field.enumValues);
        const added = field.enumValues.filter(v => !oldSet.has(v));
        const removed = expectedField.enumValues.filter(v => !newSet.has(v));
        if (added.length > 0 || removed.length > 0) {
          const isCritical = criticalPatterns.some((p) => path.toLowerCase().includes(p));
          events.push({
            type: "enum_change",
            path,
            expected: { ...expectedField, enumValues: expectedField.enumValues },
            actual: { ...field, enumValues: field.enumValues },
            severity: isCritical ? "critical" : "medium",
          });
        }
      }

      // Nested change — parent object's children structure changed
      if (expectedField.type === "object" && field.type === "object") {
        const expectedKids = expectedField.children || [];
        const actualKids = field.children || [];
        const expectedNames = new Set(expectedKids.map(c => c.name));
        const actualNames = new Set(actualKids.map(c => c.name));
        const hasStructuralChange =
          expectedKids.length !== actualKids.length ||
          ![...expectedNames].every(n => actualNames.has(n));
        if (hasStructuralChange) {
          events.push({
            type: "nested_change",
            path,
            expected: expectedField,
            actual: field,
            severity: "medium",
          });
        }
      }
    }
  }

  return events;
}

export function serializeSchema(fields: SchemaField[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.children && field.children.length > 0) {
      result[field.name] = field.isArray ? [serializeSchema(field.children)] : serializeSchema(field.children);
    } else {
      result[field.name] = field.type + (field.nullable ? "|null" : "");
    }
  }
  return result;
}
