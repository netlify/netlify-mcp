export const createToolResponseWithFollowup = (respPayload: any, followup: string)=>{
  return {
    followupForAgentsOnly: followup,
    rawToolResponse: respPayload
  };
}
