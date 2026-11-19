import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, LoginRequiredError, waitForCallback, type OAuthConfig } from "./oauth.js";

export interface ConnectOptions extends OAuthConfig {
  serverUrl: string;
  interactive: boolean;
  /** Human-readable platform name for error messages, e.g. "Swiggy". */
  platformName: string;
  loginHint: string; // e.g. "npm run login"
}

function makeClient(): Client {
  return new Client({ name: "bitewise", version: "0.1.0" });
}

/**
 * Connect to an MCP server with file-persisted OAuth.
 *
 * interactive=false: uses stored tokens (the SDK refreshes them itself when
 * expired) and fails with a clear message if a fresh browser login is needed.
 *
 * interactive=true: on 401, opens the browser for OAuth (PKCE + DCR), waits
 * for the localhost redirect, exchanges the code, then reconnects.
 */
export async function connectMcp(opts: ConnectOptions): Promise<Client> {
  const provider = new FileOAuthProvider(opts, opts.interactive);

  const client = makeClient();
  const transport = new StreamableHTTPClientTransport(new URL(opts.serverUrl), {
    authProvider: provider,
  });

  try {
    await client.connect(transport);
    return client;
  } catch (err) {
    if (!(err instanceof UnauthorizedError || err instanceof LoginRequiredError)) throw err;
    if (!opts.interactive) {
      throw new Error(
        `Not logged in to ${opts.platformName} (or the session expired). Run \`${opts.loginHint}\` first.`,
      );
    }
  }

  // Interactive login: the SDK already sent the browser to the authorize
  // endpoint via provider.redirectToAuthorization. Wait for the redirect back.
  const { server, code } = waitForCallback({
    port: opts.callbackPort,
    expectedState: provider.expectedState(),
  });
  console.log(`\nWaiting for you to finish logging in in the browser...`);
  console.log(`(listening on http://localhost:${opts.callbackPort}/callback)\n`);

  try {
    const authCode = await code;
    await transport.finishAuth(authCode);
  } finally {
    server.close();
  }

  // Reconnect with the freshly saved tokens.
  const client2 = makeClient();
  const transport2 = new StreamableHTTPClientTransport(new URL(opts.serverUrl), {
    authProvider: new FileOAuthProvider(opts, false),
  });
  await client2.connect(transport2);
  return client2;
}
