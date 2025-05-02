/**
 * Test file for openapi-to-schema.ts
 *
 * This script reads the OpenAPI schema from openapi-external.json,
 * invokes the convertOpenAPIToMCPSchema function, and logs the first 5 entries
 * to inspect the output.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertOpenAPIToMCPSchema } from './context/dynamic-commands/openapi-to-schema.js';

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the OpenAPI schema from the JSON file
const openapiSchemaPath = path.resolve(__dirname, 'openapi-external.json');
const openapiSchema = fs.readFileSync(openapiSchemaPath, 'utf-8');

// Convert the OpenAPI schema to MCP tool schemas
console.log('Converting OpenAPI schema to MCP tool schemas...');
const mcpSchemas = convertOpenAPIToMCPSchema(openapiSchema);

// Get all tool names
const toolNames = Object.keys(mcpSchemas);
console.log(`Total number of tools generated: ${toolNames.length}`);

// Log the first 5 entries
console.log('\nFirst 5 entries:');
toolNames.forEach((toolName, index) => {

  console.log(`\nTool #${index + 1}: ${toolName}`);
  console.log(JSON.stringify(mcpSchemas[toolName], null, 2));
  return;
  const tool = mcpSchemas[toolName];

  // Log basic info
  console.log(`- Name: ${tool.name}`);
  console.log(`- Description: ${tool.description}`);

  // Log parameter info (names only for brevity)
  const paramNames = Object.keys(tool.parameters);
  console.log(`- Parameters: ${paramNames.length ? paramNames.join(', ') : 'none'}`);

  // Log response info (status codes only for brevity)
  const responseStatusCodes = Object.keys(tool.responses);
  console.log(`- Response status codes: ${responseStatusCodes.join(', ')}`);

  // Show example of one parameter's schema (if any exist)
  if (paramNames.length > 0) {
    const firstParamName = paramNames[0];
    console.log(`\n  Example parameter: ${firstParamName}`);
    console.log(`  - Description: ${tool.parameters[firstParamName].description}`);
    console.log(`  - Required: ${tool.parameters[firstParamName].required}`);
    console.log(`  - In: ${tool.parameters[firstParamName].in}`);
    console.log(`  - Schema type: ${tool.parameters[firstParamName].schema.constructor.name}`);
  }

  // Show example of one response schema (if any exist)
  if (responseStatusCodes.length > 0) {
    const firstStatusCode = responseStatusCodes[0];
    console.log(`\n  Example response: ${firstStatusCode}`);
    console.log(`  - Description: ${tool.responses[firstStatusCode].description}`);
    if (tool.responses[firstStatusCode].contentType) {
      console.log(`  - Content Type: ${tool.responses[firstStatusCode].contentType}`);
    }
    if (tool.responses[firstStatusCode].schema) {
      console.log(`  - Schema type: ${tool.responses[firstStatusCode].schema.constructor.name}`);
    }
  }

  console.log('-----------------------------------');
});
