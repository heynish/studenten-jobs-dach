#!/usr/bin/env node
// Filtered view of the DACH early-career job list.
//
// DRY BY DESIGN: this repo does NOT scrape anything. It consumes the parent
// dataset (github.com/heynish/werkstudent-praktikum-jobs -> jobs.json), which is
// itself built from public ATS APIs + Arbeitsagentur + Adzuna, filters it to this
// repo's niche (see niche.json), then renders README.md + jobs.json at repo root.
//
// Zero dependencies (Node 18+ global fetch). Run: node build.mjs
// The daily GitHub Action runs 30min after the parent so upstream is fresh.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const UPSTREAM =
  "https://raw.githubusercontent.com/heynish/werkstudent-praktikum-jobs/main/jobs.json";

// Careerkit attribution/redirect endpoint (same one the parent uses). Each repo
// passes its own ?src so /api/apply can credit this specific list on install.
const APPLY_BASE = "https://careerkit.me/api/apply";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---- niche filter engine ---------------------------------------------------
// niche.json is declarative (JSON can't hold functions). Supported keys:
//   types:      [..]   role.type must be one of these
//   titleAny:   "regex" role.title must match
//   titleNot:   "regex" role.title must NOT match
//   englishOnly: true   keep only English-language titles (expat audience)

const STRONG_DE =
  /werkstudent|praktik|absolvent|mitarbeiter|kaufmann|kauffrau|berater|entwickler|vertrieb|referent|fachkraft|ausbild|auszubild|ingenieur|steuerfach|pflege|erzieh|verkäufer|verkaeufer|buchhalt|einkäufer|leiter\b|kraft\b|helfer|meister\b|gutachter|zahlungsverkehr|banksteuerung|bauleitung|immobilien|betriebswirt|\bdein\b|\bfür\b|\bund\b|\bim\b|\bbereich\b|einstieg/i;
const EN_TOKEN =
  /\b(intern|internship|working student|graduate|trainee|junior|senior|engineer|developer|manager|analyst|specialist|scientist|designer|consultant|lead|associate|marketing|sales|product|business|operations|finance|people|talent|success|growth|partnerships|account|customer|data|software|devops|cloud|security|content|research|strategy|recruiter|writer|copywriter|coordinator)\b/i;

// German-language postings carry a "weiblich" gender marker: (m/w/d), (w/m/d),
// (m/w/x)... i.e. an "m/w" or "w/m" pair. English/international ones use "f"
// ((m/f/d), (x/f/m)). Presence of the m/w pair means the listing itself is German.
const DE_GENDER = /\bm\s*\/\s*w\b|\bw\s*\/\s*m\b/i;

function isEnglishTitle(title) {
  if (/[äöüß]/.test(title)) return false; // umlaut => German
  if (STRONG_DE.test(title)) return false; // strong German job noun
  if (DE_GENDER.test(title)) return false; // German weiblich gender marker
  return EN_TOKEN.test(title); // has a recognisable English job token
}

function makeFilter(niche) {
  const types = niche.types ? new Set(niche.types) : null;
  const any = niche.titleAny ? new RegExp(niche.titleAny, "i") : null;
  const not = niche.titleNot ? new RegExp(niche.titleNot, "i") : null;
  return (r) => {
    if (types && !types.has(r.type)) return false;
    if (any && !any.test(r.title)) return false;
    if (not && not.test(r.title)) return false;
    if (niche.englishOnly && !isEnglishTitle(r.title)) return false;
    return true;
  };
}

const trackedApplyUrl = (r, src) =>
  `${APPLY_BASE}?${new URLSearchParams({ src, company: slug(r.company), url: r.raw_url || "" })}`;

const tally = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});

// ---- pipeline --------------------------------------------------------------

async function run() {
  const niche = JSON.parse(await readFile(join(DIR, "niche.json"), "utf8"));
  const res = await fetch(UPSTREAM, { headers: { "user-agent": `${niche.id}/1.0` } });
  if (!res.ok) throw new Error(`upstream ${res.status} ${UPSTREAM}`);
  const upstream = await res.json();

  const keep = makeFilter(niche);
  const roles = (upstream.roles || [])
    .filter(keep)
    .map((r) => ({ ...r, careerkit_apply_url: trackedApplyUrl(r, niche.id) }));

  roles.sort(
    (a, b) => a.city.localeCompare(b.city) || a.type.localeCompare(b.type) || a.company.localeCompare(b.company),
  );

  const generatedAt = new Date().toISOString();
  await writeFile(
    join(DIR, "jobs.json"),
    JSON.stringify(
      {
        generated_at: generatedAt,
        count: roles.length,
        niche: niche.id,
        source: "filtered view of heynish/werkstudent-praktikum-jobs (public ATS APIs + Arbeitsagentur + Adzuna)",
        upstream_generated_at: upstream.generated_at || null,
        roles,
      },
      null,
      2,
    ),
  );
  await writeFile(join(DIR, "README.md"), renderReadme(roles, niche, generatedAt, upstream));

  console.log(`[${niche.id}] roles: ${roles.length}  (from upstream ${upstream.count})`);
  console.log("by city:", tally(roles, "city"));
  console.log("by type:", tally(roles, "type"));
}

// ---- render ----------------------------------------------------------------

const escapePipe = (s) => String(s).replace(/\|/g, "\\|");

function renderReadme(roles, niche, generatedAt, upstream) {
  const date = generatedAt.slice(0, 10);
  const byCity = tally(roles, "city");
  const cityOrder = [...new Set(roles.map((r) => r.city))].sort((a, b) => byCity[b] - byCity[a]);
  const companies = new Set(roles.map((r) => r.company));

  const L = [];
  L.push(`# ${niche.title}`);
  L.push("");
  L.push(`> ${niche.tagline_de}`);
  L.push(`> ${niche.tagline_en}`);
  L.push("");
  L.push(`**${roles.length} ${niche.count_label_de}** · **${companies.size} ${niche.employer_label_de}** · ${niche.updated_label_de} **${date}**`);
  L.push("");
  L.push(`## ${niche.cta_heading}`);
  L.push(`${niche.cta_body} [**${niche.cta_link_text} →**](${niche.cta_url})`);
  L.push("");
  L.push(`⭐ ${niche.star_line}`);
  L.push("");
  if (niche.types_line) {
    L.push(`_${niche.types_line}_`);
    L.push("");
  }

  for (const city of cityOrder) {
    const rows = roles.filter((r) => r.city === city);
    L.push(`## ${city} (${rows.length})`);
    L.push("");
    L.push(`| ${niche.col_role} | ${niche.col_company} | ${niche.col_type} | ${niche.col_posted} | |`);
    L.push(`|---|---|---|---|---|`);
    for (const r of rows) {
      const age =
        r.posted_days_ago == null
          ? ""
          : r.posted_days_ago === 0
            ? niche.today_label
            : `${niche.ago_prefix}${r.posted_days_ago}${niche.ago_suffix}`;
      L.push(
        `| [${escapePipe(r.title)}](${r.raw_url}) | ${escapePipe(r.company)} | ${r.type} | ${age} | [${niche.apply_label}](${r.careerkit_apply_url}) |`,
      );
    }
    L.push("");
  }

  L.push(`---`);
  L.push(`<sub>${niche.footer} Powered by [Careerkit](${niche.cta_url}). Auto-updated daily from the [DACH early-career job list](https://github.com/heynish/werkstudent-praktikum-jobs) (public ATS APIs + Arbeitsagentur + Adzuna). Upstream snapshot: ${(upstream.generated_at || "").slice(0, 10)}.</sub>`);
  return L.join("\n") + "\n";
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
