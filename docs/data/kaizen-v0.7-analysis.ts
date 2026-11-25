// NOTE: the `export` and `decisions` modes read issues from the original private repositories, named by the environment
// variables KAIZEN_INFRA_REPO and KAIZEN_PRODUCT_REPO (owner/name), so only the authors can run them. The `analyze` and
// `states` modes run on the frozen export (kaizen-v0.6-export-2026-11-22.json) alone and reproduce the paper's figures.
// Analysis for "Continuous Improvement in Agent Scrum" v0.7 (sagan; v0.6 body 2026-11-22, v0.7 additions 2026-11-25). Node 22+, `gh` on PATH. Linux.
//   node kaizen-v0.7-analysis.ts states <export.json>      v0.7: P1/P2/P4 split by issue state (from the export alone)
//   node kaizen-v0.7-analysis.ts decisions <export.json>   v0.7: keep/reverse counts among verdicts; reads comment text from the forge (paged), counts verdict comments created at or before the export time
//   node kaizen-v0.7-analysis.ts export <out.json>   reads the forge (paged: gh api --paginate --slurp) and writes a de-identified export
//   node kaizen-v0.7-analysis.ts analyze <export.json>   prints every figure in Section 12.4 from the export alone
// The export keeps no issue text and no issue numbers: ids are sequential, per source. It keeps what the counts use:
// creation/update time, state, label class, whether a line starts `Predicts:`, its `seen:` and `due` fields, and for each
// comment starting `kaizen-eval:` its id, times and verdict word. Body edit history is not available from the API, so
// "has a prediction" is the body as read at extraction time. Same rules as the team's own evaluation counter:
// the last matching comment decides; a matching comment whose verdict word is not held|not-held|unmeasurable is "malformed" (counted evaluated, no verdict).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SINCE = "2026-11-06";
const STEP_LANDED = "2026-11-07T01:40:51Z"; // 2026-11-06 18:40:51 -0700
const SOURCES: [string, string][] = [["infrastructure", process.env.KAIZEN_INFRA_REPO ?? ""], ["product", process.env.KAIZEN_PRODUCT_REPO ?? ""]];
const LABELS = ["from-retro", "customer"];

const gh = (args: string[]): any => {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 512 << 20 });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${r.stderr}`);
  return JSON.parse(r.stdout).flat();
};

function doExport(out: string) {
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const [src, repo] of SOURCES) {
    let n = 0;
    for (const label of LABELS) {
      const items = gh(["api", "--paginate", "--slurp", `repos/${repo}/issues?labels=${label}&state=all&since=${SINCE}T00:00:00Z&per_page=100`]);
      for (const i of items) {
        if (i.pull_request || i.created_at < SINCE || seen.has(`${repo}#${i.number}`)) continue;
        seen.add(`${repo}#${i.number}`);
        const body: string = i.body ?? "";
        const p = /^\s*Predicts:.*$/m.exec(body)?.[0];
        const comments = i.comments === 0 ? [] : gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${i.number}/comments?per_page=100`]);
        rows.push({
          id: `${src}-${String(++n).padStart(4, "0")}`, source: src, label, created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at, state: i.state,
          has_predicts: p !== undefined,
          seen: p ? (/\bseen:\s*(\d+)/.exec(p)?.[1] ?? null) : null,
          due: p ? (/\bdue (\d{4}-\d{2}-\d{2})/.exec(p)?.[1] ?? null) : null,
          evals: comments.filter((c: any) => /^\s*kaizen-eval:/.test(c.body ?? "")).map((c: any) => ({
            comment_id: c.id, created_at: c.created_at, updated_at: c.updated_at,
            verdict: /^\s*kaizen-eval:\s*(not-held|held|unmeasurable)\b/.exec(c.body)?.[1] ?? "malformed",
          })),
        });
      }
    }
  }
  const ex = { extracted_at: new Date().toISOString(), since: SINCE, step_landed: STEP_LANDED, sources: SOURCES.map((s) => s[0]), rows };
  writeFileSync(out, JSON.stringify(ex, null, 1));
  console.log(`wrote ${rows.length} rows to ${out}`);
}

function wilson(k: number, n: number, z = 1.959964): string {
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), a = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return `${(100 * p).toFixed(1)}% (${(100 * (c - a) / d).toFixed(1)} to ${(100 * (c + a) / d).toFixed(1)})`;
}

function verdictAt(r: any, cutoff: string): string | null { // last kaizen-eval comment created at or before cutoff
  const e = r.evals.filter((x: any) => x.created_at <= cutoff).sort((a: any, b: any) => a.created_at.localeCompare(b.created_at)).pop();
  return e ? e.verdict : null;
}

function report(rows: any[], label: string, cutoff: string, dueBy: string) {
  const R = rows.filter((r) => r.label === "from-retro" && r.created_at <= cutoff);
  const P = R.filter((r) => r.has_predicts);
  const due = P.filter((r) => r.due !== null && r.due <= dueBy);
  const ev = due.filter((r) => verdictAt(r, cutoff) !== null);
  const V = P.map((r) => verdictAt(r, cutoff)).filter((v) => v !== null);
  const c = (w: string) => V.filter((v) => v === w).length;
  const dec = c("held") + c("not-held");
  console.log(`\n## ${label}: issues created by ${cutoff}; due dates by ${dueBy}; verdict comments by ${cutoff}`);
  console.log(`retro issues ${R.length}; with prediction ${P.length} = ${wilson(P.length, R.length)}`);
  console.log(`due ${due.length}; of those with a verdict ${ev.length} = ${wilson(ev.length, due.length)}`);
  console.log(`verdicts (all predictions) ${V.length}: held ${c("held")}, not-held ${c("not-held")}, unmeasurable ${c("unmeasurable")}, malformed ${c("malformed")}`);
  if (dec > 0) console.log(`held/decidable ${c("held")}/${dec} = ${wilson(c("held"), dec)}; held/all verdicts ${c("held")}/${V.length} = ${wilson(c("held"), V.length)}; held/due ${c("held")}/${due.length} = ${wilson(c("held"), due.length)}`);
  console.log(`not yet due ${P.length - P.filter((r) => r.due !== null && r.due <= dueBy).length}; verdicts on not-yet-due ${P.filter((r) => !(r.due !== null && r.due <= dueBy) && verdictAt(r, cutoff) !== null).length}`);
}

function analyze(file: string) {
  const ex = JSON.parse(readFileSync(file, "utf8"));
  const rows: any[] = ex.rows;
  console.log(`export ${ex.extracted_at}; ${rows.length} rows; by label ${LABELS.map((l) => `${l}: ${rows.filter((r) => r.label === l).length}`).join(", ")}`);
  console.log(`customer rows with a prediction: ${rows.filter((r) => r.label === "customer" && r.has_predicts).length}`);
  const END = ex.extracted_at;
  report(rows, "A. Reading at extraction, registered cohort (created from 2026-11-06 00:00 UTC)", END, END.slice(0, 10) <= "2026-11-22" ? "2026-11-22" : END.slice(0, 10));
  const P = rows.filter((r) => r.label === "from-retro" && r.has_predicts);
  console.log(`seen: =1 ${P.filter((r) => r.seen === "1").length}, =0 ${P.filter((r) => r.seen === "0").length}, >1 ${P.filter((r) => r.seen !== null && Number(r.seen) > 1).length}, unreadable ${P.filter((r) => r.seen === null).length}`);
  // Planned end: 2026-11-20 23:59 MST = 2026-11-21T06:59:00Z
  report(rows, "B. Planned end (20 Nov 23:59 MST), registered cohort", "2026-11-21T06:59:00Z", "2026-11-20");
  const after = rows.filter((r) => r.created_at >= STEP_LANDED);
  const before = rows.filter((r) => r.created_at < STEP_LANDED);
  report(after, "C. Planned end, cohort created after the step landed", "2026-11-21T06:59:00Z", "2026-11-20");
  report(after, "D. Extraction, cohort created after the step landed", END, "2026-11-22");
  const bp = before.filter((r) => r.label === "from-retro");
  console.log(`\n## E. Created before the step landed (${STEP_LANDED}): retro issues ${bp.length}, with a prediction at extraction ${bp.filter((r) => r.has_predicts).length}`);
  const A = rows.filter((r) => r.label === "from-retro" && r.has_predicts);
  const lead = A.filter((r) => r.due).map((r) => (Date.parse(r.due + "T00:00:00Z") - Date.parse(r.created_at)) / 864e5).sort((a, b) => a - b);
  console.log(`due lead time in days (due date minus creation): min ${lead[0].toFixed(1)}, median ${lead[Math.floor(lead.length / 2)].toFixed(1)}, max ${lead[lead.length - 1].toFixed(1)}`);
  const multi = A.filter((r) => r.evals.length > 1).length;
  console.log(`predictions with more than one kaizen-eval comment: ${multi}; malformed last verdicts: ${A.filter((r) => r.evals.at(-1)?.verdict === "malformed").length}`);
  const lat = A.filter((r) => r.evals.length && r.due).map((r) => (Date.parse(r.evals[0].created_at) - Date.parse(r.due + "T00:00:00Z")) / 864e5).sort((a, b) => a - b);
  console.log(`first verdict minus due date, days: min ${lat[0].toFixed(1)}, median ${lat[Math.floor(lat.length / 2)].toFixed(1)}, max ${lat[lat.length - 1].toFixed(1)} (n=${lat.length})`);
}

// v0.7: P1, P2 and P4 split by issue state at extraction (open or closed). Export only.
function states(file: string) {
  const ex = JSON.parse(readFileSync(file, "utf8"));
  const END: string = ex.extracted_at;
  const R: any[] = ex.rows.filter((r: any) => r.label === "from-retro");
  for (const st of ["open", "closed"]) {
    const S = R.filter((r) => r.state === st), P = S.filter((r) => r.has_predicts);
    const due = P.filter((r) => r.due !== null && r.due <= "2026-11-22");
    const V = P.map((r) => verdictAt(r, END)).filter((v) => v !== null);
    const c = (w: string) => V.filter((v) => v === w).length;
    console.log(`\n## ${st}: retro issues ${S.length}; with prediction ${P.length} = ${wilson(P.length, S.length)}`);
    console.log(`due ${due.length}; with a verdict ${due.filter((r) => verdictAt(r, END) !== null).length} = ${due.length ? wilson(due.filter((r) => verdictAt(r, END) !== null).length, due.length) : "n/a"}`);
    console.log(`verdicts ${V.length}: held ${c("held")}, not-held ${c("not-held")}, unmeasurable ${c("unmeasurable")}; held/decidable ${c("held")}/${c("held") + c("not-held")}${c("held") + c("not-held") ? " = " + wilson(c("held"), c("held") + c("not-held")) : ""}`);
  }
}

// v0.7: keep or reverse (loop step 7) among the verdicts. The export holds no comment text, so this reads the comments again.
// Rule: for each issue the last comment starting `kaizen-eval:` created at or before the export time decides; the decision word is
// the last of keep|reverse after the verdict word on that comment's first line. Issues are matched to export rows by repo and
// creation time (the export keeps no issue numbers).
function decisions(file: string) {
  const ex = JSON.parse(readFileSync(file, "utf8"));
  const END: string = ex.extracted_at;
  const key = (src: string, t: string) => `${src}|${t}`;
  const exRows = new Map<string, any>(ex.rows.filter((r: any) => r.label === "from-retro").map((r: any) => [key(r.source, r.created_at), r]));
  const tally: Record<string, Record<string, number>> = {};
  const unmatched: string[] = [];
  let seenIssues = 0, withEval = 0;
  for (const [src, repo] of SOURCES) {
    const items = gh(["api", "--paginate", "--slurp", `repos/${repo}/issues?labels=from-retro&state=all&since=${SINCE}T00:00:00Z&per_page=100`]);
    for (const i of items) {
      if (i.pull_request || i.created_at < SINCE || i.created_at > END) continue;
      seenIssues++;
      if (i.comments === 0) continue;
      const row = exRows.get(key(src, i.created_at));
      if (!row) { unmatched.push(`${src}#${i.number}`); continue; }
      const cs = gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${i.number}/comments?per_page=100`])
        .filter((c: any) => /^\s*kaizen-eval:/.test(c.body ?? "") && c.created_at <= END)
        .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at));
      const last = cs.at(-1);
      if (!last) continue;
      withEval++;
      const line = (last.body as string).split("\n")[0];
      const verdict = /^\s*kaizen-eval:\s*(not-held|held|unmeasurable)\b/.exec(line)?.[1] ?? "malformed";
      const rest = line.replace(/^\s*kaizen-eval:\s*(not-held|held|unmeasurable)\b/, "");
      const dec = [...rest.matchAll(/\b(keep|reverse)\b/gi)].map((m) => m[1].toLowerCase()).at(-1) ?? "none";
      (tally[verdict] ??= {})[dec] = (tally[verdict][dec] ?? 0) + 1;
      (tally[`${verdict}|${row.state}`] ??= {})[dec] = (tally[`${verdict}|${row.state}`][dec] ?? 0) + 1;
    }
  }
  console.log(`retro issues read ${seenIssues}; with a verdict comment at or before ${END}: ${withEval}; unmatched to the export: ${unmatched.length}`);
  for (const k of Object.keys(tally).sort()) console.log(k.padEnd(28), JSON.stringify(tally[k]));
  const keep = Object.entries(tally).filter(([k]) => !k.includes("|")).reduce((a, [, v]) => a + (v.keep ?? 0), 0);
  console.log(`keep ${keep} of ${withEval} = ${wilson(keep, withEval)}; reverse ${Object.entries(tally).filter(([k]) => !k.includes("|")).reduce((a, [, v]) => a + (v.reverse ?? 0), 0)}`);
}

const [mode, file] = process.argv.slice(2);
if (mode === "states" && file) states(file); else if (mode === "decisions" && file) decisions(file);
else if (mode === "export" && file) doExport(file); else if (mode === "analyze" && file) analyze(file);
else { console.error("usage: node kaizen-v0.7-analysis.ts export|analyze|states|decisions <file>"); process.exit(2); }
