export const siteIdContext = `
If site ID is needed, find it in the following ways:
 - see if there is a .netlify/state.json file in the directory. The site ID can be found there.
 - lookup the site by repo which can be pulled from the git information on the directory (if available)
 - if terminal commands can be run, use 'netlify status' command which should include the site ID.
 - if this is a new site, there isn't a site id yet and you must create one which will return the site id. It's a good idea to ensure .netlify/state.json has a { "siteId": "<siteId>" } in it for future use.
`;

export const accountIdContext = `
If the account ID is needed for a site specific, find it in the following ways:
 - get the site id and then lookup the account id for the site


${siteIdContext}
`;


export const command_env_vars = `
  ### Netlify CLI Command
  - The site must be linked first before the CLI will add variables. See the rules for initializing and linking sites for how to do this.
  - Use \`env: set\` for changes, \`env: unset\` to delete. \`env:import \` to import from a dotenv\`.env\` file.

  #### Example usage of env var CLI
  - Basic setting an environment variable for the site
    \`\`\`sh
      netlify env:set API_KEY "not-a-secret"
  \`\`\`
  - Setting an environment variable that should be treated as a secret
    \`\`\`sh
        netlify env:set API_KEY "secret-value" --secret
  \`\`\`
`
