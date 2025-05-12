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
const contextCache: Record<string, ContextFile> = {};

const getConsumer = () => 'netlify-mcp';

// load the consumer configuration for the MCP so
// we can share all of the available context for the
// client to select from.
export async function getContextConsumerConfig(){
  if(contextConsumer) {
    return contextConsumer;
  }

  try {
    const response = await fetch(`https://docs.netlify.com/ai-context/context-consumers`)
    const data = await response.json() as ConsumersData;
    appendToLog(JSON.stringify(data));
    if(data?.consumers?.length > 0){
      contextConsumer = data.consumers.find(c => c.key === getConsumer());
    }


  } catch (error) {
    appendErrorToLog('Error fetching context consumers:', error);
  }

  appendToLog(JSON.stringify( contextConsumer));

  return contextConsumer;
}


export async function getNetlifyCodingContext(contextKey: string){
  if (contextCache[contextKey]){
    return contextCache[contextKey];
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

    contextCache[contextKey] = {
      key: contextKey,
      config: consumer.contextScopes[contextKey],
      content: data
    };

  } catch (error) {
    console.error('Error fetching context:', error);
  }

  return contextCache[contextKey];
}
