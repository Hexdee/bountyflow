export function shortAddress(value: string) { return value.length < 14 ? value : `${value.slice(0, 5)}…${value.slice(-5)}`; }
export function stellarFromStroops(value: bigint | number) { return (Number(value) / 10_000_000).toFixed(2); }
export function formatError(error: unknown) { const message = error instanceof Error ? error.message : String(error); return message.replace(/^Error:\s*/i, "").replace(/simulation failed:\s*/i, ""); }
