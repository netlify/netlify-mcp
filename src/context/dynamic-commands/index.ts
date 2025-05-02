import { convertOpenAPIToMCPSchema } from "./openapi-to-schema.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openAPIAllowlist } from "./cmd-operation-allowlist.js";

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the OpenAPI schema file
const openapiSchemaPath = path.join(__dirname, 'openapi-external.json');
const openapiSchemaContent = fs.readFileSync(openapiSchemaPath, 'utf-8');

// Convert the OpenAPI schema to MCP tool schemas with base URL
const convertedOpenAPISchemas = convertOpenAPIToMCPSchema(openapiSchemaContent, 'https://api.netlify.com/api/v1/');
const mcpSchemas = Object.fromEntries(
  Object.entries(convertedOpenAPISchemas).filter(([key]) => openAPIAllowlist.includes(key))
);

// will eventually allow pulling commands from the API
export async function getDynamicCommands() {
  return mcpSchemas;
}
