import "../env.js";
import { SwiggyClient, hasSwiggyTokens } from "../swiggy/client.js";

async function main() {
  if (hasSwiggyTokens()) {
    console.log("Found saved tokens — verifying they still work...");
  } else {
    console.log("No saved tokens — starting browser login (phone + OTP happen in the browser).");
  }

  const client = await SwiggyClient.connect({ interactive: true });
  const { tools } = await client.listTools();
  console.log(`\n✅ Logged in. Swiggy Food MCP exposes ${tools.length} tools for your account.`);
  console.log("Tokens saved to .tokens.json (gitignored). Next: npm run search -- \"dish name\"");
  await client.close();
}

main().catch((err) => {
  console.error(`\nLogin failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
