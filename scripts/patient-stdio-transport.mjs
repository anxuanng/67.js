import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The server closes its owned browser after stdin ends, and that teardown can take far longer than the SDK's
// 2 s grace before it sends SIGTERM (a hard kill on Windows that loses the shutdown message). Measured 9 to 40 s
// on a loaded machine. Wait for the real exit, and let the SDK kill the process only when this deadline passes.
export const SERVER_SHUTDOWN_DEADLINE_MS = 120000;

export class PatientStdioClientTransport extends StdioClientTransport {
  async close() {
    const serverProcess = this._process;
    if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      const closed = new Promise(resolve => serverProcess.once('close', resolve));
      serverProcess.stdin?.end();
      const deadline = new Promise(resolve => setTimeout(resolve, SERVER_SHUTDOWN_DEADLINE_MS).unref());
      await Promise.race([closed, deadline]);
    }
    await super.close();
  }
}
