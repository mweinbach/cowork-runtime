import path from "node:path";
import { pathToFileURL } from "node:url";

const nodeModulesPath = process.env.COWORK_RUNTIME_NODE_MODULES;
const runtimeParentURL = nodeModulesPath
  ? pathToFileURL(path.join(nodeModulesPath, ".cowork-runtime-entry.mjs")).href
  : null;

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
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!runtimeParentURL || !isBareSpecifier(specifier)) throw error;

    try {
      return await nextResolve(specifier, { ...context, parentURL: runtimeParentURL });
    } catch {
      throw error;
    }
  }
}

