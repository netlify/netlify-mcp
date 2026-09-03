import type { NetlifyAccountResponse } from '../../utils/api-types.js';

export function getEnrichedTeamModelForLLM(teams: NetlifyAccountResponse[] | NetlifyAccountResponse | null | undefined) {
  if (!teams) {
    return [];
  }

  return (Array.isArray(teams) ? teams : [teams]).map((team) => {

    const { id, name, slug, created_at, updated_at, members_count, enforce_mfa, type_name } = team;

    return ({
      id,
      name,
      slug,
      created_at,
      updated_at,
      members_count,
      enforce_mfa,
      type_name,
      _enrichedFields: {
        currentUserRoleOnTeam: team.role,
        netlifyUrlForTeam: `https://app.netlify.com/teams/${team.slug}`
      }
    });
  });
}
