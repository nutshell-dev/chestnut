/**
 * ToolRegistry - canonical provider descriptors plus mutable execution bindings.
 */

import { sha256Hex } from '../node-utils/index.js';
import type { llmProviderProtocol } from '../llm-provider/index.js';
import type {
  CanonicalToolManifest,
  Tool,
  ToolRegistry,
  ToolRegistryRuntimeCapability,
} from './types.js';
import type { ToolDescriptor, ToolProfile } from '../tool-protocol/index.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function descriptorOf(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    schema: clone(tool.schema),
  };
}

function descriptorKey(descriptor: ToolDescriptor): string {
  return JSON.stringify(descriptor);
}

/** Build a manifest from an existing provider-facing canonical array. */
export function createCanonicalToolManifestFromDefinitions(
  input: readonly llmProviderProtocol.ToolDefinition[],
): CanonicalToolManifest {
  const definitions = input.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: clone(tool.input_schema),
  }));
  const llmTools = definitions.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    input_schema: clone(descriptor.schema),
  }));
  const revision = sha256Hex(JSON.stringify(definitions));
  return deepFreeze({ revision, definitions, llmTools });
}

/** Build a manifest only from static descriptors, in the supplied canonical order. */
export function createCanonicalToolManifest(tools: readonly Tool[]): CanonicalToolManifest {
  return createCanonicalToolManifestFromDefinitions(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
  })));
}

export class ToolRegistryImpl implements ToolRegistry, ToolRegistryRuntimeCapability {
  private readonly tools = new Map<string, Tool>();
  private readonly descriptors = new Map<string, string>();
  private manifest?: CanonicalToolManifest;

  /** Equivalent descriptors may replace a handler; conflicting descriptors cannot. */
  register(tool: Tool): void {
    if (this.manifest) {
      throw new Error(`Tool registry is frozen; cannot register '${tool.name}'.`);
    }
    const key = descriptorKey(descriptorOf(tool));
    const previous = this.descriptors.get(tool.name);
    if (previous !== undefined && previous !== key) {
      throw new Error(`Tool descriptor conflict for '${tool.name}'.`);
    }
    this.tools.set(tool.name, tool);
    this.descriptors.set(tool.name, key);
  }

  replace(tool: Tool): void {
    if (this.manifest) {
      throw new Error(`Tool registry is frozen; cannot replace '${tool.name}'.`);
    }
    if (!this.tools.has(tool.name)) {
      throw new Error(`Cannot replace unknown tool '${tool.name}'.`);
    }
    this.tools.set(tool.name, tool);
    this.descriptors.set(tool.name, descriptorKey(descriptorOf(tool)));
  }

  unregister(name: string): void {
    if (this.manifest) {
      throw new Error(`Tool registry is frozen; cannot unregister '${name}'.`);
    }
    this.tools.delete(name);
    this.descriptors.delete(name);
  }

  /** Idempotent; Map insertion order is the explicit assembly canonical order. */
  freeze(): CanonicalToolManifest {
    this.manifest ??= createCanonicalToolManifest(this.getAll());
    return this.manifest;
  }

  getManifest(): CanonicalToolManifest {
    if (!this.manifest) {
      throw new Error('Tool registry manifest requested before freeze().');
    }
    return this.manifest;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getForProfile(profile: ToolProfile): Tool[] {
    return this.getAll().filter((tool) => tool.profiles?.includes(profile) ?? false);
  }

  formatForLLM(tools: readonly Tool[] | CanonicalToolManifest) {
    if (!Array.isArray(tools)) {
      const manifest = tools as CanonicalToolManifest;
      return clone([...manifest.llmTools]);
    }
    return (tools as readonly Tool[]).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: clone(tool.schema),
    }));
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}
