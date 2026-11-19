import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { ZomatoLiveClient, hasZomatoTokens } from "../zomato/client.js";

async function main() {
  if (hasZomatoTokens()) {
    console.log("Found saved Zomato tokens — verifying they still work...");
  } else {
    console.log("No saved Zomato tokens — starting browser login.");
    console.log(
      "NOTE: Zomato's MCP README says only a few redirect URIs are whitelisted, so this attempt may be rejected.",
    );
  }

  const client = await ZomatoLiveClient.connect({ interactive: true });
  const { tools } = await client.listTools();
  console.log(`\n✅ Logged in. Zomato MCP exposes ${tools.length} tools for your account:\n`);
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const args = Object.keys(schema.properties ?? {})
      .map((k) => (schema.required?.includes(k) ? `${k}*` : k))
      .join(", ");
    console.log(`- ${tool.name}(${args})`);
  }
  mkdirSync(new URL("../../out/", import.meta.url).pathname, { recursive: true });
  writeFileSync(
    new URL("../../out/zomato-tools.json", import.meta.url).pathname,
    JSON.stringify(tools, null, 2),
  );
  console.log("\nFull schemas written to out/zomato-tools.json");
  console.log("Tokens saved to .tokens.zomato.json (gitignored).");
  await client.close();
}

main().catch((err) => {
  console.error(`\nZomato login failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
