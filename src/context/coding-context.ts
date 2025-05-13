import { appendErrorToLog, appendToLog } from "../utils/logging.js"

export interface ConsumersData {
  consumers: ConsumerConfig[]
}
export interface ContextConfig {
  scope: string
  glob?: string
  shared?: string[]
  endpoint?: string
}

export interface ContextFile {
  key: string
  config: ContextConfig
  content: string
}

// Cache wrapper interface to store timestamp with context file
interface CachedContext {
  data: ContextFile;
  timestamp: number;
}

export interface ConsumerConfig {
  key: string
  presentedName: string
  consumerProcessCmd?: string
  path: string
  ext: string
  truncationLimit?: number
  contextScopes: Record<string, ContextConfig>
  hideFromCLI?: boolean
  consumerTrigger?: string
}

let contextConsumer: ConsumerConfig | undefined;
const contextCache: Record<string, CachedContext> = {};
const TEN_MINUTES_MS = 10 * 60 * 1000;

const getConsumer = () => 'netlify-mcp';

// when we last loaded the consumer config
let contextConsumerTimestamp: number = 0;

// load the consumer configuration for the MCP so
// we can share all of the available context for the
// client to select from.
export async function getContextConsumerConfig(){
  const now = Date.now();

  // Return cached consumer if it exists and is less than 10 minutes old
  if(contextConsumer && (now - contextConsumerTimestamp) < TEN_MINUTES_MS) {
    return contextConsumer;
  }

  try {
    const response = await fetch(`https://docs.netlify.com/ai-context/context-consumers`)
    const data = await response.json() as ConsumersData;

    if(data?.consumers?.length > 0){
      contextConsumer = data.consumers.find(c => c.key === getConsumer());
    }

  } catch (error) {
    appendErrorToLog('Error fetching context consumers:', error);
  }

  // Update timestamp when we get fresh data
  if (contextConsumer) {
    contextConsumerTimestamp = Date.now();
  }

  return contextConsumer;
}


export async function getNetlifyCodingContext(contextKey: string): Promise<ContextFile | undefined> {
  const now = Date.now();

  // Check if we have a cached version that's less than 10 minutes old
  // If so, return the cached version otherwise fetch fresh data
  if (contextCache[contextKey] && (now - contextCache[contextKey].timestamp) < TEN_MINUTES_MS) {
    return contextCache[contextKey]?.data;
  }

  const consumer = await getContextConsumerConfig();

  if(!consumer || !consumer.contextScopes[contextKey]?.endpoint){
    console.error('unable to find the context you are looking for. Check docs.netlify.com for more information.');
    return;
  }

  const endpoint = new URL(consumer.contextScopes[contextKey].endpoint);
  endpoint.searchParams.set('consumer', getConsumer());

  let data = '';
  try {
    const response = await fetch(endpoint.toString())
    data = await response.text() as string;

    if(!data){
      console.error('unable to find the context you are looking for. Check docs.netlify.com for more information.');
      return;
    }

    const contextFile: ContextFile = {
      key: contextKey,
      config: consumer.contextScopes[contextKey],
      content: data
    };

    contextCache[contextKey] = {
      data: contextFile,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('Error fetching context:', error);
  }

  return contextCache[contextKey]?.data;
}
