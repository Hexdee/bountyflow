export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

export function badgeName(level: number): string {
  if (level >= 3) return "Master Builder";
  if (level === 2) return "Orange Builder";
  if (level === 1) return "Yellow Builder";
  return "Unranked";
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}
