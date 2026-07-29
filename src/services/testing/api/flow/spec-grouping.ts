// Group / narrow a parsed API spec so a very large Swagger doesn't have to be
// analyzed as one giant flow. When a spec exceeds LARGE_SPEC_ENDPOINT_THRESHOLD
// the flow builder offers these groups instead of hard-rejecting; the user picks
// one (frontend re-parses the SAME source with `apiGroup` set) and only that
// group's endpoints go through the resolver.
//
// Grouping is deterministic and derived from the spec alone, so the group keys
// shown to the user and the filter applied on re-parse always agree without any
// mode having to be round-tripped through the client.
//
// A chosen group that is STILL too large can be split again: `subgroupForSelection`
// offers compound `parent ▸ child` keys, and `filterSpecByGroup` parses them by
// filtering left-to-right. This keeps the "bound the work" guarantee even when one
// tag (or one path prefix) holds hundreds of endpoints.

import type { ParsedApiSpec, ParsedEndpoint, UnsupportedEndpoint } from './flow.types';

// Above this many supported endpoints, a single flow's dependency analysis
// degrades (Analyst output truncation, minutes-long enrichment, low-signal DAG).
// Kept as the same number the old hard guard used.
export const LARGE_SPEC_ENDPOINT_THRESHOLD = 300;

export interface ApiGroupChoice {
  name: string; // tag / path-segment key (possibly compound) — also the `apiGroup` filter value
  endpointCount: number;
}

type GroupMode = 'tag' | 'path';

const UNTAGGED = '(untagged)';
// Separates a parent group from a sub-group in a compound key. Chosen to be
// vanishingly unlikely inside a real tag or URL path segment.
const SUBGROUP_SEP = ' ▸ ';
// Cap how deep path grouping will descend when breaking up an oversized bucket.
const MAX_PATH_DEPTH = 5;

function primaryTag(ep: Pick<ParsedEndpoint, 'tags'>): string | null {
  const t = ep.tags?.[0]?.trim();
  return t ? t : null;
}

// "Meaningful" path segments: drop a leading `api` base, version segments
// (`v1`, `v2`…) and `{param}` placeholders, so `/api/v1/users/{id}` → [users].
function meaningfulSegments(path: string): string[] {
  return (path || '')
    .split('/')
    .filter(Boolean)
    .filter(s => !/^\{.*\}$/.test(s) && !/^v\d+$/i.test(s) && s.toLowerCase() !== 'api');
}

// Path key from the first `depth` meaningful segments joined — `/api/v1/users/x`
// → depth1 `users`, depth2 `users/x`. Falls back to the raw first segment when a
// path has no meaningful segments (e.g. `/` or `/api/v1`).
function pathKeyAtDepth(path: string, depth: number): string {
  const segs = meaningfulSegments(path);
  if (segs.length === 0) return (path || '/').split('/').filter(Boolean)[0] || '/';
  return segs.slice(0, Math.max(1, depth)).join('/');
}

// Pick the shallowest path depth that keeps every bucket at/under the threshold,
// descending only while deepening actually splits a bucket further. A small spec
// stays at depth 1 (siblings like `/users` + `/users/{id}` remain one group); a
// spec where hundreds of endpoints share one prefix (`/graphql/*`) descends until
// it splits — so a single over-threshold bucket can't collapse to one dead group.
function choosePathDepth(paths: string[]): number {
  let depth = 1;
  while (depth < MAX_PATH_DEPTH) {
    const counts = new Map<string, number>();
    for (const p of paths) {
      const k = pathKeyAtDepth(p, depth);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const maxBucket = counts.size ? Math.max(...counts.values()) : 0;
    if (maxBucket <= LARGE_SPEC_ENDPOINT_THRESHOLD) break;

    const deeper = new Set(paths.map(p => pathKeyAtDepth(p, depth + 1)));
    if (deeper.size <= counts.size) break; // going deeper doesn't split anything → stop
    depth++;
  }
  return depth;
}

interface Grouping {
  mode: GroupMode;
  keyOfEndpoint: (ep: Pick<ParsedEndpoint, 'tags' | 'path'>) => string;
  // Unsupported endpoints carry no tags, so in tag mode they're assigned to the
  // group their path prefix belongs to (from the supported endpoints), NOT dropped.
  keyOfUnsupportedPath: (path: string) => string;
}

function buildGrouping(spec: ParsedApiSpec): Grouping {
  const byTag = new Set<string>();
  for (const ep of spec.endpoints) {
    const t = primaryTag(ep);
    if (t) byTag.add(t);
  }

  if (byTag.size > 1) {
    // Tag mode. Map each supported path prefix → its tag so an unsupported
    // endpoint (`/users/upload`) lands in the same group as `/users` rather than
    // silently disappearing.
    const prefixToTag = new Map<string, string>();
    for (const ep of spec.endpoints) {
      const pk = pathKeyAtDepth(ep.path, 1);
      const t = primaryTag(ep) ?? UNTAGGED;
      if (!prefixToTag.has(pk)) prefixToTag.set(pk, t);
    }
    return {
      mode: 'tag',
      keyOfEndpoint: ep => primaryTag(ep) ?? UNTAGGED,
      keyOfUnsupportedPath: path => prefixToTag.get(pathKeyAtDepth(path, 1)) ?? UNTAGGED,
    };
  }

  // Path mode (untagged or single-tag spec). Depth is chosen from the supported
  // endpoints so both supported and unsupported are keyed the same way.
  const depth = choosePathDepth(spec.endpoints.map(e => e.path));
  return {
    mode: 'path',
    keyOfEndpoint: ep => pathKeyAtDepth(ep.path, depth),
    keyOfUnsupportedPath: path => pathKeyAtDepth(path, depth),
  };
}

// Count supported + unsupported endpoints per group key.
function countGroups(spec: ParsedApiSpec, g: Grouping): { supported: Map<string, number>; total: Map<string, number> } {
  const supported = new Map<string, number>();
  const total = new Map<string, number>();
  for (const ep of spec.endpoints) {
    const k = g.keyOfEndpoint(ep);
    supported.set(k, (supported.get(k) || 0) + 1);
    total.set(k, (total.get(k) || 0) + 1);
  }
  for (const ue of spec.unsupportedEndpoints) {
    const k = g.keyOfUnsupportedPath(ue.path);
    total.set(k, (total.get(k) || 0) + 1);
  }
  return { supported, total };
}

function toGroupChoices(supported: Map<string, number>, total: Map<string, number>, namePrefix = ''): ApiGroupChoice[] {
  return [...total.entries()]
    // Don't offer a group with no supported endpoints — selecting it would dead-end.
    .filter(([name]) => (supported.get(name) || 0) > 0)
    .map(([name, endpointCount]) => ({ name: namePrefix ? `${namePrefix}${SUBGROUP_SEP}${name}` : name, endpointCount }))
    .sort((a, b) => b.endpointCount - a.endpointCount || a.name.localeCompare(b.name));
}

/**
 * Group choices to offer for a large spec, largest first. `endpointCount`
 * includes unsupported endpoints so the number matches the spec (the flow itself
 * still builds only from supported ones). Returns fewer than 2 groups only when
 * the spec genuinely can't be split (caller then hard-rejects).
 */
export function groupEndpointsForSelection(spec: ParsedApiSpec): { mode: GroupMode; groups: ApiGroupChoice[] } {
  const g = buildGrouping(spec);
  const { supported, total } = countGroups(spec, g);
  return { mode: g.mode, groups: toGroupChoices(supported, total) };
}

/**
 * Split an already-narrowed group further. `spec` must be the result of
 * `filterSpecByGroup(spec, parentName)`; the returned choices carry compound
 * `parentName ▸ child` names that `filterSpecByGroup` can re-apply. Used when a
 * chosen group is itself over the threshold.
 */
export function subgroupForSelection(
  spec: ParsedApiSpec,
  parentName: string,
): { mode: GroupMode; groups: ApiGroupChoice[] } {
  const g = buildGrouping(spec);
  const { supported, total } = countGroups(spec, g);
  return { mode: g.mode, groups: toGroupChoices(supported, total, parentName) };
}

/**
 * Restrict a parsed spec to one group's endpoints. The grouping mode is
 * recomputed from the (unchanged) spec, so `groupName` matches the same keys the
 * selection functions presented — no mode needs to be sent by the client.
 *
 * A compound `parent ▸ child` name filters left-to-right: first to `parent`, then
 * that subset to `child`. Endpoints AND unsupported endpoints are both filtered so
 * the unsupported inventory stays consistent with the chosen group.
 */
export function filterSpecByGroup(spec: ParsedApiSpec, groupName: string): ParsedApiSpec {
  const sep = groupName.indexOf(SUBGROUP_SEP);
  if (sep !== -1) {
    const parent = groupName.slice(0, sep);
    const child = groupName.slice(sep + SUBGROUP_SEP.length);
    return filterSpecByGroup(filterSpecByGroup(spec, parent), child);
  }

  const g = buildGrouping(spec);
  const endpoints = spec.endpoints.filter(ep => g.keyOfEndpoint(ep) === groupName);
  const unsupportedEndpoints: UnsupportedEndpoint[] = spec.unsupportedEndpoints.filter(
    ue => g.keyOfUnsupportedPath(ue.path) === groupName,
  );

  return { ...spec, endpoints, unsupportedEndpoints };
}
