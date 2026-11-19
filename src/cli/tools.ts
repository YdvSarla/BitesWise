import { mkdirSync, writeFileSync } from "node:fs";
import { SwiggyClient } from "../swiggy/client.js";

async function main() {
  const client = await SwiggyClient.connect({ interactive: false });
  const { tools } = await client.listTools();
  await client.close();

  console.log(`Swiggy Food MCP — ${tools.length} tools available to this account:\n`);
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const args = Object.keys(schema.properties ?? {})
      .map((k) => (schema.required?.includes(k) ? `${k}*` : k))
      .join(", ");
    console.log(`- ${tool.name}(${args})`);
    if (tool.description) console.log(`    ${tool.description.split("\n")[0].slice(0, 160)}`);
  }

  mkdirSync(new URL("../../out/", import.meta.url).pathname, { recursive: true });
  const outFile = new URL("../../out/tools.json", import.meta.url).pathname;
  writeFileSync(outFile, JSON.stringify(tools, null, 2));
  console.log(`\nFull schemas written to out/tools.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
