export function getEnrichedSiteModelForLLM(sites: any[] | any) {
  if (!sites) {
    return [];
  }

  return (Array.isArray(sites) ? sites : [sites]).map((site: any) => {

    const fieldsToMap = ['id', 'site_id', 'plan', 'claimed', 'name'];

    return ({
      ...Object.fromEntries(Object.entries(site).filter(([key]) => fieldsToMap.includes(key))),
      _enrichedFields: {

        teamId: site.account_id,

        netlifyUrlForProject: site.admin_url || `https://app.netlify.com/projects/${site.name}`,

        projectAccessControls: {
          requiresPassword: !!site.has_password,
          // possible contexts: "all", "non_production"
          whichProjectsRequirePassword: site.has_password ? site.password_context : null,
          requiresSSOTeamLogin: !!site.sso_login,
          whichProjectsRequireSSOTeamLogin: site.sso_login ? site.sso_login_context : null
        },

        urls: {
          primarySiteUrl: site.url,
          branchVersionOfSite: site.deploy_ssl_url || site.deploy_url,
        },

        currentDeploy: {
          state: site.state,
          currentDeploy: {
            id: site.published_deploy?.id,
            state: site.published_deploy?.state
          }
        },

        extraFeatures: {
          // site.use_forms tracks if forms have actually been used vs if it can be used
          forms: !site.processing_settings?.ignore_html_forms ? 'enabled' : 'not enabled'
        }
      }
    });
  });
}
