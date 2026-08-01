// `parseArgs` landed in Node 18 and is what this CLI parses its flags with.
//
// The repo pins `@types/node` to 16.18.126, matching the runtime the plugin
// itself targets, so the declaration is simply absent — the CLI compiled only
// because nothing type-checked this directory. Bumping the pin would move types
// under the plugin as well, for a tool the plugin never loads, so the shape is
// declared here instead and this file can go once the repo's own pin passes 18.
declare module 'node:util' {
  export function parseArgs<T extends {
    args?: string[];
    options?: Record<string, { type: 'string' | 'boolean'; default?: string | boolean; short?: string }>;
    allowPositionals?: boolean;
  }>(config: T): {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}
