import type { DishResult } from "./platform.js";

export function renderTable(results: DishResult[]): string {
  if (results.length === 0) return "No matching dishes found.";

  const rows = results.map((r) => [
    r.restaurant,
    r.item + (r.isVeg === false ? " (non-veg)" : ""),
    r.price === null ? "—" : `₹${r.price}`,
    r.rating === null ? "—" : r.rating.toFixed(1),
    r.etaMinutes === null ? "—" : `${r.etaMinutes} min`,
    r.inStock ? "" : "OUT OF STOCK",
  ]);
  const header = ["Restaurant", "Item", "Price", "Rating", "ETA", ""];

  const widths = header.map((h, i) =>
    Math.min(42, Math.max(h.length, ...rows.map((row) => row[i].length))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => trunc(c, widths[i]).padEnd(widths[i])).join("  ");

  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

function trunc(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}
