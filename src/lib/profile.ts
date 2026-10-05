export function getDisplayNameError(value: string): string | null {
  const normalized = value.trim();

  if (!normalized) {
    return "Enter a display name.";
  }

  if (normalized.length > 80) {
    return "Display names must be 80 characters or fewer.";
  }

  return null;
}
