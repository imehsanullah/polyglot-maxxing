export function normalizeEmbeddedPageData(source: string): string {
  return source
    .replaceAll("\\u0026", "&")
    .replaceAll("\\u003d", "=")
    .replaceAll("\\/", "/")
    .replaceAll('\\"', '"');
}

export function findFirstStringValue(
  value: unknown,
  predicate: (key: string, value: string) => boolean,
): string | undefined {
  const seen = new Set<object>();

  function visit(current: unknown): string | undefined {
    if (!current || typeof current !== "object") return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        const result = visit(item);
        if (result) return result;
      }
      return undefined;
    }

    for (const [key, child] of Object.entries(current)) {
      if (typeof child === "string" && predicate(key, child)) return child;
      const result = visit(child);
      if (result) return result;
    }
    return undefined;
  }

  return visit(value);
}
