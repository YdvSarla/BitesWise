import type { Address, DishResult, PlatformClient } from "./platform.js";
import {
  addressMatchConfidence,
  bestPairs,
  dishMatchConfidence,
  restaurantMatchConfidence,
  ADDRESS_MATCH_THRESHOLD,
  DISH_MATCH_THRESHOLD,
  POSSIBLE_THRESHOLD,
  RESTAURANT_MATCH_THRESHOLD,
} from "./matching.js";
import { SwiggyClient } from "./swiggy/client.js";
import { getZomatoClient, zomatoMode } from "./zomato/client.js";
import { loadPrefs, savePrefs } from "./prefs.js";

export interface ComparisonRow {
  restaurant: string;
  zomatoRestaurant: string;
  item: string;
  zomatoItem: string;
  /** Veg flag from either platform (the matcher never pairs a veg/non-veg conflict). */
  isVeg: boolean | null;
  swiggyPrice: number | null;
  zomatoPrice: number | null;
  /** swiggyPrice - zomatoPrice (positive → cheaper on Zomato). */
  priceDiff: number | null;
  cheaperOn: "swiggy" | "zomato" | "same" | null;
  confidence: number;
  swiggyRating: number | null;
  zomatoRating: number | null;
  swiggyEta: number | null;
  zomatoEta: number | null;
  swiggyOffer: string | null;
  zomatoOffer: string | null;
  swiggyUrl: string | null;
  zomatoUrl: string | null;
}

export interface AddressMatch {
  /** 0..1 confidence that both platforms point at the same place. */
  confidence: number;
  method: "saved-choice" | "auto" | "user-picked" | "sample";
  warning?: string;
}

export interface Comparison {
  query: string;
  matched: ComparisonRow[];
  possible: ComparisonRow[];
  onlySwiggy: DishResult[];
  onlyZomato: DishResult[];
  zomatoSample: boolean;
  errors: { swiggy?: string; zomato?: string };
  swiggyAddress?: string;
  zomatoAddress?: string;
  /** How sure we are that both platforms fetched for the same location. */
  addressMatch?: AddressMatch;
}

interface RestaurantGroup {
  name: string;
  dishes: DishResult[];
}

function groupByRestaurant(results: DishResult[]): RestaurantGroup[] {
  const map = new Map<string, RestaurantGroup>();
  for (const r of results) {
    const g = map.get(r.restaurant) ?? { name: r.restaurant, dishes: [] };
    g.dishes.push(r);
    map.set(r.restaurant, g);
  }
  return [...map.values()];
}

/** Pure match-and-merge over two platforms' results. */
export function buildComparison(
  query: string,
  swiggy: DishResult[],
  zomato: DishResult[],
): Pick<Comparison, "matched" | "possible" | "onlySwiggy" | "onlyZomato"> {
  const restaurantPairs = bestPairs(
    groupByRestaurant(swiggy),
    groupByRestaurant(zomato),
    (a, b) => restaurantMatchConfidence({ name: a.name }, { name: b.name }),
    POSSIBLE_THRESHOLD,
  );

  const matched: ComparisonRow[] = [];
  const possible: ComparisonRow[] = [];
  const onlySwiggy: DishResult[] = [...restaurantPairs.unmatchedA.flatMap((g) => g.dishes)];
  const onlyZomato: DishResult[] = [...restaurantPairs.unmatchedB.flatMap((g) => g.dishes)];

  for (const rPair of restaurantPairs.pairs) {
    const dishPairs = bestPairs(
      rPair.a.dishes,
      rPair.b.dishes,
      (s, z) => dishMatchConfidence({ name: s.item, isVeg: s.isVeg }, { name: z.item, isVeg: z.isVeg }),
      POSSIBLE_THRESHOLD,
    );
    onlySwiggy.push(...dishPairs.unmatchedA);
    onlyZomato.push(...dishPairs.unmatchedB);

    for (const dPair of dishPairs.pairs) {
      const s = dPair.a;
      const z = dPair.b;
      const confidence = Math.round(Math.min(rPair.confidence, dPair.confidence) * 100) / 100;
      const diff = s.price != null && z.price != null ? s.price - z.price : null;
      const row: ComparisonRow = {
        restaurant: s.restaurant,
        zomatoRestaurant: z.restaurant,
        item: s.item,
        zomatoItem: z.item,
        isVeg: s.isVeg ?? z.isVeg,
        swiggyPrice: s.price,
        zomatoPrice: z.price,
        priceDiff: diff,
        cheaperOn: diff == null ? null : diff > 0 ? "zomato" : diff < 0 ? "swiggy" : "same",
        confidence,
        swiggyRating: s.rating,
        zomatoRating: z.rating,
        swiggyEta: s.etaMinutes,
        zomatoEta: z.etaMinutes,
        swiggyOffer: s.offerText,
        zomatoOffer: z.offerText,
        swiggyUrl: s.url,
        zomatoUrl: z.url,
      };
      if (rPair.confidence >= RESTAURANT_MATCH_THRESHOLD && dPair.confidence >= DISH_MATCH_THRESHOLD) {
        matched.push(row);
      } else {
        possible.push(row);
      }
    }
  }

  const byAbsDiff = (a: ComparisonRow, b: ComparisonRow) =>
    Math.abs(b.priceDiff ?? 0) - Math.abs(a.priceDiff ?? 0);
  matched.sort(byAbsDiff);
  possible.sort((a, b) => b.confidence - a.confidence);
  onlySwiggy.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  onlyZomato.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  return { matched, possible, onlySwiggy, onlyZomato };
}

/**
 * Map the chosen Swiggy address to the Zomato address for the SAME place.
 * Neither platform exposes coordinates for saved addresses, so this scores
 * address text (sector numbers, pincodes, locality tokens — see
 * addressMatchConfidence). Below the threshold it defers to `pick` (CLI
 * prompt); without a picker (web) it REFUSES rather than silently comparing
 * two different locations. A user-picked choice is remembered in
 * .prefs.json, keyed to the Swiggy address it was picked for, and is
 * re-resolved if the Swiggy address changes.
 */
export async function resolveZomatoAddress(
  zomato: PlatformClient,
  swiggyAddressId: string,
  swiggyAddressLabel: string,
  pick?: (addresses: Address[]) => Promise<Address>,
): Promise<{ address: Address; match: AddressMatch }> {
  const prefs = loadPrefs();
  const addresses = await zomato.getAddresses();
  if (addresses.length === 0) throw new Error("No saved addresses on the Zomato account.");

  const confidenceOf = (a: Address) => addressMatchConfidence(a.label, swiggyAddressLabel);

  // A remembered choice stays valid only for the Swiggy address it was made
  // for, and is re-verified on every run.
  if (prefs.zomatoAddressId && prefs.zomatoAddressForSwiggyId === swiggyAddressId) {
    const saved = addresses.find((a) => a.id === prefs.zomatoAddressId);
    if (saved) {
      const confidence = confidenceOf(saved);
      return {
        address: saved,
        match: {
          confidence,
          method: "saved-choice",
          warning:
            confidence < ADDRESS_MATCH_THRESHOLD
              ? `Saved Zomato address "${saved.label}" doesn't look like the Swiggy address "${swiggyAddressLabel}" (confidence ${confidence}). Delete .prefs.json to re-pick.`
              : undefined,
        },
      };
    }
  }

  let best = addresses[0];
  let bestScore = -1;
  for (const a of addresses) {
    const score = confidenceOf(a);
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }

  if (bestScore >= ADDRESS_MATCH_THRESHOLD) {
    savePrefs({
      ...prefs,
      zomatoAddressId: best.id,
      zomatoAddressLabel: best.label,
      zomatoAddressForSwiggyId: swiggyAddressId,
    });
    return { address: best, match: { confidence: bestScore, method: "auto" } };
  }

  if (!pick) {
    throw new Error(
      `No Zomato address confidently matches the Swiggy address "${swiggyAddressLabel}" (best: "${best.label}", confidence ${bestScore}). ` +
        `Run \`npm run compare -- "<dish>"\` in a terminal once to pick the right Zomato address — refusing to compare prices across two different locations.`,
    );
  }
  const chosen = await pick(addresses);
  savePrefs({
    ...prefs,
    zomatoAddressId: chosen.id,
    zomatoAddressLabel: chosen.label,
    zomatoAddressForSwiggyId: swiggyAddressId,
  });
  const confidence = confidenceOf(chosen);
  return {
    address: chosen,
    match: {
      confidence,
      method: "user-picked",
      warning:
        confidence < ADDRESS_MATCH_THRESHOLD
          ? `You picked "${chosen.label}" for Swiggy's "${swiggyAddressLabel}" — make sure these really are the same place; prices depend on location.`
          : undefined,
    },
  };
}

export interface CompareOptions {
  pickZomatoAddress?: (addresses: Address[]) => Promise<Address>;
  swiggyAddressId?: string;
  swiggyAddressLabel?: string;
}

/**
 * Run the full comparison. Each platform fails independently: a failure on
 * one side surfaces in `errors` while the other side's results still show.
 */
export async function runCompare(query: string, opts: CompareOptions = {}): Promise<
  Comparison & { raw: Record<string, unknown> }
> {
  const errors: Comparison["errors"] = {};
  let swiggyResults: DishResult[] = [];
  let zomatoResults: DishResult[] = [];
  let zomatoSample = zomatoMode() === "mock";
  let swiggyAddress = opts.swiggyAddressLabel;
  let swiggyAddressId = opts.swiggyAddressId;
  let zomatoAddress: string | undefined;
  let addressMatch: AddressMatch | undefined;
  const raw: Record<string, unknown> = {};

  // Swiggy first, then Zomato — strictly sequential.
  try {
    const swiggy = await SwiggyClient.connect({ interactive: false });
    try {
      if (!swiggyAddressId) {
        const prefs = loadPrefs();
        swiggyAddressId = prefs.addressId;
        swiggyAddress = prefs.addressLabel;
      }
      if (!swiggyAddressId) {
        const addresses = await swiggy.getAddresses();
        if (addresses.length === 0) throw new Error("No saved addresses on the Swiggy account.");
        swiggyAddressId = addresses[0].id;
        swiggyAddress = addresses[0].label;
        savePrefs({ ...loadPrefs(), addressId: swiggyAddressId, addressLabel: swiggyAddress });
      }
      const outcome = await swiggy.searchDish(query, swiggyAddressId);
      swiggyResults = outcome.results;
      raw.swiggy = outcome.raw;
    } finally {
      await swiggy.close();
    }
  } catch (err) {
    errors.swiggy = err instanceof Error ? err.message : String(err);
  }

  try {
    const zomato = await getZomatoClient();
    try {
      let address: Address;
      if (zomatoSample) {
        // Mock mode has no real location; the SAMPLE banner covers it.
        [address] = await zomato.getAddresses();
        addressMatch = { confidence: 0, method: "sample" };
      } else {
        ({ address, match: addressMatch } = await resolveZomatoAddress(
          zomato,
          swiggyAddressId ?? "",
          swiggyAddress ?? "",
          opts.pickZomatoAddress,
        ));
      }
      zomatoAddress = address.label;
      const outcome = await zomato.searchDish(query, address.id, {
        restaurants: [...new Set(swiggyResults.map((r) => r.restaurant))],
      });
      zomatoResults = outcome.results;
      zomatoSample = outcome.sample;
      raw.zomato = outcome.raw;
    } finally {
      await zomato.close();
    }
  } catch (err) {
    errors.zomato = err instanceof Error ? err.message : String(err);
  }

  return {
    query,
    ...buildComparison(query, swiggyResults, zomatoResults),
    zomatoSample,
    errors,
    swiggyAddress,
    zomatoAddress,
    addressMatch,
    raw,
  };
}
