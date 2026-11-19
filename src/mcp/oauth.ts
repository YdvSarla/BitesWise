import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthConfig {
  /** Absolute path of the JSON file tokens are persisted in. */
  tokensFile: string;
  clientName: string;
  callbackPort: number;
}

interface TokenStore {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  tokensSavedAt?: string;
  codeVerifier?: string;
  state?: string;
}

function loadStore(file: string): TokenStore {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TokenStore;
  } catch {
    return {};
  }
}

function saveStore(file: string, store: TokenStore): void {
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

/** Thrown when a non-interactive command (web server, search) needs a fresh browser login. */
export class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRequiredError";
  }
}

export function hasStoredTokens(tokensFile: string): boolean {
  return existsSync(tokensFile) && loadStore(tokensFile).tokens !== undefined;
}

/**
 * File-backed OAuthClientProvider, platform-agnostic. The MCP SDK drives the
 * whole OAuth 2.1 flow against the server's RFC 8414 metadata: Dynamic
 * Client Registration, PKCE (S256), token exchange and refresh-token
 * rotation all happen inside the SDK; this class only persists state and
 * opens the browser.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly config: OAuthConfig,
    private readonly interactive: boolean,
  ) {}

  get redirectUrl(): string {
    return `http://localhost:${this.config.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:tools",
    };
  }

  state(): string {
    const state = randomBytes(16).toString("base64url");
    const store = loadStore(this.config.tokensFile);
    store.state = state;
    saveStore(this.config.tokensFile, store);
    return state;
  }

  expectedState(): string | undefined {
    return loadStore(this.config.tokensFile).state;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return loadStore(this.config.tokensFile).clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    const store = loadStore(this.config.tokensFile);
    store.clientInformation = info;
    saveStore(this.config.tokensFile, store);
  }

  tokens(): OAuthTokens | undefined {
    return loadStore(this.config.tokensFile).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const store = loadStore(this.config.tokensFile);
    store.tokens = tokens;
    store.tokensSavedAt = new Date().toISOString();
    saveStore(this.config.tokensFile, store);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.interactive) {
      throw new LoginRequiredError(
        `${this.config.clientName}: login required but this command is non-interactive. Run the login script first.`,
      );
    }
    openBrowser(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    const store = loadStore(this.config.tokensFile);
    store.codeVerifier = codeVerifier;
    saveStore(this.config.tokensFile, store);
  }

  codeVerifier(): string {
    const verifier = loadStore(this.config.tokensFile).codeVerifier;
    if (!verifier) throw new Error("No PKCE code verifier saved; restart the login flow.");
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    const store = loadStore(this.config.tokensFile);
    if (scope === "all") {
      saveStore(this.config.tokensFile, {});
      return;
    }
    if (scope === "client") delete store.clientInformation;
    if (scope === "tokens") delete store.tokens;
    if (scope === "verifier") delete store.codeVerifier;
    saveStore(this.config.tokensFile, store);
  }
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.error(`Could not open a browser automatically. Open this URL yourself:\n${url}`);
  });
  child.unref();
}

/**
 * One-shot localhost listener for the OAuth redirect. Resolves with the
 * authorization code once the platform redirects back to /callback.
 */
export function waitForCallback(opts: {
  port: number;
  expectedState?: string;
  timeoutMs?: number;
}): { server: Server; code: Promise<string> } {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const err = url.searchParams.get("error");
    const authCode = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (err) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<h2>Login failed: ${err}</h2><p>You can close this tab.</p>`);
      settle.reject(
        new Error(`Authorization failed: ${err} ${url.searchParams.get("error_description") ?? ""}`),
      );
      return;
    }
    if (!authCode) {
      res.writeHead(400).end("Missing ?code");
      return;
    }
    if (opts.expectedState && state !== opts.expectedState) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end("<h2>State mismatch — possible CSRF. Restart the login.</h2>");
      settle.reject(new Error("OAuth state mismatch"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>✅ Logged in.</h2><p>You can close this tab and return to the terminal.</p>");
    settle.resolve(authCode);
  });

  server.listen(opts.port);
  server.on("error", (e) => settle.reject(e as Error));

  const timer = setTimeout(() => {
    settle.reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for the browser login.`));
  }, timeoutMs);
  void code.finally(() => clearTimeout(timer));

  return { server, code };
}
