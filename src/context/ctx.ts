export const siteIdContext = `
If site ID is needed, find it in the following ways:
 - see if there is a .netlify/state.json file in the directory. The site ID can be found there.
 - lookup the site by repo which can be pulled from the git information on the directory (if available)
 - if terminal commands can be run, use 'netlify status' command which should include the site ID.
 - if this is a new site, there isn't a site id yet and you must create one which will return the site id. It's a good idea to ensure .netlify/state.json has a { "siteId": "<siteId>" } in it for future use.
`;

export const baselineAPIContext = `
${siteIdContext}
If the account ID is needed for a site specific, find it in the following ways:
 - get the site id and then lookup the account id for the site
`;

export const codingGeneral = `

ALWAYS USE THE FOLLOWING CONTEXT WHEN CREATING OR EDITING FUNCTIONS



## General

- the \`.netlify\` folder is NOT for user code. It should be added to the .gitignore list
- avoid adding version numbers to imported code. (for example use \`@netlify/functions\` and never \`@netlify/functions@VERSION\`)
- *NEVER* add CORS headers (such as Access-Control-Allow-Origin) unless user EXPLICITLY asks for them.
- prefer using \`netlify dev\` to start dev server unless another dev command is requested by the user

# Guidelines

- There are 4 types of compute systems you can write code for:
  - Serverless functions - usually used for transactional server/api requests.
  - Edge functions - usually used for code that must modify requests before hitting the server or modifying responses before returning to users.
  - Background functions - longer running functions for asynchronous work.
  - Scheduled functions - schedule logic to run on a CRON-based interval.

## Netlify compute

- NEVER put any type of serverless or edge function in the public or publish directory
- DO NOT change the default functions or edge functions directory unless explicitly asked to.
- ALWAYS verify the correct directory to place functions or edge functions into

### Context object for serverless functions and edge functions

Below are the available fields/functions from the context argument to serverless and edge functions.

\`\`\`
{
  account: {
    id: string, // Unique ID of the Netlify team account associated with the site and function.
  },
  cookies: {
    get: (name: string) => string | undefined, // Reads a cookie from the incoming request.
    set: (options: { name: string; value: string; path?: string; domain?: string; secure?: boolean; httpOnly?: boolean; expires?: Date }) => void, // Sets a cookie on the outgoing response following the CookieStore.set web standard.
    delete: (nameOrOptions: string | { name: string; path?: string; domain?: string }) => void, // Deletes a cookie on the outgoing response, following the CookieStore.delete web standard.
  },
  deploy: {
    context: string, // The deploy context (e.g., production, deploy-preview).
    id: string, // Unique ID of the deploy the function belongs to.
    published: boolean, // Indicates whether the function belongs to the currently published deploy.
  },
  geo: {
    city: string, // City name of the client location.
    country: {
      code: string, // ISO 3166 country code.
      name: string, // Full country name.
    },
    latitude: number, // Latitude coordinate of the client location.
    longitude: number, // Longitude coordinate of the client location.
    subdivision: {
      code: string, // ISO 3166 subdivision code (e.g., state or province).
      name: string, // Subdivision name.
    },
    timezone: string, // Timezone of the location.
    postalCode: string, // Postal code of the location in its regional format.
    ip: string, // Client IP address.
  },
  params: Record<string, string>, // Object containing route parameters from the function path configuration.
  requestId: string, // Unique Netlify request ID.
  server: {
    region: string, // The region code where the deployment is running (e.g., us-east-1).
  },
  site: {
    id: string, // Unique ID for the Netlify site.
    name: string, // The site's Netlify subdomain name.
    url: string, // The main address of the site, which could be a Netlify subdomain or a custom domain.
  },
}
\`\`\`

### the \`Netlify\` global object

- the \`Netlify\` object is available in global scope.
- available on all serverless and edge function types

It has the following fields/functions:

\`\`\`
{
  context: object | null, // The Netlify-specific context object - same as function's second arg. Available only within function handlers or child scopes; otherwise, it returns null.

  env: {
    delete: (name: string) => void, // Deletes an environment variable within the context of the invocation.
    get: (name: string) => string | undefined, // Retrieves the string value of an environment variable; returns undefined if not defined.
    has: (name: string) => boolean, // Checks if an environment variable exists; returns true if it does, otherwise false.
    set: (name: string, value: string) => void, // Sets an environment variable within the invocation context.
    toObject: () => Record<string, string>, // Returns an object containing all environment variables and their values.
  },
};
\`\`\`

`;

export const serverless = `${codingGeneral}
### Serverless Functions (aka Functions, aka Synchronous functions)
- Serverless functions use Node.js and should attempt to use built-in methods where possible
- When adding new npm modules, ensure "node_modules" is in the .gitignore
- there is NO persistent disk storage on serverless functions. Use @netlify/blobs for file/content storage.
- ALWAYS use the latest format of a function structure.
- if using typescript, ensure types are installed from \`npm install @netlify/functions\`
- DO NOT put global logic outside of the exported function unless it is wrapped in a function definition
- ONLY use vanilla javascript if there are other ".js" files in the functions directory.
- ALWAYS use typescript if other functions are typescript or if there are no existing functions.
- The first argument is a web platform Request object that represents the incoming HTTP request
- The second argument is a custom Netlify context object.
- Functions have a global \`Netlify\` object that is also accessible.
  - ONLY use \`Netlify.env.*\` for interacting with environment variables in code.
- Place function files in \`YOUR_BASE_DIRECTORY/netlify/functions\` or a subdirectory.
  - The serverless functions directory can be changed via:
    - **Netlify UI**: *Site configuration > Build & deploy > Continuous deployment > Build settings*
    - **\`netlify.toml\`**:
      \`\`\`toml
      [functions]
        directory = "my_functions"
    \`\`\`
  - \`netlify.toml\` settings override UI settings.
- If using a subdirectory, name the entry file \`index.mts\` or match the subdirectory name.
  - Example valid function paths:
    - \`netlify/functions/hello.mts\`
    - \`netlify/functions/hello/index.mts\`
    - \`netlify/functions/hello/hello.mts\`
- Naming files with \`.mts\` enables modern ES module syntax

#### Examples of the latest Serverless Function or Function structures
  - \`\`\`typescript
      import type { Context, Config } from "@netlify/functions";

      export default async (req: Request, context: Context) => {
        // user code
        return new Response("Hello, world!")
      }

      export const config: Config = {
        // use this path instead of /.netlify/functions/{fnName}
        path: "/hello-world"
      };
    \`\`\`
  - \`\`\`javascript
      export default async (req, context) => {
        // user code
        return new Response("Hello, world!")
      }

      export const config = {
      // use this path instead of /.netlify/functions/{fnName}
        path: "/hello-world"
      };
    \`\`\`
#### In-code function config and routing for serverless functions
- prefer to use in-code configuration via exporting a \`config\` object. This is the structure the config can have:
- prefer to provide a friendly path using the config object.
- ONLY serverless functions use \`/.netlify/functions/{function_name}\` path by default.
- If you set a specific path via this config or the netlify.toml, it will only be available at that new path.
- path and excluded path supports substring patterns or the URLPattern syntax from the web platform.

\`\`\`
{
  path: string | string[], // Defines the URL path(s) that trigger the function. Can be a single string or an array of paths.
  excludedPath?: string | string[], // Optional. Defines paths that should be excluded from triggering the function.
  preferStatic?: boolean, // Optional. If true, prevents the function from overriding existing static assets on the CDN.
}
\`\`\`

`;

export const background = `
${codingGeneral}
### Background Functions
- Use background functions when you need to run long-running logic, and that logic does not need to compute a response immediately.
- Any data that background functions need to serve to users should be calculated and stored in a place that a serverless function can read from later - such as Netlify Blobs or a preconfigured database.
- Background functions operate the same as standard Serverless functions and are syntactically the same with the following exceptions
  - they have a 15-minute timeout measured by "wall clock" time
  - they immediately return an empty response with a 202 status code. Return values from these functions are ignored.
  - Background functions MUST have a "-background" suffix on the function file name or function directory (for example, netlify/functions/hello-background.mts or netlify/functions/hello-background/index.mts).

#### Examples of the latest background function structures
- \`\`\`typescript
    import { Context } from "@netlify/functions";

    export default async (req: Request, context: Context) => {
      await someLongRunningTask();

      console.log("Done");
    };
  \`\`\`

- \`\`\`javascript
    export default async (req, context) => {
      await someLongRunningTask();

      console.log("Done");
    };
  \`\`\`
`;

export const scheduled = `${codingGeneral}
### Scheduled Functions
- Use scheduled functions when the logic needs to run on an interval or can be defined via CRON timing.
- CRON expressions are executed against the UTC timezone
- our CRON syntax supports extensions defined the RFC except for the @reboot and @annually.
- The minimum interval is 1 minute
- Scheduled functions have a 30-second execution limit
- Scheduled functions do not return response bodies
- the request body is a JSON-encoded object containing a \`next_run\` property. It represents the timestamp of the next scheduled invocation, as a string in the ISO-8601 format.
- in addition to in-code config, schedules can be defined in the \`netlify.toml\`. ONLY do this for consistency or if explicitly asked to keep all schedules in one place.
  \`\`\`toml
    [functions."test-scheduled-function"]
      schedule = "@hourly"
  \`\`\`
- Scheduled functions ONLY run on published deploys. They donâ€™t run on Deploy Previews or branch deploys.
- For local tests, the Netlify CLI to run the site in dev mode and the \`netlify functions:invoke\` [command](mdc:https:/cli.netlify.com/commands/functions/#functionsinvoke) to trigger the scheduled function.
  example:
  \`\`\`bash
    netlify functions:invoke myfunction
  \`\`\`

#### Examples of the latest background function structures
- \`\`\`typescript
    import type { Config } from "@netlify/functions"

    export default async (req: Request) => {
        const { next_run } = await req.json()

        console.log("Received event! Next invocation at:", next_run)
    }

    export const config: Config = {
        schedule: "@hourly"
    }

  \`\`\`

- \`\`\`javascript
    export default async (req) => {
        const { next_run } = await req.json()

        console.log("Received event! Next invocation at:", next_run)
    }

    export const config = {
        schedule: "@hourly"
    }

  \`\`\`

`;

export const edge = `${codingGeneral}
### Edge Functions
- ALWAYS use the latest format of an edge function structure.
- **DO NOT** add CORS headers (such as Access-Control-Allow-Origin) unless explicitly asked for them.
- if using typescript, ensure types are installed from \`npm install @netlify/edge-functions\`
- DO NOT put global logic outside of the exported function unless it is wrapped in a function definition
- ONLY use vanilla javascript if there are other ".js" files in the functions directory.
- ALWAYS use typescript if other functions are typescript or if there are no existing functions.
- The first argument is a web platform Request object that represents the incoming HTTP request
- The second argument is a custom Netlify context object.
- Edge functions have a global \`Netlify\` object that is also accessible.
  - ONLY use \`Netlify.env.*\` for interacting with environment variables in code.
- Place function files in \`YOUR_BASE_DIRECTORY/netlify/edge-functions\` or a subdirectory.
  - The serverless functions director can be changed via\`netlify.toml\`:
    \`\`\`toml
    [build]
      edge_functions = "my-custom-directory"
    \`\`\`

- Edge functions use Deno as runtime and should attempt to use built-in methods where possible. See the list of available web APIs to know which built-ins to use.
  - **Module Support**:
    - Supports **Node.js built-in modules**, **Deno modules**, and **npm packages** (beta).
  - **Importing Modules**:
    - **Node.js built-in modules**: Use \`node:\` prefix (e.g., \`import { randomBytes } from "node:crypto"\`).
    - **Deno modules**: Use **URL imports** (e.g., \`import React from "https://esm.sh/react"\` or an **import map**).
    - **npm packages (beta)**: Install via \`npm install\` and import by package name (e.g., \`import _ from "lodash"\`).
    - Some npm packages with **native binaries** (e.g., Prisma) or **dynamic imports** (e.g., cowsay) may not work.
  - You may use an **import map** to reference third-party modules with shorthand names instead of full URLs.
  - **Import Map Usage**:
    - Define mappings in a separate **import map file** (not in \`deno.json\`).
    - The file can be placed anywhere in the project directory.
  - **Example Import Map (\`import_map.json\`)**:
    \`\`\`json
    {
      "imports": {
        "html-rewriter": "https://ghuc.cc/worker-tools/html-rewriter/index.ts"
      }
    }
    \`\`\`
  - **Enabling Import Maps**:
    - Declare the import map in \`netlify.toml\`:
      \`\`\`toml
      [functions]
        deno_import_map = "./path/to/your/import_map.json"
      \`\`\`
  - **Usage in Code**:
    - Modules can now be imported by name:
      \`\`\`javascript
      import { HTMLRewriter } from "html-rewriter";
      \`\`\`
#### Examples of the latest Edge function structures
  - \`\`\`typescript
      import type { Context, Config } from "@netlify/edge-functions";

      export default async (req: Request, context: Context) => {
        // user code
        return new Response("Hello, world!")
      }

      export const config: Config = {
        path: "/hello-world"
      };
    \`\`\`
  - \`\`\`javascript
        export default async (req, context) => {
          // user code
          return new Response("Hello, world!")
        }

        export const config = {
          path: "/hello-world"
        };
    \`\`\`

#### Extra properties on context argument for Edge Functions
- these are ONLY available in Edge Functions

\`\`\`
{
  ...ALL OTHER Context fields/methods,

  next: (options?: { sendConditionalRequest?: boolean }) => Promise<Response>, // Invokes the next item in the request chain, optionally using conditional requests.

  nextRequest: (request: Request, options?: { sendConditionalRequest?: boolean }) => Promise<Response>, // Same as next(), but requires an explicit Request object.
}

\`\`\`

#### Web APIs available in Edge Functions ONLY
- console.*
- atob
- btoa
- Fetch API
  - fetch
  - Request
  - Response
  - URL
  - File
  - Blob
- TextEncoder
- TextDecoder
- TextEncoderStream
- TextDecoderStream
- Performance
- Web Crypto API
  - randomUUID()
  - getRandomValues()
  - SubtleCrypto
- WebSocket API
- Timers
  - setTimeout
  - clearTimeout
  - setInterval
- Streams API
  - ReadableStream
  - WritableStream
  - TransformStream
- URLPattern API


#### In-code function config and routing for Edge functions
- prefer to use in-code configuration via exporting a \`config\` object. This is the structure the config can have:
- prefer to provide a friendly path using the config object.
- Edge functions are configured with a path pattern and only paths matching those patterns will run the edge function
- path and excludedPath supports substring patterns or the URLPattern syntax from the web platform.
- unless explicitly asked to modify other properties, only set path, pattern, excludedPath when creating functions.

\`\`\`
{
  path?: string | string[], // URLPattern expression defining paths where the edge function should run. Must start with '/'.
  excludedPath?: string | string[], // Optional. Defines paths to exclude from execution. Must start with '/'.
  pattern?: RegExp | RegExp[], // Alternative to \`path\`. Uses regex for path matching.
  excludedPattern?: RegExp | RegExp[], // Optional. Defines regex patterns to exclude certain routes.
  method?: string | string[], // Optional. Specifies HTTP methods that should trigger the function (e.g., "GET", ["POST", "PUT"]).
  onError?: "continue" | "fail" | "fallback", // Optional. Controls how the function handles errors.
  cache?: 'manual', // Optional. Enables response caching if set to 'manual'.
} = {
  path: "", // Default value; should be set per function.
};
\`\`\`

#### Configuring Edge Functions in netlify.toml
- ONLY Use \`netlify.toml\` for precise function order control instead of inline declarations.
- DO NOT use \`netlify.toml\` if there is not edge function ordering requirements.
- When controlling order, it's important to include all edge functions for order control.

- **Declare Edge Functions in \`netlify.toml\`**:
  - Allows multiple edge functions on the same path with explicit execution order.
  - Functions run **top-to-bottom**, except cached functions, which always run last.

- **Edge Function Properties**:
  - \`function\`: Name of the edge function.
  - \`path\`: URL pattern to trigger the function (must start with \`/\`).
  - \`excludedPath\`: Excludes specific routes from \`path\` (supports string or array).
  - \`pattern\`: Regex-based path matching.
  - \`excludedPattern\`: Excludes specific regex patterns (single or array).
  - \`cache\`: Enables response caching (cached functions run after non-cached ones) set to 'manual' to opt in.

- **Netlify.toml config examples**
  \`\`\`toml
  [[edge_functions]]
    path = "/admin"
    function = "auth"

  [[edge_functions]]
    path = "/admin"
    function = "injector"
    cache = "manual"

  [[edge_functions]]
    path = "/blog/*"
    function = "auth"

  [[edge_functions]]
    path = "/blog/*"
    function = "rewriter"

  [[edge_functions]]
    pattern = "/products/(.*)"
    excludedPattern = "/products/things/(.*)"
    function = "highlight"

  [[edge_functions]]
    path = "/*"
    excludedPath = "/img/*"
    function = "common"
\`\`\`
- **Execution Order for Edge Functions**:
  1. **Configuration-based** edge functions (\`netlify.toml\`) run first.
  2. **Framework-generated** edge functions execute before user-defined functions.
  3. **Non-cached** edge functions execute before cached functions.
  4. **Inline-declared** edge functions override duplicate \`netlify.toml\` functions.
  5. **Multiple inline edge functions** run alphabetically by filename.

- **Caveats & Special Cases**:
  - If an edge function returns a response, redirects for that path DO NOT occur.
  - Edge functions DO NOT execute for rewritten static routing targets.
  - \`fetch()\` or \`URL()\` triggers a **new request chain**, re-running matching functions.
  - Use \`context.next()\` to continue processing instead of re-triggering functions.
  - Function failure behavior depends on its **error handling configuration**.

#### Edge functions limitations
- 20 MB (compressed) code size limit
- 512 MB per deployment memory limit
- 50ms per request CPU execution time (excludes waiting time)
- 40 seconds Response header timeout
- **Not compatible with these Netlify features**:
  - Netlify's split testing feature
  - Custom Headers (including basic authentication) from _headers or netlify.toml config
  - Netlify prerendering feature on paths served by edge functions
- Be aware that multiple framework adapters may generate conflicting edge functions
- **Restrictions**:
  - Can only rewrite requests to same-site URLs (use \`fetch()\` for external content)
  - Cached edge functions override existing static files
  - No local caching; HTTP cache headers are ignored in local testing
  - Not included in Netlifyâ€™s HIPAA-compliant hosting offering
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
