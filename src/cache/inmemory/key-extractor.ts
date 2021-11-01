import { invariant } from "../../utilities/globals";

import {
  argumentsObjectFromField,
  DeepMerger,
  isNonEmptyArray,
  isNonNullObject,
} from "../../utilities";

import { hasOwn } from "./helpers";
import {
  KeySpecifier,
  KeyFieldsFunction,
  KeyArgsFunction,
} from "./policies";

export function keyFieldsFnFromSpecifier(
  specifier: KeySpecifier,
): KeyFieldsFunction {
  return (object, context) => {
    const extract: typeof extractKey =
      (from, key) => context.readField(key, from);

    const keyObject = context.keyObject = collectSpecifierPaths(
      specifier,
      schemaKeyPath => {
        let extracted = extractKeyPath(
          context.storeObject,
          schemaKeyPath,
          extract,
        );

        if (
          extracted === void 0 &&
          object !== context.storeObject &&
          hasOwn.call(object, schemaKeyPath[0])
        ) {
          extracted = extractKeyPath(object, schemaKeyPath, extractKey);
        }

        invariant(
          extracted !== void 0,
          `Missing field '${schemaKeyPath.join('.')}' while extracting keyFields from ${
            JSON.stringify(object)
          }`,
        );

        return extracted;
      },
    );

    return `${context.typename}:${JSON.stringify(keyObject)}`;
  };
}

// The keyArgs extraction process is roughly analogous to keyFields extraction,
// but there are no aliases involved, missing fields are tolerated (by merely
// omitting them from the key), and drawing from field.directives or variables
// is allowed (in addition to drawing from the field's arguments object).
// Concretely, these differences mean passing a different key path extractor
// function to collectSpecifierPaths, reusing the shared extractKeyPath helper
// wherever possible.
export function keyArgsFnFromSpecifier(specifier: KeySpecifier): KeyArgsFunction {
  return (args, { field, variables, fieldName }) => {
    const collected = collectSpecifierPaths(specifier, keyPath => {
      const firstKey = keyPath[0];
      const firstChar = firstKey.charAt(0);

      if (firstChar === "@") {
        if (field && isNonEmptyArray(field.directives)) {
          const directiveName = firstKey.slice(1);
          // If the directive appears multiple times, only the first
          // occurrence's arguments will be used. TODO Allow repetition?
          // TODO Cache this work somehow, a la aliasMap?
          const d = field.directives.find(d => d.name.value === directiveName);
          // Fortunately argumentsObjectFromField works for DirectiveNode!
          const directiveArgs = d && argumentsObjectFromField(d, variables);
          // For directives without arguments (d defined, but directiveArgs ===
          // null), the presence or absence of the directive still counts as
          // part of the field key, so we return null in those cases. If no
          // directive with this name was found for this field (d undefined and
          // thus directiveArgs undefined), we return undefined, which causes
          // this value to be omitted from the key object returned by
          // collectSpecifierPaths.
          return directiveArgs && extractKeyPath(
            directiveArgs,
            // If keyPath.length === 1, this code calls extractKeyPath with an
            // empty path, which works because it uses directiveArgs as the
            // extracted value.
            keyPath.slice(1),
          );
        }
        // If the key started with @ but there was no corresponding directive,
        // we want to omit this value from the key object, not fall through to
        // treating @whatever as a normal argument name.
        return;
      }

      if (firstChar === "$") {
        const variableName = firstKey.slice(1);
        if (variables && hasOwn.call(variables, variableName)) {
          const varKeyPath = keyPath.slice(0);
          varKeyPath[0] = variableName;
          return extractKeyPath(variables, varKeyPath);
        }
        // If the key started with $ but there was no corresponding variable, we
        // want to omit this value from the key object, not fall through to
        // treating $whatever as a normal argument name.
        return;
      }

      if (args) {
        return extractKeyPath(args, keyPath);
      }
    });

    const suffix = JSON.stringify(collected);

    // If no arguments were passed to this field, and it didn't have any other
    // field key contributions from directives or variables, hide the empty
    // :{} suffix from the field key. However, a field passed no arguments can
    // still end up with a non-empty :{...} suffix if its key configuration
    // refers to directives or variables.
    if (args || suffix !== "{}") {
      fieldName += ":" + suffix;
    }

    return fieldName;
  };
}

export function collectSpecifierPaths(
  specifier: KeySpecifier,
  extractor: (path: string[]) => any,
) {
  // For each path specified by specifier, invoke the extractor, and repeatedly
  // merge the results together, with appropriate ancestor context.
  const merger = new DeepMerger;
  return getSpecifierPaths(specifier).reduce((collected, path) => {
    let toMerge = extractor(path);
    if (toMerge !== void 0) {
      // This path is not expected to contain array indexes, so the toMerge
      // reconstruction will not contain arrays. TODO Fix this?
      for (let i = path.length - 1; i >= 0; --i) {
        toMerge = { [path[i]]: toMerge };
      }
      collected = merger.merge(collected, toMerge);
    }
    return collected;
  }, Object.create(null));
}

export function getSpecifierPaths(spec: KeySpecifier & {
  paths?: string[][];
}): string[][] {
  if (!spec.paths) {
    const paths: string[][] = spec.paths = [];
    const currentPath: string[] = [];

    spec.forEach((s, i) => {
      if (Array.isArray(s)) {
        getSpecifierPaths(s).forEach(p => paths.push(currentPath.concat(p)));
        currentPath.length = 0;
      } else {
        currentPath.push(s);
        if (!Array.isArray(spec[i + 1])) {
          paths.push(currentPath.slice(0));
          currentPath.length = 0;
        }
      }
    });
  }

  return spec.paths!;
}

export function extractKeyPath(
  object: Record<string, any>,
  path: string[],
  extract?: typeof extractKey,
): any {
  return (function normalize<T>(value: T): T {
    // Usually the extracted value will be a scalar value, since most primary
    // key fields are scalar, but just in case we get an object or an array, we
    // need to do some normalization of the order of (nested) keys.
    if (isNonNullObject(value)) {
      if (Array.isArray(value)) {
        return value.map(normalize) as any;
      }
      return collectSpecifierPaths(
        Object.keys(value).sort(),
        path => extractKeyPath(value, path),
      );
    }
    return value;
  })(
    path.reduce(extract || extractKey, object)
  );
}

function extractKey(
  object: Record<string, any>,
  key: string,
): any {
  return Array.isArray(object)
    ? object.map(child => extractKey(child, key))
    : object[key];
}
