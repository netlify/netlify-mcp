import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Appends a message to the log file
 * @param message The message to append to the log file
 * @param includeTimestamp Whether to include a timestamp with the log entry (default: true)
 */
export function appendToLog(message: string | string[], includeTimestamp: boolean = true): void {

  try {
    const logPath = path.join(os.homedir(), 'Desktop', 'netlify', 'netlify-mcp', 'log.txt');

    // only for mcp developers
    if(!fs.existsSync(logPath)){
      return;
    }
    // Create the message with optional timestamp
    const timestamp = includeTimestamp ? `[${new Date().toISOString()}] ` : '';
    const logEntry = `${timestamp}${Array.isArray(message) ? message.join(' ') : message}\n`;

    // Append to the log file, creating it if it doesn't exist
    fs.appendFileSync(logPath, logEntry);
  } catch (error) {
    console.error(`Error writing to log file: ${error}`);
  }
}

/**
 * Appends an error to the log file with additional error details
 * @param message The error message
 * @param error The error object (optional)
 */
export function appendErrorToLog(message: string | string[], error?: Error | unknown): void {
  let logMessage = `ERROR: ${Array.isArray(message) ? message.join(' ') : message}`;

  if (error) {
    if (error instanceof Error) {
      logMessage += `\nDetails: ${error.message}`;
      if (error.stack) {
        logMessage += `\nStack: ${error.stack}`;
      }
    } else {
      logMessage += `\nDetails: ${String(error)}`;
    }
  }

  appendToLog(logMessage);
}
