import { validPageState, withoutReservedKeys, type PageState } from "./pageState";

export interface CallableInterface {
  service: string;
  methods: string[];
}

export interface HostInit {
  version: string;
  pluginId: string;
  pluginVersion: string;
  pluginRoute: string;
  locale: string;
  colorScheme: string;
  designTokens: Record<string, string>;
  interfaces: CallableInterface[];
  /**
   * The query of the console's plugin route, when the host carries page
   * state in its address. Absent from a host that predates that, which is
   * how the page knows to keep the state in its own document instead.
   */
  pageState?: PageState;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PluginMessage =
  | { type: "lattice.plugin.ready"; nonce: string }
  | { type: "lattice.plugin.call"; nonce: string; id: string; service: string; method: string; payload: unknown }
  | { type: "lattice.plugin.cancel"; nonce: string; id: string }
  | { type: "lattice.plugin.state"; nonce: string; state: PageState }
  | { type: "lattice.plugin.clipboard"; nonce: string; id: string; text: string };

/**
 * A call the console refused or failed, with what it said about why.
 *
 * `code` is the host's own class (call_failed, timeout, step_up_required when
 * the operator cancelled the console's step-up, and so on). `apiCode` and
 * `httpStatus` are the server's answer to the call, which a console from
 * wave 3 forwards beside the message (bridge v1, additive); an older console
 * sends neither, so callers read them as hints and fall back to the message.
 */
export class BridgeCallError extends Error {
  readonly code: string;
  readonly apiCode?: string;
  readonly httpStatus?: number;

  constructor(message: string, code = "", apiCode?: string, httpStatus?: number) {
    super(message);
    this.name = "BridgeCallError";
    this.code = code;
    if (apiCode) this.apiCode = apiCode;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

const TOKEN_NAMES = new Set([
  "--background", "--foreground", "--card", "--card-foreground", "--muted",
  "--muted-foreground", "--border", "--primary", "--primary-foreground",
  "--destructive", "--ring",
]);
const EXPECTED_PLUGIN_ID = "latticenet.vpn-core";
const EXPECTED_ROUTES = new Set(["lines", "users", "profiles", "usage"]);
const READY_RETRY_MS = 500;
const READY_ATTEMPT_LIMIT = 16;

export class BridgeClient {
  readonly nonce: string;
  readonly init: Promise<HostInit>;

  private readonly win: Window;
  // hostOrigin pins both inbound and outbound messages; absence fails closed.
  private readonly hostOrigin: string;
  private readonly pending = new Map<string, Pending>();
  private readonly copies = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private initResolve!: (value: HostInit) => void;
  private initReject!: (reason: Error) => void;
  private sequence = 0;
  private disposed = false;
  private readyAttempts = 0;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(win: Window) {
    this.win = win;
    const channel = readChannel(win.location.hash);
    this.nonce = channel.nonce;
    this.hostOrigin = channel.hostOrigin;
    this.init = new Promise<HostInit>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.init.catch(() => {});
    this.onMessage = this.onMessage.bind(this);
    this.win.addEventListener("message", this.onMessage);
    this.postReady();
  }

  call<T>(service: string, method: string, payload: unknown, timeoutMs = 15_000): { promise: Promise<T>; cancel: () => void } {
    if (this.disposed) throw new Error("This page is no longer connected to the console, so the bridge is disposed and nothing was sent.");
    const id = `vpn-core-${++this.sequence}`;
    let cancel = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.post({ type: "lattice.plugin.cancel", nonce: this.nonce, id });
        reject(new Error("The console did not answer this request and it timed out. It may still be running there, so re-check the state before retrying."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        this.post({ type: "lattice.plugin.cancel", nonce: this.nonce, id });
        pending.reject(new Error("The request was cancelled before the console answered, so its outcome is unknown."));
      };
      this.post({ type: "lattice.plugin.call", nonce: this.nonce, id, service, method, payload });
    });
    promise.catch(() => {});
    return { promise, cancel };
  }

  /**
   * Hand the page's full state to the console for its address. There is no
   * answer: a host that keeps page state replaces its query with this, and
   * one that does not ignores the message.
   */
  sendState(state: PageState): void {
    if (this.disposed) return;
    const valid = validPageState(state);
    if (valid) this.post({ type: "lattice.plugin.state", nonce: this.nonce, state: valid });
  }

  /**
   * Ask the console to put `text` on the operator's clipboard. The frame is
   * sandboxed without the Clipboard API, so the host copies on the
   * operator's click and answers whether it landed. Resolves false when it
   * did not, when the console never answers (an older one has no clipboard
   * handler) or after dispose, so the caller can show the text to copy by hand.
   */
  copy(text: string, timeoutMs = 3_000): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const id = `vpn-core-copy-${++this.sequence}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.copies.delete(id);
        resolve(false);
      }, timeoutMs);
      this.copies.set(id, { resolve, timer });
      this.post({ type: "lattice.plugin.clipboard", nonce: this.nonce, id, text });
    });
  }

  dispose(): void {
    this.failBridge(new Error("The console disconnected this plugin. Any request still in flight has an unknown outcome: reload and check before retrying."));
  }

  private onMessage(event: MessageEvent): void {
    if (this.disposed || event.source !== this.win.parent || !isRecord(event.data) || event.data.nonce !== this.nonce) return;
    if (event.origin !== this.hostOrigin) return;
    const message = event.data;
    switch (message.type) {
      case "lattice.host.init": {
        const init = parseInit(message);
        if (!init) return;
        this.clearReadyTimer();
        applyTheme(init.colorScheme, init.designTokens);
        this.initResolve(init);
        return;
      }
      case "lattice.host.theme":
        if (typeof message.colorScheme === "string" && isStringRecord(message.designTokens)) {
          applyTheme(message.colorScheme, message.designTokens);
        }
        return;
      case "lattice.host.result":
        this.finish(message.id, undefined, message.result);
        return;
      case "lattice.host.clipboard": {
        const copy = typeof message.id === "string" ? this.copies.get(message.id) : undefined;
        if (!copy) return;
        clearTimeout(copy.timer);
        this.copies.delete(message.id as string);
        copy.resolve(message.ok === true);
        return;
      }
      case "lattice.host.error":
        if (typeof message.id === "string") {
          this.finish(message.id, new BridgeCallError(
            typeof message.message === "string" ? message.message : "The console refused this request and gave no reason.",
            typeof message.code === "string" ? message.code : "",
            typeof message.apiCode === "string" ? message.apiCode : undefined,
            typeof message.httpStatus === "number" ? message.httpStatus : undefined,
          ));
        } else {
          this.failBridge(new Error(typeof message.message === "string" ? message.message : "The console refused to start this plugin. Your session may lack the scopes it declares."));
        }
        return;
      case "lattice.host.dispose":
        this.dispose();
    }
  }

  private finish(value: unknown, error?: Error, result?: unknown): void {
    if (typeof value !== "string") return;
    const pending = this.pending.get(value);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private post(message: PluginMessage): void {
    this.win.parent.postMessage(message, this.hostOrigin);
  }

  private postReady(): void {
    if (this.disposed || this.readyAttempts >= READY_ATTEMPT_LIMIT) return;
    this.readyAttempts += 1;
    this.post({ type: "lattice.plugin.ready", nonce: this.nonce });
    if (this.readyAttempts < READY_ATTEMPT_LIMIT) {
      this.readyTimer = setTimeout(() => this.postReady(), READY_RETRY_MS);
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private failBridge(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReadyTimer();
    this.win.removeEventListener("message", this.onMessage);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const copy of this.copies.values()) {
      clearTimeout(copy.timer);
      copy.resolve(false);
    }
    this.copies.clear();
    this.initReject(error);
  }
}

export function canCall(init: HostInit | undefined, service: string, method: string): boolean {
  return init?.interfaces.some((contract) => contract.service === service && contract.methods.includes(method)) === true;
}

function readChannel(hash: string): { nonce: string; hostOrigin: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const nonce = params.get("lattice_nonce");
  if (!nonce || nonce.length < 16 || nonce.length > 128) throw new Error("Missing plugin channel nonce in this page's URL. The Lattice console builds that URL, so open the plugin from the console rather than directly.");
  const hostOrigin = params.get("host_origin")?.trim();
  if (!hostOrigin) throw new Error("Missing plugin host origin in this page's URL. The Lattice console builds that URL, so open the plugin from the console rather than directly.");
  // Must be an exact absolute http(s) origin. Anything else is a host bug
  // or a tampered frame URL, and neither is a reason to silently downgrade.
  let parsed: URL;
  try {
    parsed = new URL(hostOrigin);
  } catch {
    throw new Error("Invalid plugin host origin in this page's URL. The Lattice console builds that URL, so open the plugin from the console rather than directly.");
  }
  if (parsed.origin !== hostOrigin || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error("Invalid plugin host origin in this page's URL. The Lattice console builds that URL, so open the plugin from the console rather than directly.");
  }
  return { nonce, hostOrigin };
}

function parseInit(message: Record<string, unknown>): HostInit | undefined {
  if (typeof message.version !== "string" || typeof message.pluginId !== "string" ||
      typeof message.pluginVersion !== "string" || typeof message.pluginRoute !== "string" ||
      typeof message.locale !== "string" || typeof message.colorScheme !== "string" ||
      !isStringRecord(message.designTokens) || !Array.isArray(message.interfaces) ||
      message.version !== "1" || message.pluginId !== EXPECTED_PLUGIN_ID ||
      !EXPECTED_ROUTES.has(message.pluginRoute)) return undefined;
  const interfaces: CallableInterface[] = [];
  for (const value of message.interfaces) {
    if (!isRecord(value) || typeof value.service !== "string" || !Array.isArray(value.methods) ||
        !value.methods.every((method) => typeof method === "string")) return undefined;
    interfaces.push({ service: value.service, methods: value.methods as string[] });
  }
  // The host filters its query before sending it, so a state that still
  // breaks the rules is a host fault; it is set aside rather than failing
  // the start, and the page falls back to its own document query.
  // A reserved console key should never arrive; if one does, it is dropped
  // on its own rather than costing the rest of the state.
  const pageState = message.pageState === undefined
    ? undefined
    : validPageState(isRecord(message.pageState) ? withoutReservedKeys(message.pageState) : message.pageState);
  return {
    version: message.version,
    pluginId: message.pluginId,
    pluginVersion: message.pluginVersion,
    pluginRoute: message.pluginRoute,
    locale: message.locale,
    colorScheme: message.colorScheme,
    designTokens: message.designTokens,
    interfaces,
    ...(pageState ? { pageState } : {}),
  };
}

function applyTheme(colorScheme: string, tokens: Record<string, string>): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.colorScheme = colorScheme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = colorScheme === "dark" ? "dark" : "light";
  for (const [name, value] of Object.entries(tokens)) {
    if (TOKEN_NAMES.has(name)) document.documentElement.style.setProperty(name, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
