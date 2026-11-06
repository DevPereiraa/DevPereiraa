// Gera assets/stats.svg e assets/langs.svg com dados do GitHub (incluindo repos privados).
// Requer Node 18+ (fetch nativo). Sem dependências.
import { mkdirSync, writeFileSync } from "node:fs";

const USERNAME = process.env.GH_USERNAME || "DevPereiraa";
const TOKEN = process.env.GH_STATS_TOKEN;
const MOCK = process.env.MOCK === "1";
const OUT = "assets";

// ===== PERSONALIZAÇÃO (use null para voltar aos dados reais) =====
const OVERRIDE = {
  rank: "B", // S, A++, A+, A, B+, B, C  |  null = calculado de verdade
    langs: [    // [nome, porcentagem, cor]  |  null = linguagens reais
    ["TypeScript", 31.46, "#3178c6"],
    ["Rust", 21.83, "#dea584"],
    ["Go", 17.39, "#00ADD8"],
    ["Swift", 14.71, "#F05138"],
    ["Python", 9.12, "#3572A5"],
    ["C++", 5.49, "#f1e05a"],
  ],
};
// =================================================================

const THEME = {
  bg: "#1a1b27",
  border: "#e4e2e2",
  title: "#70a5fd",
  text: "#38bdae",
  label: "#a9b1d6",
  icon: "#bf91f3",
  ring: "#38bdae",
};

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchData() {
  if (MOCK) {
    return {
      name: "Gustavo Pereira", stars: 12, commits: 413, prs: 4, issues: 0,
      contributedTo: 5, reviews: 2, followers: 8,
      langs: [
        ["TypeScript", 28.71, "#3178c6"], ["CSS", 20.99, "#563d7c"],
        ["Python", 15.04, "#3572A5"], ["JavaScript", 12.29, "#f1e05a"],
        ["C#", 11.23, "#178600"], ["HTML", 11.14, "#e34c26"],
        ["Java", 0.53, "#b07219"], ["Shell", 0.06, "#89e051"],
      ],
    };
  }

  // 1) Totais gerais
  const base = await gql(
    `query($login:String!){ user(login:$login){
      name login createdAt
      followers{totalCount}
      pullRequests{totalCount}
      issues{totalCount}
      repositoriesContributedTo(first:1, contributionTypes:[COMMIT,ISSUE,PULL_REQUEST,REPOSITORY]){totalCount}
    }}`, { login: USERNAME });
  const u = base.user;

  // 2) Commits e reviews de todos os anos (a API limita a 1 ano por consulta)
  const startYear = new Date(u.createdAt).getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  let fields = "";
  for (let y = startYear; y <= nowYear; y++) {
    fields += `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z"){
      totalCommitContributions totalPullRequestReviewContributions }\n`;
  }
  const years = (await gql(`query($login:String!){ user(login:$login){ ${fields} }}`, { login: USERNAME })).user;
  let commits = 0, reviews = 0;
  for (const k of Object.keys(years)) {
    commits += years[k].totalCommitContributions;
    reviews += years[k].totalPullRequestReviewContributions;
  }

  // 3) Repositórios (públicos + privados que o token enxerga): estrelas e linguagens
  let stars = 0, after = null;
  const langMap = new Map();
  do {
    const d = await gql(
      `query($login:String!,$after:String){ user(login:$login){
        repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false){
          pageInfo{hasNextPage endCursor}
          nodes{ stargazerCount languages(first:10, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{name color} } } }
        }}}`, { login: USERNAME, after });
    const r = d.user.repositories;
    for (const repo of r.nodes) {
      stars += repo.stargazerCount;
      for (const e of repo.languages.edges) {
        const cur = langMap.get(e.node.name) || { size: 0, color: e.node.color || "#8b949e" };
        cur.size += e.size;
        langMap.set(e.node.name, cur);
      }
    }
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);

  const total = [...langMap.values()].reduce((a, b) => a + b.size, 0) || 1;
  const langs = [...langMap.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8)
    .map(([n, v]) => [n, (v.size / total) * 100, v.color]);

  return {
    name: u.name || u.login, stars, commits, prs: u.pullRequests.totalCount,
    issues: u.issues.totalCount, contributedTo: u.repositoriesContributedTo.totalCount,
    reviews, followers: u.followers.totalCount, langs,
  };
}

// Rank baseado na fórmula do github-readme-stats
function calcRank({ commits, prs, issues, reviews, stars, followers }) {
  const exp = (x) => 1 - 2 ** -x;
  const logn = (x) => x / (1 + x);
  const W = { commits: 2, prs: 3, issues: 1, reviews: 1, stars: 4, followers: 1 };
  const total = Object.values(W).reduce((a, b) => a + b, 0);
  const score =
    W.commits * exp(commits / 250) + W.prs * exp(prs / 50) + W.issues * exp(issues / 25) +
    W.reviews * exp(reviews / 2) + W.stars * logn(stars / 50) + W.followers * logn(followers / 10);
  const percentile = (1 - score / total) * 100;
  const levels = [[1, "S"], [5, "A++"], [12.5, "A+"], [25, "A"], [37.5, "B+"], [62.5, "B"], [100, "C"]];
  const level = levels.find(([t]) => percentile <= t)[1];
  return { level, progress: Math.max(0.05, (100 - percentile) / 100) };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
const FONT = "font-family:'Segoe UI',Ubuntu,'Helvetica Neue',sans-serif";

const ICONS = {
  stars: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  commits: "M1.643 3.143.427 1.927A.25.25 0 0 0 0 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 0 0 .177-.427L2.715 4.215a6.5 6.5 0 1 1-1.18 4.458.75.75 0 1 0-1.493.154 8.001 8.001 0 1 0 1.6-5.684ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z",
  prs: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z",
  issues: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  contrib: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
};

function statsSvg(d) {
  const rank = calcRank(d);
  if (OVERRIDE.rank) {
    const P = { S: 0.97, "A++": 0.92, "A+": 0.85, A: 0.75, "B+": 0.62, B: 0.5, C: 0.3 };
    rank.level = OVERRIDE.rank;
    rank.progress = P[OVERRIDE.rank] ?? rank.progress;
  }
  const rows = [
    ["stars", "Total Stars:", fmt(d.stars)], ["commits", "Total Commits:", fmt(d.commits)],
    ["prs", "Total PRs:", fmt(d.prs)], ["issues", "Total Issues:", fmt(d.issues)],
    ["contrib", "Contributed to:", fmt(d.contributedTo)],
  ];
  const r = 40, C = 2 * Math.PI * r, off = C * (1 - rank.progress);
  const list = rows.map(([ic, label, val], i) => `
    <g transform="translate(25, ${62 + i * 25})">
      <svg viewBox="0 0 16 16" width="16" height="16"><path fill="${THEME.icon}" fill-rule="evenodd" d="${ICONS[ic]}"/></svg>
      <text x="28" y="12" style="${FONT};font-size:14px;font-weight:600;fill:${THEME.label}">${label}</text>
      <text x="170" y="12" style="${FONT};font-size:14px;font-weight:700;fill:${THEME.text}">${val}</text>
    </g>`).join("");
  return `<svg width="495" height="195" viewBox="0 0 495 195" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" rx="6" width="494" height="194" fill="${THEME.bg}" stroke="${THEME.border}" stroke-opacity="0.4"/>
  <text x="25" y="35" style="${FONT};font-size:18px;font-weight:600;fill:${THEME.title}">${esc(d.name)}'s GitHub Stats</text>
  ${list}
  <g transform="translate(400, 112)">
    <circle r="${r}" fill="none" stroke="${THEME.ring}" stroke-opacity="0.2" stroke-width="6"/>
    <circle r="${r}" fill="none" stroke="${THEME.ring}" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90)"/>
    <text text-anchor="middle" dominant-baseline="central" style="${FONT};font-size:26px;font-weight:800;fill:${THEME.title}">${rank.level}</text>
  </g>
</svg>`;
}

function langsSvg(d) {
  const W = 495, barX = 25, barW = W - 50;
  let x = barX;
  const total = d.langs.reduce((a, l) => a + l[1], 0) || 1;
  const bar = d.langs.map(([, pct, color]) => {
    const w = (pct / total) * barW;
    const seg = `<rect x="${x.toFixed(2)}" y="58" width="${w.toFixed(2)}" height="8" fill="${color}"/>`;
    x += w;
    return seg;
  }).join("");
  const legend = d.langs.map(([name, pct, color], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    return `<g transform="translate(${25 + col * 220}, ${92 + row * 25})">
      <circle cx="6" cy="6" r="5" fill="${color}"/>
      <text x="20" y="11" style="${FONT};font-size:13px;fill:${THEME.label}">${esc(name)} ${pct.toFixed(2)}%</text></g>`;
  }).join("");
  return `<svg width="${W}" height="195" viewBox="0 0 ${W} 195" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" rx="6" width="${W - 1}" height="194" fill="${THEME.bg}" stroke="${THEME.border}" stroke-opacity="0.4"/>
  <text x="25" y="35" style="${FONT};font-size:18px;font-weight:600;fill:${THEME.title}">Most Used Languages</text>
  <clipPath id="c"><rect x="${barX}" y="58" width="${barW}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#c)">${bar}</g>
  ${legend}
</svg>`;
}

if (!MOCK && !TOKEN) {
  console.error("Defina a variável GH_STATS_TOKEN (Personal Access Token com escopos repo e read:user).");
  process.exit(1);
}
const data = await fetchData();
if (OVERRIDE.langs) data.langs = OVERRIDE.langs;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/stats.svg`, statsSvg(data));
writeFileSync(`${OUT}/langs.svg`, langsSvg(data));
console.log("OK:", { commits: data.commits, stars: data.stars, langs: data.langs.length });
