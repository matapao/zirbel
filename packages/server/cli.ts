// Entry point for dist/server.mjs. The headless host loads only the player code;
// everything else loads the full editor (harnesses and MCP).
const args = process.argv.slice(2);
if (args.includes('--host-only') && !args.includes('--help')) await import('./host.ts');
else await import('./main.ts');
