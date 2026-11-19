import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { SwiggyClient } from "../swiggy/client.js";
import { loadPrefs, savePrefs } from "../prefs.js";
import { renderTable } from "../table.js";
import type { Address } from "../platform.js";

async function pickAddress(addresses: Address[]): Promise<Address> {
  const prefs = loadPrefs();
  if (prefs.addressId) {
    const saved = addresses.find((a) => a.id === prefs.addressId);
    if (saved) return saved;
  }
  if (addresses.length === 1) {
    savePrefs({ addressId: addresses[0].id, addressLabel: addresses[0].label });
    return addresses[0];
  }

  console.log("\nYour saved Swiggy addresses:");
  addresses.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`));
  if (!process.stdin.isTTY) {
    console.log("(no interactive terminal — using address 1; edit .prefs.json to change)");
    savePrefs({ addressId: addresses[0].id, addressLabel: addresses[0].label });
    return addresses[0];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let choice: Address | undefined;
  while (!choice) {
    const answer = await rl.question(`Pick an address [1-${addresses.length}]: `);
    choice = addresses[Number(answer) - 1];
  }
  rl.close();
  savePrefs({ addressId: choice.id, addressLabel: choice.label });
  console.log(`(Saved as default — delete .prefs.json to change it.)\n`);
  return choice;
}

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: npm run search -- "paneer butter masala"');
    process.exit(1);
  }

  const client = await SwiggyClient.connect({ interactive: false });
  try {
    const addresses = await client.getAddresses();
    if (addresses.length === 0) {
      throw new Error("No saved addresses on this Swiggy account. Add one in the Swiggy app first.");
    }
    const address = await pickAddress(addresses);
    console.log(`Searching "${query}" near: ${address.label}`);

    const { results, raw, fromCache } = await client.searchDish(query, address.id);
    if (fromCache) console.log("(served from local cache)");

    console.log("\n" + renderTable(results) + "\n");
    console.log(`${results.length} items — data: Powered by Swiggy`);

    mkdirSync(new URL("../../out/", import.meta.url).pathname, { recursive: true });
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const outFile = new URL(`../../out/${slug}.json`, import.meta.url).pathname;
    writeFileSync(outFile, JSON.stringify({ query, addressId: address.id, results, raw }, null, 2));
    console.log(`Raw results saved to out/${slug}.json`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
