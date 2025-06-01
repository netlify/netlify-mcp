export function getEnrichedTeamModelForLLM(teams: any[] | any) {
  if (!teams) {
    return [];
  }

  return (Array.isArray(teams) ? teams : [teams]).map((team: any) => {

    const fieldsToMap = ['id', 'name', 'slug', 'created_at', 'updated_at', 'members_count', 'enforce_mfa', 'type_name'];

    return ({
      ...Object.fromEntries(Object.entries(team).filter(([key]) => fieldsToMap.includes(key))),
      _enrichedFields: {
        currentUserRoleOnTeam: team.role,
        netlifyUrlForTeam: `https://app.netlify.com/teams/${team.slug}`
      }
    });
  });
}
