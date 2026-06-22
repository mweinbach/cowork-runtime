import path from "node:path";
import { pathToFileURL } from "node:url";

const nodeModulesPath = process.env.COWORK_RUNTIME_NODE_MODULES;
const runtimeParentURLs = nodeModulesPath
  ? [nodeModulesPath, path.join(nodeModulesPath, ".pnpm", "node_modules")].map(
      (candidate) => pathToFileURL(path.join(candidate, ".cowork-runtime-entry.mjs")).href,
    )
  : [];

function isBareSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !specifier.includes(":")
  );
}

export async function resolve(specifier, context, nextResolve) {
  if (runtimeParentURLs.length === 0 || !isBareSpecifier(specifier)) {
    return nextResolve(specifier, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    for (const parentURL of runtimeParentURLs) {
      try {
        return await nextResolve(specifier, { ...context, parentURL });
      } catch {
        // Keep trying the complete pnpm-hoisted closure.
      }
    }
    throw error;
  }
}
