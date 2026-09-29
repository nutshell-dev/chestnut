/**
 * GENERATED FILE — 请勿手改。由 scripts/generate-provider-inventory.mjs 生成（Phase 1926 Step D）。
 * 来源：@earendil-works/pi-ai@0.87.1
 * 生成时间：2026-09-29T13:26:23.526Z；provider 数：41；api 数：10
 * 再生成：node scripts/generate-provider-inventory.mjs（pi-ai 升级后必须重跑；漂移有测试门禁）
 */

export const PROVIDER_INVENTORY_PI_AI_VERSION = "0.87.1";

/** catalog api id 集（lazy 子路径装载核验过的全量支持表）。 */
export const PROVIDER_INVENTORY_APIS: readonly string[] = [
  "anthropic-messages",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
  "pi-messages"
];

export interface ProviderInventoryEntry {
  /** 该 provider 静态 catalog model 用到的 api 集（动态 provider 可为空）。 */
  readonly apis: readonly string[];
  readonly auth: {
    /** apiKey auth 方法存在（含 ambient-only，如 AWS 链/ADC）。 */
    readonly apiKey: boolean;
    /** apiKey auth 带交互 login（false = ambient-only）。 */
    readonly apiKeyLogin: boolean;
    readonly oauth: boolean;
  };
}

/** provider id → api/auth 快照（与活安装逐项对账，漂移即红）。 */
export const PROVIDER_INVENTORY: Record<string, ProviderInventoryEntry> = {
  "amazon-bedrock": {
    "apis": [
      "bedrock-converse-stream"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "ant-ling": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "anthropic": {
    "apis": [
      "anthropic-messages"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "azure-openai-responses": {
    "apis": [
      "azure-openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "baseten": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "cerebras": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "cloudflare-ai-gateway": {
    "apis": [
      "anthropic-messages",
      "openai-completions",
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "cloudflare-workers-ai": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "deepseek": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "fireworks": {
    "apis": [
      "anthropic-messages",
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "github-copilot": {
    "apis": [
      "anthropic-messages",
      "openai-completions",
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "google": {
    "apis": [
      "google-generative-ai"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "google-vertex": {
    "apis": [
      "google-vertex"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "groq": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "huggingface": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "kimi-coding": {
    "apis": [
      "anthropic-messages"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "meta": {
    "apis": [
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "minimax": {
    "apis": [
      "anthropic-messages"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "minimax-cn": {
    "apis": [
      "anthropic-messages"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "mistral": {
    "apis": [
      "mistral-conversations"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "moonshotai": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "moonshotai-cn": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "nvidia": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "openai": {
    "apis": [
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "openai-codex": {
    "apis": [
      "openai-codex-responses"
    ],
    "auth": {
      "apiKey": false,
      "apiKeyLogin": false,
      "oauth": true
    }
  },
  "opencode": {
    "apis": [
      "anthropic-messages",
      "google-generative-ai",
      "openai-completions",
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "opencode-go": {
    "apis": [
      "anthropic-messages",
      "openai-completions",
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "openrouter": {
    "apis": [
      "anthropic-messages",
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "qwen-token-plan": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "qwen-token-plan-cn": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "qwen-token-plan-individual": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "radius": {
    "apis": [
      "pi-messages"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "together": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "vercel-ai-gateway": {
    "apis": [
      "anthropic-messages"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "xai": {
    "apis": [
      "openai-responses"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": true
    }
  },
  "xiaomi": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "xiaomi-token-plan-ams": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "xiaomi-token-plan-cn": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "xiaomi-token-plan-sgp": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "zai": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  },
  "zai-coding-cn": {
    "apis": [
      "openai-completions"
    ],
    "auth": {
      "apiKey": true,
      "apiKeyLogin": true,
      "oauth": false
    }
  }
};
