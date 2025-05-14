
// It's best to run these in the tool calls so that it will
// inform the agent about compatibility issues. Bailing on start up
// hides the issue.
export const checkCompatibility = () => {
  // we've seen users with older Node versions running into issues
  // and this helps inform them of this compatibility.
  const currentNodeVersion = process?.versions?.node?.split('.')[0];
  if (currentNodeVersion && Number(currentNodeVersion) < 20){
    throw new Error('This version of Node.js has been "end of lifed" by the Node.js team and is no longer supported. Please upgrade to at least Node.js 20 to use the Netlify MCP.');
  }
}
