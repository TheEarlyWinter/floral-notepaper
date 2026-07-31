import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "../src/generated/contributors.json");

function writeContributors(contributors) {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(contributors, null, 2) + "\n");
}

// 本仓库（fork 维护者）优先，其次上游贡献者，按 login 去重合并。
const REPOS = ["TheEarlyWinter/floral-notepaper", "Achilng/floral-notepaper"];

async function fetchRepoContributors(repo) {
  const API_URL = `https://api.github.com/repos/${repo}/contributors?per_page=100`;
  const headers = { "User-Agent": "floral-notepaper-build" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(API_URL, { headers });
  if (!res.ok) {
    throw new Error(`${repo}: GitHub API responded ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  return data
    .filter((u) => u.type !== "Bot")
    .map((u) => ({
      login: u.login,
      avatar_url: u.avatar_url,
      html_url: u.html_url,
    }));
}

async function fetchContributors() {
  const seen = new Set();
  const merged = [];
  for (const repo of REPOS) {
    const contributors = await fetchRepoContributors(repo);
    for (const contributor of contributors) {
      if (seen.has(contributor.login)) continue;
      seen.add(contributor.login);
      merged.push(contributor);
    }
  }
  return merged;
}

try {
  const contributors = await fetchContributors();
  writeContributors(contributors);
  console.log(`[contributors] wrote ${contributors.length} contributors`);
} catch (err) {
  if (existsSync(OUTPUT)) {
    const cached = JSON.parse(readFileSync(OUTPUT, "utf-8"));
    console.warn(
      `[contributors] API failed (${err.message}), keeping cached ${cached.length} contributors`,
    );
  } else {
    writeContributors([]);
    console.warn(`[contributors] API failed (${err.message}), wrote empty fallback`);
  }
}
