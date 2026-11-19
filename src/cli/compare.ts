import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runCompare, type ComparisonRow } from "../compare.js";
import type { Address, DishResult } from "../platform.js";

function fmtPrice(p: number | null): string {
  return p == null ? "—" : `₹${p}`;
}

function renderCompareTable(rows: ComparisonRow[]): string {
  const header = ["Restaurant", "Item", "Swiggy", "Zomato", "Diff", "Cheaper on", "Conf"];
  const body = rows.map((r) => [
    r.restaurant,
    r.item + (r.zomatoItem !== r.item ? ` / Z: ${r.zomatoItem}` : ""),
    fmtPrice(r.swiggyPrice) + (r.swiggyOffer ? ` (${r.swiggyOffer})` : ""),
    fmtPrice(r.zomatoPrice) + (r.zomatoOffer ? ` (${r.zomatoOffer})` : ""),
    r.priceDiff == null ? "—" : (r.priceDiff > 0 ? "+" : "") + `₹${Math.abs(r.priceDiff)}`,
    r.cheaperOn ?? "—",
    r.confidence.toFixed(2),
  ]);
  const widths = header.map((h, i) =>
    Math.min(40, Math.max(h.length, ...body.map((row) => row[i].length))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c.length > widths[i] ? c.slice(0, widths[i] - 1) + "…" : c).padEnd(widths[i])).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

function renderOnly(results: DishResult[]): string {
  return results
    .map((r) => `  ${r.restaurant} — ${r.item}: ${fmtPrice(r.price)}${r.offerText ? ` (${r.offerText})` : ""}${r.etaMinutes != null ? `, ${r.etaMinutes} min` : ""}`)
    .join("\n");
}

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: npm run compare -- "paneer butter masala"');
    process.exit(1);
  }

  const pickZomatoAddress = async (addresses: Address[]): Promise<Address> => {
    console.log("\nCouldn't confidently match your Swiggy address to a Zomato one. Zomato addresses:");
    addresses.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`));
    if (!process.stdin.isTTY) {
      console.log("(no interactive terminal — using address 1; edit .prefs.json to change)");
      return addresses[0];
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let choice: Address | undefined;
    while (!choice) {
      const answer = await rl.question(`Pick a Zomato address [1-${addresses.length}]: `);
      choice = addresses[Number(answer) - 1];
    }
    rl.close();
    return choice;
  };

  console.log(`Comparing "${query}" on Swiggy vs Zomato...`);
  const cmp = await runCompare(query, { pickZomatoAddress });

  if (cmp.zomatoSample) {
    console.log("\n" + "█".repeat(64));
    console.log("█  ZOMATO: SAMPLE DATA — fixture prices, NOT live Zomato prices  █");
    console.log("█".repeat(64));
  }
  if (cmp.errors.swiggy) console.error(`\n⚠ Swiggy failed: ${cmp.errors.swiggy}`);
  if (cmp.errors.zomato) console.error(`\n⚠ Zomato failed: ${cmp.errors.zomato}`);
  console.log(`\nAddresses — Swiggy: ${cmp.swiggyAddress ?? "?"} | Zomato: ${cmp.zomatoAddress ?? "?"}`);
  if (cmp.addressMatch && cmp.addressMatch.method !== "sample") {
    console.log(
      `Same-location check: confidence ${cmp.addressMatch.confidence.toFixed(2)} (${cmp.addressMatch.method})`,
    );
    if (cmp.addressMatch.warning) console.error(`⚠ ${cmp.addressMatch.warning}`);
  }

  if (cmp.matched.length > 0) {
    console.log(`\n=== Matched (${cmp.matched.length}) — menu price only; delivery/platform fees, taxes and offers not included ===\n`);
    console.log(renderCompareTable(cmp.matched));
  } else {
    console.log("\nNo confident cross-platform matches.");
  }
  if (cmp.possible.length > 0) {
    console.log(`\n=== Possible matches (${cmp.possible.length}) — below confidence threshold, verify yourself ===\n`);
    console.log(renderCompareTable(cmp.possible));
  }
  if (cmp.onlySwiggy.length > 0) {
    console.log(`\n=== Only on Swiggy (${cmp.onlySwiggy.length}) ===`);
    console.log(renderOnly(cmp.onlySwiggy));
  }
  if (cmp.onlyZomato.length > 0) {
    console.log(`\n=== Only on Zomato (${cmp.onlyZomato.length})${cmp.zomatoSample ? " [SAMPLE DATA]" : ""} ===`);
    console.log(renderOnly(cmp.onlyZomato));
  }

  console.log("\nData: Powered by Swiggy · Powered by Zomato" + (cmp.zomatoSample ? " (Zomato side: SAMPLE fixtures)" : ""));

  mkdirSync(new URL("../../out/", import.meta.url).pathname, { recursive: true });
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outFile = new URL(`../../out/compare-${slug}.json`, import.meta.url).pathname;
  const { raw, ...summary } = cmp;
  writeFileSync(outFile, JSON.stringify({ ...summary, raw }, null, 2));
  console.log(`Full results saved to out/compare-${slug}.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
