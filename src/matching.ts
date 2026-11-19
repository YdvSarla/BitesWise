/**
 * Cross-platform restaurant and dish matching with confidence scores.
 * Dependency-free on purpose: token-set similarity plus domain guards
 * (outlet/locality disambiguation for restaurants, portion/size guards for
 * dishes). All thresholds live here so the comparison layer and tests agree.
 */

export const RESTAURANT_MATCH_THRESHOLD = 0.75;
export const DISH_MATCH_THRESHOLD = 0.8;
export const POSSIBLE_THRESHOLD = 0.55;

// ---------- text normalization ----------

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s).split(" ").filter(Boolean);
}

/** Order-insensitive similarity of two free-text strings (0..1). */
export function textSimilarity(a: string, b: string): number {
  return diceSimilarity(tokens(a), tokens(b));
}

/** Dice coefficient over token sets (order-insensitive). */
function diceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  return (2 * common) / (setA.size + setB.size);
}

// ---------- restaurant matching ----------

/** Generic words that don't distinguish one restaurant from another. */
const RESTAURANT_NOISE = new Set([
  "the", "a", "an", "restaurant", "restaurants", "hotel", "hotels", "and", "by",
  "ad", // Swiggy marks sponsored listings with an "(Ad)" suffix
]);

/** Tokens that locate an outlet rather than name the brand. */
const LOCALITY_TOKENS = /^(sector|sec|phase|block|dlf|cyberhub|cyber|market|main|road|marg|near|opp|opposite|floor|tower|mall|plaza|gurugram|gurgaon|delhi|noida|faridabad)$/;

interface RestaurantParts {
  core: string[];
  /** Core plus descriptive (non-locality) qualifier tokens. */
  extended: string[];
  outlet: string[];
}

/**
 * Split a restaurant name into brand ("core") tokens and outlet/locality
 * tokens. Parenthesized segments and segments after " - " or "," are treated
 * as qualifiers: locality-looking qualifiers (or ones with digits) count as
 * outlet markers, descriptive ones ("Biryani & Beyond") stay out of both.
 */
export function restaurantParts(name: string): RestaurantParts {
  const outlet: string[] = [];
  let working = name;

  const qualifiers: string[] = [];
  working = working.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    qualifiers.push(inner);
    return " ";
  });
  const dashSplit = working.split(/\s[-|,]\s|,\s*/);
  working = dashSplit[0];
  qualifiers.push(...dashSplit.slice(1));

  const descriptive: string[] = [];
  for (const q of qualifiers) {
    const qTokens = tokens(q).filter((t) => !RESTAURANT_NOISE.has(t));
    const isLocality = qTokens.some((t) => LOCALITY_TOKENS.test(t) || /\d/.test(t));
    if (isLocality) outlet.push(...qTokens);
    else descriptive.push(...qTokens);
  }

  const core = tokens(working).filter((t) => !RESTAURANT_NOISE.has(t) && !LOCALITY_TOKENS.test(t));
  const safeCore = core.length > 0 ? core : tokens(working);
  return { core: safeCore, extended: [...safeCore, ...descriptive], outlet };
}

export interface RestaurantForMatch {
  name: string;
  /** Platform-reported area/locality, if any. */
  area?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export function restaurantMatchConfidence(a: RestaurantForMatch, b: RestaurantForMatch): number {
  const pa = restaurantParts(a.name);
  const pb = restaurantParts(b.name);

  // One platform often folds a descriptor into the name ("Punjabi Angithi
  // By Vegorama Group") that the other puts in parentheses — score both the
  // bare and the descriptor-extended views and keep the better one.
  let confidence = Math.max(
    diceSimilarity(pa.core, pb.core),
    diceSimilarity(pa.extended, pb.extended),
  );
  if (pa.core.join(" ") === pb.core.join(" ")) confidence = 1;

  // Outlet disambiguation: same brand at two different outlets must not
  // merge. Compare outlet tokens from the names plus the reported area.
  // Only distinguishing tokens decide ("48" vs "29"); generic locality
  // words like "sector"/"phase" appear on both sides of different outlets.
  const specific = (ts: string[]) => ts.filter((t) => !LOCALITY_TOKENS.test(t) && !RESTAURANT_NOISE.has(t));
  const outletA = specific([...pa.outlet, ...(a.area ? tokens(a.area) : [])]);
  const outletB = specific([...pb.outlet, ...(b.area ? tokens(b.area) : [])]);
  if (outletA.length > 0 && outletB.length > 0) {
    const overlap = outletA.some((t) => outletB.includes(t));
    if (!overlap) confidence = Math.min(confidence, POSSIBLE_THRESHOLD);
    // Same-named outlet qualifiers agreeing is weak extra evidence.
    else confidence = Math.min(1, confidence + 0.05);
  }

  // Coordinates, when both platforms provide them, are decisive for outlets.
  if (
    a.latitude != null && a.longitude != null &&
    b.latitude != null && b.longitude != null
  ) {
    const km = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
    if (km > 1.5) confidence = Math.min(confidence, POSSIBLE_THRESHOLD - 0.05);
    else if (km < 0.25) confidence = Math.min(1, confidence + 0.1);
  }

  return round2(confidence);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- address matching (same-location verification) ----------

/** Below this, two saved addresses are not assumed to be the same place. */
export const ADDRESS_MATCH_THRESHOLD = 0.5;

const ADDRESS_STOPWORDS = new Set([
  "india", "near", "opp", "opposite", "road", "rd", "marg", "street", "st",
  "the", "and", "floor", "no", "house", "building",
]);

function addressTokens(s: string): string[] {
  return [...new Set(tokens(s).filter((t) => !ADDRESS_STOPWORDS.has(t)))];
}

function sectorNumbers(toks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if ((toks[i] === "sector" || toks[i] === "sec") && /^\d+[a-z]?$/.test(toks[i + 1] ?? "")) {
      out.push(toks[i + 1]);
    }
  }
  return out;
}

/**
 * Confidence (0..1) that two saved-address strings point at the same place.
 * Platforms don't expose coordinates for saved addresses, so this relies on
 * text: locality token overlap, with sector numbers and pincodes as strong
 * agree/disagree signals. Pass the full label including the Work/Home tag.
 */
export function addressMatchConfidence(a: string, b: string): number {
  const ta = addressTokens(a);
  const tb = addressTokens(b);
  let confidence = diceSimilarity(ta, tb);

  // Sector numbers: agreement is a strong signal, disagreement is decisive.
  const secA = sectorNumbers(ta);
  const secB = sectorNumbers(tb);
  if (secA.length > 0 && secB.length > 0) {
    if (secA.some((s) => secB.includes(s))) confidence += 0.25;
    else return Math.min(confidence, 0.2);
  }

  // Indian pincodes (6 digits), when both sides have one.
  const pinA = ta.filter((t) => /^\d{6}$/.test(t));
  const pinB = tb.filter((t) => /^\d{6}$/.test(t));
  if (pinA.length > 0 && pinB.length > 0) {
    if (pinA.some((p) => pinB.includes(p))) confidence += 0.2;
    else return Math.min(confidence, 0.2);
  }

  return round2(Math.min(1, confidence));
}

// ---------- dish matching ----------

/** Portion/size markers: dishes whose markers differ must never match. */
const PORTION_WORDS = new Set([
  "half", "full", "mini", "small", "medium", "large", "regular", "family",
  "jumbo", "single", "double", "bowl", "bucket",
]);
const COMBO_WORDS = new Set(["combo", "thali", "meal", "meals", "platter", "set"]);

interface DishParts {
  core: string[];
  /** Canonical portion signature, "" when no markers present. */
  portionKey: string;
  comboKey: string;
}

export function dishParts(name: string): DishParts {
  const all = tokens(name);
  const portion: string[] = [];
  const combo: string[] = [];
  const core: string[] = [];

  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    // weights/volumes: "430", "gms" / "1/2", "kg" / "500ml"
    if (/^\d+(ml|l|g|gm|gms|kg)$/.test(t)) { portion.push(t); continue; }
    if (/^\d+$/.test(t) || t === "1/2" || t === "3/4" || t === "1/4") {
      const next = all[i + 1];
      if (next && /^(ml|l|g|gm|gms|kg|pc|pcs|piece|pieces|nos|no)$/.test(next)) {
        portion.push(canonUnit(t, next));
        i++;
        continue;
      }
      if (all[i - 1] === "serves") { portion.push(`serves${t}`); continue; }
      portion.push(t);
      continue;
    }
    if (t === "serves") continue; // consumed with the following number
    if (PORTION_WORDS.has(t)) { portion.push(t); continue; }
    if (COMBO_WORDS.has(t)) { combo.push(t); continue; }
    core.push(t);
  }

  return {
    core,
    portionKey: [...portion].sort().join("+"),
    comboKey: [...combo].sort().join("+"),
  };
}

function canonUnit(num: string, unit: string): string {
  const u = unit.replace(/^gms?$/, "g").replace(/^pcs?$|^pieces?$|^nos?$/, "pc");
  return `${num}${u}`;
}

export interface DishForMatch {
  name: string;
  isVeg?: boolean | null;
}

export function dishMatchConfidence(a: DishForMatch, b: DishForMatch): number {
  // Hard guards first: portion/size and combo markers must agree exactly,
  // and an explicit veg/non-veg conflict is disqualifying.
  const pa = dishParts(a.name);
  const pb = dishParts(b.name);
  if (pa.portionKey !== pb.portionKey) return 0;
  if (pa.comboKey !== pb.comboKey) return 0;
  if (a.isVeg === true && b.isVeg === false) return 0;
  if (a.isVeg === false && b.isVeg === true) return 0;

  let confidence = diceSimilarity(pa.core, pb.core);
  if (pa.core.join(" ") === pb.core.join(" ")) confidence = 1;
  return round2(confidence);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- generic best-pair assignment ----------

export interface Pair<A, B> {
  a: A;
  b: B;
  confidence: number;
}

/**
 * Greedy highest-confidence-first one-to-one assignment. Pairs below
 * `minConfidence` are never formed.
 */
export function bestPairs<A, B>(
  as: A[],
  bs: B[],
  score: (a: A, b: B) => number,
  minConfidence: number,
): { pairs: Pair<A, B>[]; unmatchedA: A[]; unmatchedB: B[] } {
  const candidates: Array<{ i: number; j: number; confidence: number }> = [];
  as.forEach((a, i) =>
    bs.forEach((b, j) => {
      const confidence = score(a, b);
      if (confidence >= minConfidence) candidates.push({ i, j, confidence });
    }),
  );
  candidates.sort((x, y) => y.confidence - x.confidence);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: Pair<A, B>[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push({ a: as[c.i], b: bs[c.j], confidence: c.confidence });
  }
  return {
    pairs,
    unmatchedA: as.filter((_, i) => !usedA.has(i)),
    unmatchedB: bs.filter((_, j) => !usedB.has(j)),
  };
}
