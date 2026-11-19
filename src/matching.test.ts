import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressMatchConfidence,
  dishMatchConfidence,
  restaurantMatchConfidence,
  bestPairs,
  ADDRESS_MATCH_THRESHOLD,
  DISH_MATCH_THRESHOLD,
  RESTAURANT_MATCH_THRESHOLD,
  POSSIBLE_THRESHOLD,
} from "./matching.js";

// ---------- dish matching ----------

test("word order does not matter: Paneer Butter Masala == Butter Paneer Masala", () => {
  const c = dishMatchConfidence({ name: "Paneer Butter Masala" }, { name: "Butter Paneer Masala" });
  assert.ok(c >= DISH_MATCH_THRESHOLD, `confidence ${c}`);
});

test("portion guard: Chicken Biryani never matches Chicken Biryani (Half)", () => {
  const c = dishMatchConfidence({ name: "Chicken Biryani" }, { name: "Chicken Biryani (Half)" });
  assert.equal(c, 0);
});

test("portion guard: Half vs Full of the same dish never match", () => {
  const c = dishMatchConfidence({ name: "Butter Chicken (Half)" }, { name: "Butter Chicken (Full)" });
  assert.equal(c, 0);
});

test("same portion marker on both sides is fine", () => {
  const c = dishMatchConfidence({ name: "Chicken Biryani Half" }, { name: "Chicken Biryani (Half)" });
  assert.ok(c >= DISH_MATCH_THRESHOLD, `confidence ${c}`);
});

test("weights count as portions: 1/2 kg vs full dish do not match", () => {
  const c = dishMatchConfidence(
    { name: "Veg Hyderabadi Dum Biryani [1/2 Kg]" },
    { name: "Veg Hyderabadi Dum Biryani" },
  );
  assert.equal(c, 0);
});

test("piece counts count as portions: (2 pcs) vs plain never match", () => {
  const c = dishMatchConfidence({ name: "Veg Dum Biryani Bowl (2 Nos)" }, { name: "Veg Dum Biryani Bowl" });
  assert.equal(c, 0);
});

test("combo guard: thali vs plain dish never match", () => {
  const c = dishMatchConfidence({ name: "Paneer Butter Masala Thali" }, { name: "Paneer Butter Masala" });
  assert.equal(c, 0);
});

test("explicit veg/non-veg conflict never matches", () => {
  const c = dishMatchConfidence(
    { name: "Biryani Special", isVeg: true },
    { name: "Biryani Special", isVeg: false },
  );
  assert.equal(c, 0);
});

test("unrelated dishes score low", () => {
  const c = dishMatchConfidence({ name: "Masala Dosa" }, { name: "Paneer Butter Masala" });
  assert.ok(c < POSSIBLE_THRESHOLD, `confidence ${c}`);
});

test("minor dressing words lower confidence but stay in possible band", () => {
  const c = dishMatchConfidence({ name: "Paneer Butter Masala" }, { name: "Paneer Butter Masala with Butter Naan" });
  assert.ok(c < DISH_MATCH_THRESHOLD && c >= POSSIBLE_THRESHOLD, `confidence ${c}`);
});

// ---------- restaurant matching ----------

test("identical names match at full confidence", () => {
  const c = restaurantMatchConfidence({ name: "Biryani Blues" }, { name: "Biryani Blues" });
  assert.equal(c, 1);
});

test("sponsored suffix and punctuation are ignored", () => {
  const c = restaurantMatchConfidence(
    { name: "Punjabi Angithi (Vegorama Group) (Ad)" },
    { name: "Punjabi Angithi - Vegorama Group" },
  );
  assert.ok(c >= RESTAURANT_MATCH_THRESHOLD, `confidence ${c}`);
});

test("same chain, different outlets must NOT merge", () => {
  const c = restaurantMatchConfidence(
    { name: "Biryani Blues (Sector 48)" },
    { name: "Biryani Blues (Sector 29)" },
  );
  assert.ok(c < RESTAURANT_MATCH_THRESHOLD, `confidence ${c}`);
});

test("same chain, same outlet spelled differently merges", () => {
  const c = restaurantMatchConfidence(
    { name: "Biryani Blues Sector 48" },
    { name: "Biryani Blues, Sector 48" },
  );
  assert.ok(c >= RESTAURANT_MATCH_THRESHOLD, `confidence ${c}`);
});

test("outlet info in area field disambiguates too", () => {
  const c = restaurantMatchConfidence(
    { name: "Biryani Blues", area: "Sector 48" },
    { name: "Biryani Blues", area: "Sector 29" },
  );
  assert.ok(c < RESTAURANT_MATCH_THRESHOLD, `confidence ${c}`);
});

test("far-apart coordinates block a name-identical match", () => {
  const c = restaurantMatchConfidence(
    { name: "Biryani Blues", latitude: 28.42, longitude: 77.04 },
    { name: "Biryani Blues", latitude: 28.47, longitude: 77.08 },
  );
  assert.ok(c < RESTAURANT_MATCH_THRESHOLD, `confidence ${c}`);
});

test("different restaurants do not match", () => {
  const c = restaurantMatchConfidence({ name: "Samrat Sweets" }, { name: "Sagar Ratna" });
  assert.ok(c < POSSIBLE_THRESHOLD, `confidence ${c}`);
});

// ---------- address matching (same-location check) ----------

test("same place, different platform spellings, matches", () => {
  const c = addressMatchConfidence(
    "Work — Test User: Suite 4 , 1st Floor , Lotus Business Park, Green Avenue, Sector 48, Gurugram, Haryana 122001, India",
    "Work — Suite 4 1st Floor12, Lotus Coworking - Lotus Business Park, Old Sohna Rd, Green Avenue, Sector 48, Gurugram, Haryana, India",
  );
  assert.ok(c >= ADDRESS_MATCH_THRESHOLD, `confidence ${c}`);
});

test("different localities do not match (Work vs Home case)", () => {
  const c = addressMatchConfidence(
    "Work — Lotus Business Park, Green Avenue, Sector 48, Gurugram, Haryana 122001, India",
    "Home — Rose Cottage , Near Old Banyan Tree, Rampur Village",
  );
  assert.ok(c < ADDRESS_MATCH_THRESHOLD, `confidence ${c}`);
});

test("conflicting sector numbers are decisive even with shared city", () => {
  const c = addressMatchConfidence(
    "Tower B, DLF Corporate Greens, Sector 74A, Gurugram, Haryana, India",
    "Tower B, DLF Corporate Greens, Sector 21, Gurugram, Haryana, India",
  );
  assert.ok(c < ADDRESS_MATCH_THRESHOLD, `confidence ${c}`);
});

test("conflicting pincodes are decisive", () => {
  const c = addressMatchConfidence(
    "4B Galleria Market, Gurugram 122009, India",
    "4B Galleria Market, Gurugram 122001, India",
  );
  assert.ok(c < ADDRESS_MATCH_THRESHOLD, `confidence ${c}`);
});

// ---------- assignment ----------

test("bestPairs is one-to-one, highest confidence first", () => {
  const as = ["Biryani Blues", "Biryani Blues Express"];
  const bs = ["Biryani Blues"];
  const { pairs, unmatchedA } = bestPairs(
    as,
    bs,
    (a, b) => restaurantMatchConfidence({ name: a }, { name: b }),
    POSSIBLE_THRESHOLD,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, "Biryani Blues");
  assert.equal(unmatchedA.length, 1);
});
