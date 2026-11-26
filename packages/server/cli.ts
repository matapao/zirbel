// Entry point for dist/server.mjs. The headless host loads only the player code, and the pre-receive hook git runs
// for a push only its check; everything else loads the full editor (harnesses and MCP).
const args = process.argv.slice(2);
if (args[0] === 'git-hook') await import('./git-hook.ts');
else if (args.includes('--host-only') && !args.includes('--help')) await import('./host.ts');
else await (await import('./main.ts')).main();
