/**
 * Platform-agnostic interface so a second platform (e.g. Zomato) can be
 * added later without touching the CLI or web UI.
 */

export interface Address {
  id: string;
  label: string;
}

export interface DishResult {
  platform: string;
  restaurant: string;
  item: string;
  /** Price in rupees, null if the platform did not return one. */
  price: number | null;
  /** Item rating if available, else restaurant rating. */
  rating: number | null;
  etaMinutes: number | null;
  url: string | null;
  isVeg: boolean | null;
  inStock: boolean;
  /** Offer/discount text as the platform returned it; never computed into the price. */
  offerText: string | null;
}

export interface SearchOutcome {
  results: DishResult[];
  /** Raw platform responses, for out/<dish>.json and debugging. */
  raw: Record<string, unknown>;
  fromCache: boolean;
  /** True when the data is fixture/sample data, not live platform data. */
  sample: boolean;
}

export interface SearchHints {
  /** Restaurant names seen on the other platform, to also look up here. */
  restaurants?: string[];
}

export interface PlatformClient {
  readonly platform: string;
  getAddresses(): Promise<Address[]>;
  searchDish(query: string, addressId: string, hints?: SearchHints): Promise<SearchOutcome>;
  close(): Promise<void>;
}
