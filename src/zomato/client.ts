import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Address, DishResult, PlatformClient, SearchHints, SearchOutcome } from "../platform.js";
import { cacheGet, cacheSet } from "../cache.js";
import { connectMcp } from "../mcp/connect.js";
import { hasStoredTokens } from "../mcp/oauth.js";
import {
  textSimilarity,
  normalizeText,
  restaurantMatchConfidence,
  RESTAURANT_MATCH_THRESHOLD,
} from "../matching.js";

export const ZOMATO_MCP_URL = "https://mcp-server.zomato.com/mcp";
export const ZOMATO_TOKENS_FILE = new URL("../../.tokens.zomato.json", import.meta.url).pathname;

export function hasZomatoTokens(): boolean {
  return hasStoredTokens(ZOMATO_TOKENS_FILE);
}

/**
 * HARD RULE: read-only. Zomato's server also exposes cart/checkout/order and
 * phone-binding tools; none of them may ever be called.
 */
const ALLOWED_TOOLS = new Set([
  "get_saved_addresses_for_user",
  "get_restaurants_for_keyword",
  "get_menu_items_listing",
  "get_restaurant_menu_by_categories",
]);

const THROTTLE_MS = 600;
/** Menus fetched per search from the keyword pass. */
const MAX_RESTAURANT_MENUS = 5;
/** Extra restaurant-name lookups driven by the other platform's results. */
const MAX_HINT_LOOKUPS = 3;
/** Minimum name similarity for a menu item to count as a hit for the query
 * (0.55 keeps "Chicken Hyderabadi Biryani" for "chicken biryani" while
 * dropping "Chicken Fry" and "Veg Biryani"). */
const ITEM_RELEVANCE = 0.55;

type Json = Record<string, unknown>;

export class ZomatoLiveClient implements PlatformClient {
  readonly platform = "zomato";
  private client: Client;
  private lastCallAt = 0;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(opts: { interactive: boolean }): Promise<ZomatoLiveClient> {
    const client = await connectMcp({
      serverUrl: ZOMATO_MCP_URL,
      tokensFile: ZOMATO_TOKENS_FILE,
      clientName: "BiteWise (local prototype)",
      callbackPort: Number(process.env.OAUTH_CALLBACK_PORT ?? 8976),
      interactive: opts.interactive,
      platformName: "Zomato",
      loginHint: "npm run login:zomato",
    });
    return new ZomatoLiveClient(client);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listTools() {
    return this.client.listTools();
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + THROTTLE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private async call(name: string, args: Json): Promise<Json> {
    if (!ALLOWED_TOOLS.has(name)) {
      throw new Error(
        `Refusing to call Zomato tool "${name}": not in the read-only allowlist [${[...ALLOWED_TOOLS].join(", ")}]`,
      );
    }
    await this.throttle();
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((c: { type: string; text?: string }) => c.text ?? "").join(" ")
        : "";
      throw new Error(`Zomato tool ${name} failed: ${text || "unknown error"}`);
    }
    const sc = result.structuredContent as Json | undefined;
    if (!sc) throw new Error(`Zomato tool ${name} returned no structuredContent`);
    return sc;
  }

  async getAddresses(): Promise<Address[]> {
    const sc = await this.call("get_saved_addresses_for_user", {});
    const result = (sc.result as Json | undefined) ?? sc;
    const addresses = (result.addresses as Json[] | undefined) ?? [];
    return addresses
      .filter((a) => a.address_id != null)
      .map((a) => ({
        id: String(a.address_id),
        label: [a.label, a.location_name].filter(Boolean).join(" — "),
      }));
  }

  async searchDish(query: string, addressId: string, hints?: SearchHints): Promise<SearchOutcome> {
    const hintKey = (hints?.restaurants ?? []).map((h) => h.toLowerCase()).sort().join("|");
    const cacheKey = `zomato:search:${addressId}:${query.trim().toLowerCase()}:${hintKey}`;
    const cached = cacheGet<Omit<SearchOutcome, "fromCache">>(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    const restoSc = await this.call("get_restaurants_for_keyword", {
      address_id: addressId,
      keyword: query,
      page_size: 10,
    });
    const restaurants =
      (restoSc.results as Json[] | undefined) ??
      ((restoSc.result as Json | undefined)?.results as Json[] | undefined) ??
      [];

    const results: DishResult[] = [];
    const rawMenus: Json[] = [];
    const processed = new Set<number>();
    const coveredNames: string[] = [];

    for (const r of restaurants.slice(0, MAX_RESTAURANT_MENUS)) {
      await this.fetchRestaurantDishes(r, query, addressId, results, rawMenus, processed);
      if (typeof r.name === "string") coveredNames.push(r.name);
    }

    // Targeted pass: Swiggy and Zomato keyword searches often surface
    // different restaurants. Look up (a few of) the other platform's
    // restaurant names directly so same-restaurant comparison is possible.
    const pending = (hints?.restaurants ?? [])
      .filter((name) =>
        !coveredNames.some(
          (c) => restaurantMatchConfidence({ name }, { name: c }) >= RESTAURANT_MATCH_THRESHOLD,
        ),
      )
      .slice(0, MAX_HINT_LOOKUPS);

    for (const name of pending) {
      try {
        const hintSc = await this.call("get_restaurants_for_keyword", {
          address_id: addressId,
          keyword: name,
          page_size: 5,
        });
        const candidates =
          (hintSc.results as Json[] | undefined) ??
          ((hintSc.result as Json | undefined)?.results as Json[] | undefined) ??
          [];
        const match = candidates.find(
          (c) =>
            typeof c.name === "string" &&
            restaurantMatchConfidence({ name }, { name: c.name }) >= RESTAURANT_MATCH_THRESHOLD,
        );
        if (match) {
          await this.fetchRestaurantDishes(match, query, addressId, results, rawMenus, processed);
        } else {
          rawMenus.push({ hint: name, note: "no matching Zomato restaurant found" });
        }
      } catch (err) {
        rawMenus.push({ hint: name, error: String(err) });
      }
    }

    results.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));

    const outcome = {
      results,
      raw: { get_restaurants_for_keyword: restoSc, menus: rawMenus } as Record<string, unknown>,
      sample: false,
    };
    cacheSet(cacheKey, outcome);
    return { ...outcome, fromCache: false };
  }

  /**
   * get_menu_items_listing gives item->category mappings (no prices), then
   * get_restaurant_menu_by_categories on the relevant categories gives the
   * priced items.
   */
  private async fetchRestaurantDishes(
    r: Json,
    query: string,
    addressId: string,
    results: DishResult[],
    rawMenus: Json[],
    processed: Set<number>,
  ): Promise<void> {
    if (r.res_id == null) return;
    const resId = Number(r.res_id);
    if (processed.has(resId)) return;
    processed.add(resId);
    try {
      const listingSc = await this.call("get_menu_items_listing", {
        res_id: resId,
        address_id: addressId,
      });
      const listingData = dig(listingSc);
      const mappings = (listingData.item_mappings as Json[] | undefined) ?? [];
      const categories = [
        ...new Set(
          mappings
            .filter((m) => typeof m.item_name === "string" && isRelevant(query, m.item_name as string))
            .flatMap((m) => (m.categories as string[] | undefined) ?? []),
        ),
      ].slice(0, 4);
      if (categories.length === 0) {
        rawMenus.push({ res_id: resId, note: "no matching items in listing" });
        return;
      }

      const menuSc = await this.call("get_restaurant_menu_by_categories", {
        res_id: resId,
        categories,
        address_id: addressId,
      });
      rawMenus.push({ res_id: resId, categories, menu: menuSc });
      const data = dig(menuSc);
      const items = (data.menu_items as Json[] | undefined) ?? [];
      for (const item of items) {
        const name = typeof item.name === "string" ? item.name : "";
        if (!name || !isRelevant(query, name)) continue;
        results.push({
          platform: "zomato",
          restaurant: str(r.name) ?? str(data.restaurant_name) ?? "(unknown restaurant)",
          item: name,
          price: numOrNull(item.price),
          // Zomato's item-level `rating` is a 0–1 fraction (mostly 0), not a
          // star rating; the restaurant's 0–5 rating is comparable with Swiggy's.
          rating: numOrNull(r.rating),
          etaMinutes: parseEtaMinutes(r.eta),
          url: `https://www.zomato.com/order/${resId}`,
          isVeg: vegFromItem(item),
          inStock: item.in_stock === undefined && item.is_available === undefined
            ? true
            : Boolean(item.in_stock ?? item.is_available),
          offerText: str(r.res_offer) ?? str(item.offer) ?? null,
        });
      }
    } catch (err) {
      rawMenus.push({ res_id: resId, error: String(err) });
    }
  }
}

/** Unwrap the {result:{data:{...}}} nesting Zomato uses, tolerantly. */
function dig(sc: Json): Json {
  const result = (sc.result as Json | undefined) ?? sc;
  return (result.data as Json | undefined) ?? result;
}

function isRelevant(query: string, itemName: string): boolean {
  const q = normalizeText(query);
  const n = normalizeText(itemName);
  if (n.includes(q)) return true;
  return textSimilarity(q, n) >= ITEM_RELEVANCE;
}

function parseEtaMinutes(eta: unknown): number | null {
  if (typeof eta === "number") return eta;
  if (typeof eta !== "string") return null;
  const m = eta.match(/\d+/);
  return m ? Number(m[0]) : null;
}

function vegFromItem(item: Json): boolean | null {
  const v = item.is_veg ?? item.isVeg ?? item.veg ?? item.dietary_slug;
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return /^(veg|pure-veg|pure_veg)$/i.test(v) ? true : /non/i.test(v) ? false : null;
  return Boolean(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

interface ZomatoFixture {
  _sample: true;
  note?: string;
  results: Array<Partial<DishResult>>;
}

/**
 * Fixture-backed stand-in (PLATFORM_ZOMATO=mock) for offline work. Every
 * outcome carries sample=true, which the CLI and web UI render as a
 * "ZOMATO: SAMPLE DATA" banner so mock prices are never mistaken for real.
 */
export class MockZomatoClient implements PlatformClient {
  readonly platform = "zomato";

  private fixturesDir = new URL("../../fixtures/zomato/", import.meta.url).pathname;

  async close(): Promise<void> {}

  async getAddresses(): Promise<Address[]> {
    return [{ id: "zomato-sample-address", label: "SAMPLE — same area as your Swiggy address" }];
  }

  async searchDish(query: string, _addressId: string): Promise<SearchOutcome> {
    const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let fixture: ZomatoFixture;
    try {
      fixture = JSON.parse(readFileSync(`${this.fixturesDir}${slug}.json`, "utf8")) as ZomatoFixture;
    } catch {
      return {
        results: [],
        raw: { note: `No fixture at fixtures/zomato/${slug}.json — mock Zomato has no data for this dish.` },
        fromCache: false,
        sample: true,
      };
    }
    const results: DishResult[] = fixture.results.map((r) => ({
      platform: "zomato",
      restaurant: r.restaurant ?? "(unknown restaurant)",
      item: r.item ?? "(unnamed item)",
      price: r.price ?? null,
      rating: r.rating ?? null,
      etaMinutes: r.etaMinutes ?? null,
      url: r.url ?? null,
      isVeg: r.isVeg ?? null,
      inStock: r.inStock ?? true,
      offerText: r.offerText ?? null,
    }));
    results.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));
    return { results, raw: { fixture: slug, _sample: true }, fromCache: false, sample: true };
  }
}

export type ZomatoMode = "mock" | "live";

export function zomatoMode(): ZomatoMode {
  const mode = (process.env.PLATFORM_ZOMATO ?? "live").toLowerCase();
  if (mode !== "mock" && mode !== "live") {
    throw new Error(`PLATFORM_ZOMATO must be "mock" or "live", got "${mode}"`);
  }
  return mode;
}

export async function getZomatoClient(): Promise<PlatformClient> {
  if (zomatoMode() === "live") {
    return ZomatoLiveClient.connect({ interactive: false });
  }
  return new MockZomatoClient();
}
