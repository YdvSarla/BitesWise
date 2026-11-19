import { readFileSync, writeFileSync } from "node:fs";

const PREFS_FILE = new URL("../.prefs.json", import.meta.url).pathname;

interface Prefs {
  addressId?: string;
  addressLabel?: string;
  zomatoAddressId?: string;
  zomatoAddressLabel?: string;
  /** The Swiggy address the Zomato choice was made for; invalidates on change. */
  zomatoAddressForSwiggyId?: string;
}

export function loadPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, "utf8")) as Prefs;
  } catch {
    return {};
  }
}

export function savePrefs(prefs: Prefs): void {
  writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2) + "\n");
}
