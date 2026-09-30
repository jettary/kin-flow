/** Only publish a direct HTTPS Ko-fi profile link from deployment configuration. */
export function kofiUrl(value = process.env.KOFI_URL): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^https:\/\/ko-fi\.com\/[a-z0-9_-]+\/?$/i.test(trimmed)) return null;
  return new URL(trimmed).href;
}
