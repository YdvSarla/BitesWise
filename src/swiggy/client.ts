import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Address, DishResult, PlatformClient, SearchOutcome } from "../platform.js";
import { cacheGet, cacheSet } from "../cache.js";
import { connectMcp } from "../mcp/connect.js";
import { hasStoredTokens } from "../mcp/oauth.js";

export const SWIGGY_FOOD_URL = "https://mcp.swiggy.com/food";
export const SWIGGY_TOKENS_FILE = new URL("../../.tokens.json", import.meta.url).pathname;

export function hasSwiggyTokens(): boolean {
  return hasStoredTokens(SWIGGY_TOKENS_FILE);
}

/**
 * HARD RULE: this prototype is read-only. Only these tools may ever be
 * called. Cart, checkout, order, payment and address-mutation tools are
 * refused even if some code path asks for them.
 */
const ALLOWED_TOOLS = new Set([
  "get_addresses",
  "search_menu",
  "search_restaurants",
  "get_restaurant_menu",
]);

const THROTTLE_MS = 600;

interface Envelope {
  success?: boolean;
  data?: Record<string, unknown>;
  message?: string;
  error?: { message?: string };
  [key: string]: unknown;
}

export class SwiggyClient implements PlatformClient {
  readonly platform = "swiggy";
  private client: Client;
  private lastCallAt = 0;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(opts: { interactive: boolean }): Promise<SwiggyClient> {
    const client = await connectMcp({
      serverUrl: SWIGGY_FOOD_URL,
      tokensFile: SWIGGY_TOKENS_FILE,
      clientName: "BiteWise (local prototype)",
      callbackPort: Number(process.env.OAUTH_CALLBACK_PORT ?? 8976),
      interactive: opts.interactive,
      platformName: "Swiggy",
      loginHint: "npm run login",
    });
    return new SwiggyClient(client);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listTools() {
    return this.client.listTools();
  }

  /** Sequential + spaced calls; never hammer the server. */
  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + THROTTLE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Envelope> {
    if (!ALLOWED_TOOLS.has(name)) {
      throw new Error(
        `Refusing to call tool "${name}": not in the read-only allowlist [${[...ALLOWED_TOOLS].join(", ")}]`,
      );
    }
    await this.throttle();
    const result = await this.client.callTool({ name, arguments: args });

    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((c: { type: string; text?: string }) => c.text ?? "").join(" ")
        : "";
      throw new Error(`Swiggy tool ${name} failed: ${text || "unknown error"}`);
    }

    // Per Swiggy docs: read structuredContent, never parse result.content.
    const sc = result.structuredContent as Envelope | undefined;
    if (!sc) throw new Error(`Swiggy tool ${name} returned no structuredContent`);
    if (sc.success === false) {
      throw new Error(`Swiggy tool ${name} returned an error: ${sc.error?.message ?? sc.message ?? "unknown"}`);
    }
    return sc;
  }

  private static data(envelope: Envelope): Record<string, unknown> {
    return (envelope.data as Record<string, unknown> | undefined) ?? envelope;
  }

  async getAddresses(): Promise<Address[]> {
    const envelope = await this.call("get_addresses", {});
    const data = SwiggyClient.data(envelope);
    const addresses = (data.addresses as Array<Record<string, unknown>> | undefined) ?? [];
    return addresses.map((a) => ({
      id: String(a.id),
      label: [a.addressTag ?? a.addressCategory, a.addressLine].filter(Boolean).join(" — "),
    }));
  }

  async searchDish(query: string, addressId: string): Promise<SearchOutcome> {
    const cacheKey = `swiggy:search:${addressId}:${query.trim().toLowerCase()}`;
    const cached = cacheGet<Omit<SearchOutcome, "fromCache">>(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    // Live responses (unlike the docs) include per-item deliveryTimeMinutes
    // and restaurant_rating in search_menu, so one call usually suffices;
    // search_restaurants runs only as a fallback when no menu items match.
    const menuEnvelope = await this.call("search_menu", { query, addressId });
    const menuData = SwiggyClient.data(menuEnvelope);
    const items = (menuData.items as Array<Record<string, unknown>> | undefined) ?? [];

    let results: DishResult[] = items.map((item) => {
      const restaurantId = item.restaurant_id !== undefined ? String(item.restaurant_id) : undefined;
      return {
        platform: this.platform,
        restaurant: str(item.restaurant_name) ?? "(unknown restaurant)",
        item: str(item.name) ?? "(unnamed item)",
        price: numOrNull(item.price),
        rating: numOrNull(item.rating) ?? numOrNull(item.restaurant_rating),
        etaMinutes: numOrNull(item.deliveryTimeMinutes),
        url: restaurantId ? `https://www.swiggy.com/restaurants/${restaurantId}` : null,
        isVeg: item.isVeg === undefined ? null : Boolean(item.isVeg),
        inStock: item.inStock === undefined ? true : Boolean(item.inStock),
        offerText: str(item.offer) ?? str(item.offerText) ?? null,
      };
    });

    let restoEnvelope: Envelope | null = null;
    if (results.length === 0) {
      restoEnvelope = await this.call("search_restaurants", { query, addressId });
      const restoData = SwiggyClient.data(restoEnvelope);
      results = ((restoData.dishes as Array<Record<string, unknown>> | undefined) ?? []).map((d) => ({
        platform: this.platform,
        restaurant: str(d.restaurantName) ?? "(unknown restaurant)",
        item: str(d.name) ?? "(unnamed item)",
        price: numOrNull(d.price),
        rating: numOrNull(d.restaurantRating),
        etaMinutes: numOrNull(d.deliveryTimeMinutes),
        url: d.restaurantId !== undefined ? `https://www.swiggy.com/restaurants/${d.restaurantId}` : null,
        isVeg: d.isVeg === undefined ? null : Boolean(d.isVeg),
        inStock: d.inStock === undefined ? true : Boolean(d.inStock),
        offerText: str(d.offer) ?? null,
      }));
    }

    results.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));

    const outcome = {
      results,
      raw: { search_menu: menuEnvelope, search_restaurants: restoEnvelope } as Record<string, unknown>,
      sample: false,
    };
    cacheSet(cacheKey, outcome);
    return { ...outcome, fromCache: false };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Prices arrive already in rupees (verified live: ₹249 comes as 249, not
// 24900 paise). Ratings arrive as strings ("4.2"), hence the coercion.
function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
