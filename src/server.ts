import "./env.js";
import express from "express";
import { SwiggyClient } from "./swiggy/client.js";
import { runCompare } from "./compare.js";
import { loadPrefs, savePrefs } from "./prefs.js";

const PORT = Number(process.env.PORT ?? 3000);
// Loopback only by default: the API acts with your Swiggy/Zomato login, so
// other machines on the network must not reach it. Set HOST=0.0.0.0 to expose it deliberately.
const HOST = process.env.HOST ?? "127.0.0.1";
const app = express();
app.use(express.static(new URL("../public/", import.meta.url).pathname));

let clientPromise: Promise<SwiggyClient> | null = null;

function getClient(): Promise<SwiggyClient> {
  clientPromise ??= SwiggyClient.connect({ interactive: false });
  return clientPromise;
}

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing ?q=dish name" });
    return;
  }
  try {
    const client = await getClient();

    let { addressId, addressLabel } = loadPrefs();
    if (!addressId) {
      const addresses = await client.getAddresses();
      if (addresses.length === 0) throw new Error("No saved addresses on this Swiggy account.");
      ({ id: addressId, label: addressLabel } = addresses[0]);
      savePrefs({ addressId, addressLabel });
    }

    const { results, fromCache } = await client.searchDish(query, addressId);
    res.json({ query, address: addressLabel, fromCache, results });
  } catch (err) {
    clientPromise = null; // reconnect on next request if the session dropped
    const message = err instanceof Error ? err.message : String(err);
    res.status(message.includes("npm run login") ? 401 : 502).json({ error: message });
  }
});

app.get("/api/compare", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing ?q=dish name" });
    return;
  }
  try {
    // No interactive picker in the web flow: best-guess Zomato address.
    const { raw, ...comparison } = await runCompare(query);
    res.json(comparison);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

// Express 5 calls this callback on failure too (e.g. port already in use).
app.listen(PORT, HOST, (err?: Error) => {
  if (err) {
    console.error(`Could not start BiteWise on ${HOST}:${PORT}: ${err.message}`);
    console.error("Is another copy running? Stop it, or set a different PORT in .env.");
    process.exit(1);
  }
  console.log(`BiteWise → http://localhost:${PORT}`);
  console.log("(requires a prior `npm run login`)");
});
