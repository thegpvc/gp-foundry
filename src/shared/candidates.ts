/**
 * Which open pull requests a sweep looks at, and in what order — for the gate's
 * scheduled pass and the approver's select job alike.
 *
 * Both used to list every open PR and walk it oldest first, reading each head.
 * In a busy repo most open PRs have nothing either sweep can act on: the gate
 * publishes a result only once the approver has given a verdict, and an
 * approver with requires_review acts only on heads the reviewer has reviewed.
 * Both depend on a review by the harness bot. So candidates come from ONE
 * search for open PRs the bot has reviewed, which returns the head SHA, base,
 * author, labels and pending review requests in the same call.
 *
 * Search narrows; it never decides. Every head is still judged on live state
 * by the caller. If the search fails, the sweep has a quiet tick instead of
 * falling back to walking every open PR, which is what used to time out.
 *
 * Pure apart from the injected graphql function: both actions bundle it.
 */

export interface Candidate {
  number: number;
  sha: string;
  base: string;
  author: string;
  /** GitHub's typename for the author ("User", "Bot", …). */
  authorType: string;
  draft: boolean;
  labels: string[];
  /** Pending review requests (people and teams). */
  requested: number;
  /** When the PR last changed (ms). */
  updatedAt: number;
}

export type GraphqlFn = <T>(query: string, vars: Record<string, unknown>) => Promise<T>;

const SEARCH = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number headRefOid baseRefName isDraft updatedAt
        author { __typename login }
        labels(first: 50) { nodes { name } }
        reviewRequests { totalCount }
      }
    }
  }
}`;

interface SearchPage {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ({
      number?: number;
      headRefOid?: string;
      baseRefName?: string;
      isDraft?: boolean;
      updatedAt?: string;
      author?: { __typename?: string; login?: string } | null;
      labels?: { nodes: { name: string }[] };
      reviewRequests?: { totalCount: number };
    } | null)[];
  };
}

/** GitHub search returns at most this many results for one query. */
export const SEARCH_RESULT_CAP = 1000;

/**
 * The search qualifier for "reviewed by the harness bot". An App's bot login
 * (`my-app[bot]`) and `app/my-app` are both accepted by search; a PAT's owner
 * is a plain login.
 */
export function reviewedByQualifier(botLogin: string): string {
  return `reviewed-by:${botLogin}`;
}

/**
 * A search qualifier that leaves out PRs carrying `label` — none when there is
 * no label, or one search syntax cannot quote. Narrows only: callers still
 * apply the scope rule to every result.
 */
export function excludeLabelQualifier(label: string | undefined): string[] {
  if (!label || /["\\\r\n]/.test(label)) return [];
  return [`-label:"${label}"`];
}

/**
 * Open PRs into `base` that match `qualifier` (one search per qualifier,
 * results merged). Throws when a search fails, or when one would be truncated
 * by GitHub's 1,000-result cap: an incomplete candidate list is reported, not
 * silently used.
 */
export async function searchCandidates(
  graphql: GraphqlFn,
  o: { owner: string; repo: string; base?: string; qualifiers: string[] },
): Promise<Candidate[]> {
  const byNumber = new Map<number, Candidate>();
  for (const qualifier of o.qualifiers) {
    const q = [`repo:${o.owner}/${o.repo}`, "is:pr", "is:open", ...(o.base ? [`base:${o.base}`] : []), qualifier].join(" ");
    let cursor: string | null = null;
    for (let page = 0; page < SEARCH_RESULT_CAP / 100; page++) {
      const r: SearchPage = await graphql<SearchPage>(SEARCH, { q, cursor });
      if (page === 0 && r.search.issueCount > SEARCH_RESULT_CAP) {
        throw new Error(`the search '${q}' matches ${r.search.issueCount} PRs, more than GitHub returns (${SEARCH_RESULT_CAP})`);
      }
      for (const n of r.search.nodes) {
        if (!n || n.number === undefined || !n.headRefOid) continue;
        // GraphQL names a GitHub App's bot `my-app`; REST, review authors and
        // identity.bot_login all say `my-app[bot]`. Use the REST form throughout.
        const login = n.author?.login ?? "";
        const author = n.author?.__typename === "Bot" && login && !login.endsWith("[bot]") ? `${login}[bot]` : login;
        byNumber.set(n.number, {
          number: n.number,
          sha: n.headRefOid,
          base: n.baseRefName ?? "",
          author,
          authorType: n.author?.__typename ?? "",
          draft: !!n.isDraft,
          labels: (n.labels?.nodes ?? []).map((l) => l.name),
          requested: n.reviewRequests?.totalCount ?? 0,
          updatedAt: Date.parse(n.updatedAt ?? "") || 0,
        });
      }
      if (!r.search.pageInfo.hasNextPage) break;
      cursor = r.search.pageInfo.endCursor;
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Round-robin by author: each author's oldest PR first, then each author's
 * second oldest, and so on, so one author with hundreds of open PRs takes one
 * place per round rather than every place, and nobody's older PRs wait behind
 * their newer ones. Authors are ordered by how long their longest-waiting PR has
 * gone unchanged, so whoever has waited longest goes first in each round. "Oldest"
 * is by the PR's last update — a cheap stand-in for its head's age that needs no
 * extra read.
 */
export function roundRobinByAuthor(cands: Candidate[]): Candidate[] {
  const byAuthor = new Map<string, Candidate[]>();
  for (const c of cands) {
    const key = c.author.toLowerCase();
    if (!byAuthor.has(key)) byAuthor.set(key, []);
    byAuthor.get(key)!.push(c);
  }
  const queues = [...byAuthor.entries()]
    .map(([author, list]) => ({
      author,
      list: [...list].sort((a, b) => a.updatedAt - b.updatedAt || a.number - b.number),
      waited: Math.min(...list.map((c) => c.updatedAt)),
    }))
    .sort((a, b) => a.waited - b.waited || (a.author < b.author ? -1 : 1));
  const out: Candidate[] = [];
  for (let round = 0; out.length < cands.length; round++) {
    for (const q of queues) if (q.list[round]) out.push(q.list[round]!);
  }
  return out;
}

/**
 * A rotating window: `count` items starting at an offset that advances by
 * `count` each run, so successive runs cover the whole list without any stored
 * state. Every item is reached within ⌈length ÷ count⌉ runs.
 */
export function rotatingWindow<T>(items: T[], count: number, run: number): T[] {
  if (items.length <= count) return [...items];
  const start = ((Math.max(0, run) % items.length) * count) % items.length;
  return Array.from({ length: count }, (_, i) => items[(start + i) % items.length]!);
}
