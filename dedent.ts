export function dedent(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  // Combine the strings and interpolated values
  const result = strings.reduce(
    (acc: string, str: string, i: number): string => {
      return acc + str + (values[i] != null ? String(values[i]) : "");
    },
    "",
  );

  // Split into lines and remove empty lines at start/end
  const lines: string[] = result
    .split("\n")
    .filter((line: string, i: number, arr: string[]): boolean => {
      if (i === 0 || i === arr.length - 1) {
        return line.trim().length > 0;
      }
      return true;
    });

  // Find the minimum indentation level
  const minIndent: number = lines
    .filter((line: string): boolean => line.trim().length > 0)
    .reduce((min: number, line: string): number => {
      const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      return indent < min ? indent : min;
    }, Infinity);

  // Remove the minimum indentation from each line
  return lines.map((line: string): string => line.slice(minIndent)).join("\n");
}
