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
 * Obsidian's HTTP client, backed by Node's global fetch.
 *
 * The plugin's `obsidianFetchBridge` hard-depends on this for every local
 * base URL, and it reads `status` / `headers` / `text` as eagerly-resolved
 * properties — not as methods — so the body is buffered here.
 */
export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  const response = await fetch(param.url, {
    method: param.method ?? 'GET',
    ...(param.headers ? { headers: param.headers } : {}),
    ...(param.body !== undefined ? { body: param.body as BodyInit } : {}),
  });

  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });

  if (param.throw !== false && response.status >= 400) {
    throw new Error(`Request failed, status ${response.status}`);
  }

  return {
    status: response.status,
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
