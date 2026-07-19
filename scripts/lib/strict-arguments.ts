export type StrictArgumentOptions = {
  allowed: ReadonlySet<string>;
  required?: ReadonlySet<string>;
  positionalName?: string;
};

export function parseStrictArguments(
  argv: readonly string[],
  options: StrictArgumentOptions,
): Map<string, string> {
  const parsed = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith("--")) {
      if (!options.positionalName || parsed.has(options.positionalName)) {
        throw new Error("Unsupported positional argument.");
      }
      parsed.set(options.positionalName, raw);
      continue;
    }

    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    if (!options.allowed.has(name)) {
      throw new Error(`Unsupported argument ${name}.`);
    }
    if (parsed.has(name)) {
      throw new Error(`Argument ${name} was provided more than once.`);
    }

    const value = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument ${name} is missing its value.`);
    }
    parsed.set(name, value);
  }

  for (const name of options.required ?? []) {
    if (!parsed.has(name)) {
      throw new Error(`Argument ${name} is required.`);
    }
  }

  return parsed;
}
