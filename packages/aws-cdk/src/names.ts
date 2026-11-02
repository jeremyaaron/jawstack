export function safeName(value: string): string {
  return value
    .trim()
    .replaceAll(/[^A-Za-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
