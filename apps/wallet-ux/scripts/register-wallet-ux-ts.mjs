// Resolve extensionless TypeScript imports and JSON imports for the address-book guard.
export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    return nextLoad(url, {
      ...context,
      importAttributes: { ...context.importAttributes, type: "json" },
    })
  }
  return nextLoad(url, context)
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".json")) {
    return nextResolve(specifier, {
      ...context,
      importAttributes: { ...context.importAttributes, type: "json" },
    })
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.(?:ts|tsx|js|mjs|cjs|json|node)$/.test(specifier)
  ) {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
