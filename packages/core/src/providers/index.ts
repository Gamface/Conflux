import type { ProviderKind } from "../config.ts";
import type { Provider } from "./types.ts";
import { OpenAIProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";

const providers: Record<ProviderKind, Provider> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  mock: new MockProvider(),
};

export function providerFor(kind: ProviderKind): Provider {
  const p = providers[kind];
  if (!p) throw new Error(`unknown provider ${kind}`);
  return p;
}

export function registerProvider(kind: string, p: Provider): void {
  (providers as Record<string, Provider>)[kind] = p;
}

export * from "./types.ts";
