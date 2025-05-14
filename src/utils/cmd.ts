import { exec } from 'node:child_process';

/**
 * Run a command as a subprocess and return its output
 * @param command The command to run
 * @param options Optional execution options
 * @returns Promise with stdout, stderr, and exit code
 */
export const runCommand = async (
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  return new Promise((resolve, reject) => {
    const childProcess = exec(
      command,
      {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        timeout: options.timeout || 30000 // Default 30 second timeout
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          // Process was killed due to timeout
          resolve({
            stdout: stdout || '',
            stderr: `Command timed out after ${options.timeout || 30000}ms: ${stderr || ''}`,
            exitCode: 124 // Common exit code for timeout
          });
          return;
        }

        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error.code || 1) : 0
        });
      }
    );
  });
};
