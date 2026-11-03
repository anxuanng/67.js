// Compares measured bundle sizes with their budgets. measure-size.mjs and its test share this file.
const BUDGET_MARGIN = 0.02;
const BUDGET_ROUNDING = 100;

export function budgetFor(gzipBytes) {
  return Math.ceil((gzipBytes * (1 + BUDGET_MARGIN)) / BUDGET_ROUNDING) * BUDGET_ROUNDING;
}

export function budgetsFrom(measured) {
  return Object.fromEntries(Object.entries(measured).map(([name, size]) => [name, budgetFor(size.gzip)]));
}

// Returns one row per measured bundle, and a problem for each bundle that breaks a rule.
export function compareToBudgets(measured, budgets, baseline = {}) {
  const rows = [];
  const problems = [];
  for (const [name, size] of Object.entries(measured)) {
    const budget = budgets[name];
    const previous = baseline[name]?.gzip;
    const change = previous === undefined ? null : size.gzip - previous;
    rows.push({ name, min: size.min, gzip: size.gzip, budget: budget ?? null, change });
    if (budget === undefined) {
      problems.push(`${name} has no budget. Add it to bench/size/budgets.json.`);
    } else if (size.gzip > budget) {
      problems.push(`${name} is ${size.gzip} bytes gzip, over its budget of ${budget} by ${size.gzip - budget}. Reduce it, or raise the budget in bench/size/budgets.json and say why in the pull request.`);
    }
  }
  for (const name of Object.keys(budgets)) {
    if (!(name in measured)) problems.push(`${name} has a budget and no bundle. Remove it from bench/size/budgets.json.`);
  }
  return { rows, problems };
}

export function signedBytes(change) {
  if (change === null) return 'new';
  return change > 0 ? `+${change}` : String(change);
}

export function formatRows(rows) {
  const header = `${'bundle'.padEnd(30)}${'min'.padStart(10)}${'gzip'.padStart(10)}${'budget'.padStart(10)}${'change'.padStart(10)}`;
  const lines = rows.map(row => [
    row.name.padEnd(30), String(row.min).padStart(10), String(row.gzip).padStart(10),
    String(row.budget ?? '-').padStart(10), signedBytes(row.change).padStart(10),
  ].join(''));
  return [header, ...lines].join('\n');
}

// esbuild marks every dynamically imported module as an entry point too, so the first output with an entryPoint can be
// a lazy chunk. The bundle a page starts with is the one built from the stdin entry.
const STDIN_ENTRY = '<stdin>';

// Returns the output paths a page loads at start: the entry chunk and every chunk it reaches by static import.
export function initialOutputPaths(metafile) {
  const entryPath = Object.keys(metafile.outputs).find(path => metafile.outputs[path].entryPoint === STDIN_ENTRY);
  if (!entryPath) throw new Error('The size measure found no stdin entry in the esbuild metafile.');
  const reached = new Set();
  const pending = [entryPath];
  while (pending.length) {
    const path = pending.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    for (const imported of metafile.outputs[path].imports) {
      if (imported.kind === 'import-statement') pending.push(imported.path);
    }
  }
  return reached;
}
