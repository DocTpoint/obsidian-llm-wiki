// Stand-in for the `obsidian` module when the plugin runs under plain Node.
// The bundler aliases every `from 'obsidian'` import — plugin code and this
// CLI alike — to this file, so `instanceof TFile` keeps working across the
// boundary.
//
// Only the surface the ingest path actually touches is implemented. Anything
// that needs a real Obsidian window throws on construction rather than
// pretending to work.

/**
 * Obsidian's path normalizer: backslashes become slashes, runs of slashes
 * collapse, leading/trailing slashes are dropped, and the result is NFC so
 * it compares equal to filenames read back from disk.
 */
export function normalizePath(path: string): string {
  const collapsed = path
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .normalize('NFC');
  return collapsed === '' ? '/' : collapsed;
}

/**
 * The plugin only ever uses `App` as a type. Keeping the members opaque here
 * avoids a cycle with the vault module, which is the thing that supplies them.
 */
export interface App {
  vault: unknown;
  metadataCache: unknown;
  fileManager: unknown;
}

export class TAbstractFile {
  path = '';
  name = '';
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
  stat: { ctime: number; mtime: number; size: number } = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === '' || this.path === '/';
  }
}

/** Obsidian's toast. In the CLI it is a line on stdout. */
export class Notice {
  private message: string;
  constructor(message: string, _timeout?: number) {
    this.message = message;
    console.log(`[Notice] ${message}`);
  }
  setMessage(message: string): void {
    this.message = message;
    console.log(`[Notice] ${message}`);
  }
  hide(): void { /* nothing to dismiss on a terminal */ }
  getMessage(): string {
    return this.message;
  }
}

export const Platform = {
  isMacOS: process.platform === 'darwin',
  isWin: process.platform === 'win32',
  isLinux: process.platform === 'linux',
  isMobile: false,
  isDesktop: true,
  isDesktopApp: true,
  isMobileApp: false,
};

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

/**
 * Obsidian's HTTP client, backed by `node:http` / `node:https`.
 *
 * The plugin's `obsidianFetchBridge` hard-depends on this for every local
 * base URL, and it reads `status` / `headers` / `text` as eagerly-resolved
 * properties — not as methods — so the body is buffered here.
 *
 * Not Node's global `fetch`: that applies undici's default `headersTimeout`
 * of 300 s. A non-streamed completion sends no response headers until the
 * whole answer is ready, so any single LLM call that needs more than five
 * minutes fails with a bare `fetch failed` — measured twice at 301 s with a
 * 12B model on LM Studio and an 82 000-character extraction prompt. Obsidian's
 * real `requestUrl` goes through Electron's `net` and has no such ceiling, so
 * the shim would be stricter than the host it stands in for, on exactly the
 * configuration this CLI exists to serve. `node:http` has no default timeout,
 * which restores the host's behaviour without adding a dependency (undici's
 * own API is not reachable from a plain Node install).
 */
export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  const url = new URL(param.url);
  const { request } = await import(url.protocol === 'https:' ? 'node:https' : 'node:http');

  const { status, headers, buffer } = await new Promise<{
    status: number;
    headers: Record<string, string>;
    buffer: Buffer;
  }>((resolve, reject) => {
    const req = request(
      url,
      { method: param.method ?? 'GET', headers: param.headers ?? {} },
      (res: import('node:http').IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) flat[k] = Array.isArray(v) ? v.join(', ') : v;
          }
          resolve({ status: res.statusCode ?? 0, headers: flat, buffer: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (param.body !== undefined) req.write(param.body);
    req.end();
  });

  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const text = new TextDecoder().decode(arrayBuffer);

  if (param.throw !== false && status >= 400) {
    throw new Error(`Request failed, status ${status}`);
  }

  return {
    status,
    headers,
    arrayBuffer,
    text,
    get json(): unknown {
      return text === '' ? null : JSON.parse(text);
    },
  };
}

/** Every UI class the plugin's import graph may pull in but the CLI never renders. */
function uiUnavailable(className: string): never {
  throw new Error(
    `${className} belongs to the Obsidian UI and has no Node equivalent. ` +
    'The ingest CLI must not reach this code path.'
  );
}

export class Component {
  load(): void { /* no lifecycle in the CLI */ }
  unload(): void { /* no lifecycle in the CLI */ }
}

export class BaseComponent {
  disabled = false;
}

export class Modal {
  constructor(_app: unknown) { uiUnavailable('Modal'); }
}

export class ItemView {
  constructor(_leaf: unknown) { uiUnavailable('ItemView'); }
}

export class WorkspaceLeaf {
  constructor() { uiUnavailable('WorkspaceLeaf'); }
}

export class FuzzySuggestModal {
  constructor(_app: unknown) { uiUnavailable('FuzzySuggestModal'); }
}

export class PluginSettingTab {
  constructor(_app: unknown, _plugin: unknown) { uiUnavailable('PluginSettingTab'); }
}

export class Setting {
  constructor(_containerEl: unknown) { uiUnavailable('Setting'); }
}

export class Plugin {
  constructor(_app: unknown, _manifest: unknown) { uiUnavailable('Plugin'); }
}

export const MarkdownRenderer = {
  render: async (): Promise<void> => uiUnavailable('MarkdownRenderer'),
  renderMarkdown: async (): Promise<void> => uiUnavailable('MarkdownRenderer'),
};
