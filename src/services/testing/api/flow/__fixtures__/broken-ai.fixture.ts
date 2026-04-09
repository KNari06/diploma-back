/**
 * Broken-AI fixtures — simulate what happens when the Architect agent
 * forgets to wire dependsOn. These are clones of petstore / nested-school /
 * auth-first with all dependsOn cleared, emulating the most common real
 * failure mode: "AI produced nodes but left the graph flat".
 *
 * Measurement: how much of the ordering does auto-wire recover?
 */

import type { ResolverFixture } from './types';
import { petstoreFixture } from './petstore.fixture';
import { nestedSchoolFixture } from './nested-school.fixture';
import { authFirstFixture } from './auth-first.fixture';

function flatten(fixture: ResolverFixture, suffix: string): ResolverFixture {
  return {
    ...fixture,
    name: `${fixture.name}-${suffix}`,
    description: `${fixture.description} — AI forgot dependsOn`,
    idealArchitectOutput: {
      ...fixture.idealArchitectOutput,
      nodes: fixture.idealArchitectOutput.nodes.map((n: any) => ({
        ...n,
        dependsOn: [],
      })),
    },
  };
}

export const petstoreBrokenFixture = flatten(petstoreFixture, 'broken');
export const nestedSchoolBrokenFixture = flatten(nestedSchoolFixture, 'broken');
export const authFirstBrokenFixture = flatten(authFirstFixture, 'broken');
