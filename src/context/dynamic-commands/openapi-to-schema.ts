import { z } from 'zod';
import * as zod from 'zod';

// OpenAPI Schema interfaces
interface OpenAPISchema {
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Schema>;
  };
}

interface PathItem {
  [method: string]: Operation;
}

interface Operation {
  operationId?: string;
  description?: string;
  summary?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, Response>;
}

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: Schema;
}

interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, MediaType>;
}

interface MediaType {
  schema?: Schema;
}

interface Response {
  description?: string;
  content?: Record<string, MediaType>;
}

interface Schema {
  type?: string;
  format?: string;
  enum?: any[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  $ref?: string;
}

// MCP Tool Schema interface
export interface MCPToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  responses: {
    content: Array<{ type: 'text'; text: string }> | Array<{ type: 'json'; json: any }>;
    isError?: boolean;
  };
}

// Request Info interface for API call construction
export interface RequestInfo {
  method: string;
  path: string;
  baseUrl: string;
  contentType: string;
  pathParams: string[];
  queryParams: string[];
  bodySchema?: zod.ZodTypeAny;
  responseSchema?: zod.ZodTypeAny;
  parameters: Record<string, { in: string; required: boolean; schema: zod.ZodTypeAny }>;
}

/**
 * Converts an OpenAPI schema to MCP tool schemas
 * @param openapiSchema OpenAPI schema as object or JSON string
 * @returns Record of MCP tool schemas keyed by operationId
 */
export function convertOpenAPIToMCPSchema(openapiSchema: OpenAPISchema | string, baseUrl: string = 'https://api.netlify.com/api/v1/'): Record<string, MCPToolSchema & { request: RequestInfo }> {
  const schema: OpenAPISchema = typeof openapiSchema === 'string'
    ? JSON.parse(openapiSchema)
    : openapiSchema;

  const tools: Record<string, MCPToolSchema & { request: RequestInfo }> = {};

  Object.entries(schema.paths).forEach(([path, pathItem]) => {
    const methods = Object.keys(pathItem).filter(
      method => ['get', 'post', 'put', 'patch', 'delete'].includes(method)
    );

    methods.forEach(method => {
      const operation = pathItem[method] as Operation;
      const operationId = operation.operationId || `${method}${path.replace(/\W/g, '')}`;

      // Extract path parameters
      const pathParams = extractPathParams(path);
      const pathParameters = operation.parameters?.filter(p => p.in === 'path') || [];
      const queryParameters = operation.parameters?.filter(p => p.in === 'query') || [];

      // Extract request body schema
      const bodySchema = operation.requestBody?.content?.['application/json']?.schema;

      // Extract response schema
      const successResponse = operation.responses?.['200'] || operation.responses?.['201'];
      const responseSchema = successResponse?.content?.['application/json']?.schema;

      // Extract all parameters with their location (path, query, body)
      const parameterInfo: Record<string, { in: string; required: boolean; schema: zod.ZodTypeAny }> = {};

      // Process path parameters
      if (pathParameters.length > 0) {
        pathParameters.forEach(param => {
          parameterInfo[param.name] = {
            in: 'path',
            required: param.required ?? true, // Path params are usually required
            schema: convertOpenAPITypeToZod(param.schema, schema)
          };
        });
      }

      // Process query parameters
      if (queryParameters.length > 0) {
        queryParameters.forEach(param => {
          parameterInfo[param.name] = {
            in: 'query',
            required: param.required ?? false,
            schema: convertOpenAPITypeToZod(param.schema, schema)
          };
        });
      }

      // Process body parameters
      if (bodySchema && bodySchema.properties) {
        Object.entries(bodySchema.properties).forEach(([propName, propSchema]) => {
          parameterInfo[propName] = {
            in: 'body',
            required: bodySchema.required?.includes(propName) ?? false,
            schema: convertOpenAPITypeToZod(propSchema, schema)
          };
        });
      }

      // Create request info for API call construction
      const requestInfo: RequestInfo = {
        method: method.toUpperCase(),
        path,
        baseUrl,
        contentType: 'application/json',
        pathParams: pathParams,
        queryParams: queryParameters.map(p => p.name),
        bodySchema: bodySchema ? convertOpenAPITypeToZod(bodySchema, schema) : undefined,
        responseSchema: responseSchema ? convertOpenAPITypeToZod(responseSchema, schema) : undefined,
        parameters: parameterInfo
      };

      tools[operationId] = {
        name: operationId,
        description: operation.description || operation.summary || `${method.toUpperCase()} ${path}`,
        parameters: {
          type: 'object',
          properties: extractParameterProperties(operation, schema),
          required: extractRequiredParameters(operation)
        },
        responses: {
          content: [
            {
              type: 'json',
              json: { message: `Response for ${operationId}` }
            }
          ]
        },
        request: requestInfo
      };
    });
  });

  return tools;
}

/**
 * Extract path parameters from a path string
 * @param path API path with parameters like /api/sites/{site_id}
 * @returns Array of parameter names
 */
function extractPathParams(path: string): string[] {
  const matches = path.match(/\{([^}]+)\}/g) || [];
  return matches.map(match => match.slice(1, -1));
}

/**
 * Extract parameter properties for MCP tool schema
 * @param operation OpenAPI operation object
 * @param schema Full OpenAPI schema for reference resolution
 * @returns Record of parameter properties
 */
function extractParameterProperties(operation: Operation, schema: OpenAPISchema): Record<string, any> {
  const properties: Record<string, any> = {};

  // Process path and query parameters
  if (operation.parameters) {
    operation.parameters.forEach(param => {
      const zodType = convertOpenAPITypeToZod(param.schema, schema);
      properties[param.name] = {
        type: zodType.constructor.name,
        zodType: zodType,
        description: param.description || `${param.in} parameter: ${param.name}`
      };
    });
  }

  // Process request body
  if (operation.requestBody?.content?.['application/json']?.schema) {
    const bodySchema = operation.requestBody.content['application/json'].schema;

    if (bodySchema.properties) {
      Object.entries(bodySchema.properties).forEach(([propName, propSchema]) => {
        const zodType = convertOpenAPITypeToZod(propSchema, schema);
        properties[propName] = {
          type: zodType.constructor.name,
          zodType: zodType,
          description: `Request body parameter: ${propName}`
        };
      });
    } else {
      const zodType = convertOpenAPITypeToZod(bodySchema, schema);
      properties['body'] = {
        type: zodType.constructor.name,
        zodType: zodType,
        description: operation.requestBody.description || 'Request body'
      };
    }
  }

  return properties;
}

/**
 * Extract required parameters from an operation
 * @param operation OpenAPI operation object
 * @returns Array of required parameter names
 */
function extractRequiredParameters(operation: Operation): string[] {
  const required: string[] = [];

  // Add required path and query parameters
  if (operation.parameters) {
    operation.parameters.forEach(param => {
      if (param.required) {
        required.push(param.name);
      }
    });
  }

  // Add required body parameters
  if (operation.requestBody?.required && operation.requestBody?.content?.['application/json']?.schema) {
    const bodySchema = operation.requestBody.content['application/json'].schema;

    if (bodySchema.required) {
      bodySchema.required.forEach((prop: string) => {
        required.push(prop);
      });
    } else if (operation.requestBody.required) {
      required.push('body');
    }
  }

  return required;
}

/**
 * Convert OpenAPI schema type to Zod schema representation
 * @param schema OpenAPI schema object
 * @param fullSchema Full OpenAPI schema for reference resolution
 * @returns Zod schema object
 */
function convertOpenAPITypeToZod(schema?: Schema, fullSchema?: OpenAPISchema): zod.ZodTypeAny {
  if (!schema) return z.any();

  // Handle $ref
  if (schema.$ref) {
    const refParts = schema.$ref.split('/');
    const refName = refParts[refParts.length - 1];
    const refSchema = fullSchema?.components?.schemas?.[refName];

    if (refSchema) {
      return convertOpenAPITypeToZod(refSchema, fullSchema);
    }

    return z.object({
      _ref: z.string().describe(`Reference: ${schema.$ref}`)
    }).describe(`Reference to ${refName}`);
  }

  // Handle enum
  if (schema.enum) {
    const enumValues = schema.enum.filter(val => val !== null && val !== undefined);
    if (enumValues.length > 0) {
      if (typeof enumValues[0] === 'string') {
        // Convert to appropriate type for string enum
        return z.enum(enumValues as [string, ...string[]]);
      }
      if (typeof enumValues[0] === 'number') {
        // For number enums, we use union of literals instead
        const numberValues = enumValues as number[];
        if (numberValues.length === 1) {
          return z.literal(numberValues[0]);
        } else if (numberValues.length >= 2) {
          return z.union([
            z.literal(numberValues[0]),
            z.literal(numberValues[1]),
            ...numberValues.slice(2).map(n => z.literal(n))
          ]);
        }
      }
    }
    return z.any().describe('Enum with mixed types');
  }

  // Handle by type
  switch (schema.type) {
    case 'string':
      if (schema.format === 'date-time') return z.string().datetime();
      if (schema.format === 'email') return z.string().email();
      if (schema.format === 'uri') return z.string().url();
      return z.string();

    case 'number':
    case 'integer':
      return z.number();

    case 'boolean':
      return z.boolean();

    case 'array':
      if (schema.items) {
        const itemType = convertOpenAPITypeToZod(schema.items, fullSchema);
        return z.array(itemType);
      }
      return z.array(z.any());

    case 'object':
      if (schema.properties) {
        const shape: Record<string, zod.ZodTypeAny> = {};

        Object.entries(schema.properties).forEach(([key, prop]) => {
          let propType = convertOpenAPITypeToZod(prop, fullSchema);
          const isRequired = schema.required?.includes(key);

          if (!isRequired) {
            propType = propType.optional();
          }

          shape[key] = propType;
        });

        return z.object(shape);
      }

      if (schema.additionalProperties) {
        if (typeof schema.additionalProperties === 'object') {
          const valueType = convertOpenAPITypeToZod(schema.additionalProperties, fullSchema);
          return z.record(z.string(), valueType);
        }
        return z.record(z.string(), z.any());
      }

      return z.object({});

    default:
      return z.any();
  }
}

/**
 * Convert a complex schema to a Zod representation
 * @param schema OpenAPI schema object
 * @param fullSchema Full OpenAPI schema for reference resolution
 * @returns Zod schema object
 */
function convertSchemaToZod(schema: Schema, fullSchema: OpenAPISchema): zod.ZodTypeAny {
  // Handle simple types directly
  if (!schema.properties && !schema.items && !schema.oneOf && !schema.anyOf && !schema.allOf) {
    return convertOpenAPITypeToZod(schema, fullSchema);
  }

  // Handle object
  if (schema.type === 'object' || schema.properties) {
    const shape: Record<string, zod.ZodTypeAny> = {};

    if (schema.properties) {
      Object.entries(schema.properties).forEach(([key, prop]) => {
        let propType = convertOpenAPITypeToZod(prop, fullSchema);
        const isRequired = schema.required?.includes(key);

        if (!isRequired) {
          propType = propType.optional();
        }

        shape[key] = propType;
      });
    }

    return z.object(shape);
  }

  // Handle array
  if (schema.type === 'array' && schema.items) {
    const itemType = convertOpenAPITypeToZod(schema.items, fullSchema);
    return z.array(itemType);
  }

  // Handle oneOf, anyOf, allOf
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf || schema.anyOf)!.map(s => convertOpenAPITypeToZod(s, fullSchema));
    if (variants.length === 1) return variants[0];

    // Use union for anyOf/oneOf
    if (variants.length >= 2) {
      return z.union([variants[0], variants[1], ...variants.slice(2)]);
    } else {
      // Fallback for single variant
      return variants[0];
    }
  }

  if (schema.allOf) {
    // For allOf, we merge the objects if possible
    const objectSchemas = schema.allOf.filter(s => s.type === 'object' || s.properties);
    const otherSchemas = schema.allOf.filter(s => s.type !== 'object' && !s.properties);

    if (objectSchemas.length > 0) {
      // Merge properties from all object schemas
      const mergedProperties: Record<string, Schema> = {};
      const requiredProps: string[] = [];

      objectSchemas.forEach(objSchema => {
        if (objSchema.properties) {
          Object.assign(mergedProperties, objSchema.properties);
        }
        if (objSchema.required) {
          requiredProps.push(...objSchema.required);
        }
      });

      const mergedSchema: Schema = {
        type: 'object',
        properties: mergedProperties,
        required: [...new Set(requiredProps)]
      };

      // Handle other schemas if any
      if (otherSchemas.length > 0) {
        // This is an approximation - in reality, allOf with mixed schemas is complex
        return convertOpenAPITypeToZod(mergedSchema, fullSchema);
      }

      return convertOpenAPITypeToZod(mergedSchema, fullSchema);
    }

    // If no object schemas, use intersection
    if (otherSchemas.length > 0) {
      const zodSchemas = otherSchemas.map(s => convertOpenAPITypeToZod(s, fullSchema));
      if (zodSchemas.length === 1) return zodSchemas[0];

      // Use z.intersection or best approximation
      if (zodSchemas.length >= 2) {
        return zodSchemas.slice(1).reduce(
          (acc, curr) => z.intersection(acc, curr),
          zodSchemas[0]
        );
      } else {
        return zodSchemas[0];
      }
    }
  }

  return z.any().describe('Complex schema');
}
