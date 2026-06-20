# poly-sdk

**Survive third-party API changes.** Detect schema drift, generate safe mappings, and apply transformations locally.

> ⚡ Traffic **never** passes through Poly servers.

## Install

```bash
npm install poly-sdk
```

## Quick Start

```typescript
import { Poly } from "poly-sdk"
import axios from "axios"

// 1. Initialize with your API key
Poly.init({
  apiKey: "poly_live_xxx"
})

// 2. Wrap your HTTP client
Poly.wrap(axios)

// That's it! All responses are now monitored.
// Schema drift is detected and patched automatically.
```

## How It Works

```
Your App → Poly SDK → Third-party API

When drift occurs:
  Poly SDK → Poly Cloud (metadata only, never your data)
  Poly Cloud → Rule Engine → AI Mapping → Patch
  Poly SDK ← Patch
  Poly SDK → Local response transformation (in-memory)
```

**Your traffic never flows through Poly.** The SDK intercepts responses locally, sends only schema metadata to the cloud, and applies patches in memory.

## Configuration

```typescript
Poly.init({
  apiKey: "poly_live_xxx",

  // Custom endpoint (for self-hosted)
  endpoint: "https://api.poly.dev",

  // Confidence threshold for auto-patching (default: 98)
  confidenceThreshold: 98,

  // Dry run mode (detect but don't patch)
  dryRun: false,

  // Disable Poly entirely
  disable: false,

  // Custom rules
  rules: [
    { type: "protected", field: "payment_status", action: "block" },
    { type: "safe", field: "display_name", action: "allow" },
  ],

  // Event listeners
  onDrift: (event) => console.log("Drift:", event.type, event.path),
  onPatch: (patch) => console.log("Patch:", patch.from, "→", patch.to),
  onError: (error) => console.error("Poly error:", error),
})
```

## Features

### Baseline Learning (Zero Config)

The SDK automatically learns schemas from your API responses. No configuration needed.

### Drift Detection

Detects 7 types of schema drift:

| Type | Description |
|------|-------------|
| `missing_field` | Field removed from response |
| `new_field` | New field in response |
| `type_change` | Field type changed |
| `rename` | Field renamed |
| `nullability` | Nullability changed |
| `enum_change` | Enum values changed |
| `array_change` | Array structure changed |

### Rule Engine

Rules run **before AI**. Protected fields are never modified:

```typescript
// Protected fields — AI CANNOT modify
amount, price, currency, payment_status, auth_token, order_id

// Safe fields — AI CAN modify
name, description, avatar, address, email
```

### Confidence Layer

- **confidence > 98%** → auto-patch applied
- **confidence ≤ 98%** → alert only, no patch

### Patch Cache

Patches are cached locally and reused. No repeated AI calls for the same drift pattern.

```typescript
Poly.invalidateCache("/api/v1/users")  // Invalidate specific endpoint
Poly.clearCache()                       // Clear all caches
```

### Rollback & Kill Switch

```typescript
// Dry run mode
Poly.init({ dryRun: true })

// Rollback a patch
await Poly.rollback("patch_id")

// Kill switch — disable Poly entirely
Poly.disable()

// Or via environment variable:
// POLY_DISABLE=1

// Re-enable
Poly.enable()
```

### Event Listeners

```typescript
Poly.on("drift", (event) => {
  console.log("Drift detected:", event.type, event.path)
})

Poly.on("patch", (patch) => {
  console.log("Patch applied:", patch.type, patch.from, "→", patch.to)
})
```

## V1 Support

| Client | Status |
|--------|--------|
| Axios | ✅ Supported |
| fetch | 🔄 Coming Soon |
| OpenAI SDK | 🔄 Coming Soon |
| Stripe SDK | 🔄 Coming Soon |

## License

MIT
