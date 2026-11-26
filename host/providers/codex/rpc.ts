// The `codex app-server` child: the shared JSON-RPC stdio process (../jsonrpc.ts), without
// the `jsonrpc` field (app-server leaves it out).
import { JsonRpcProcess, RpcError } from "../jsonrpc.ts";

export { RpcError as CodexRpcError };
export type { ExitInfo, RequestId } from "../jsonrpc.ts";

export class CodexProcess extends JsonRpcProcess {
  constructor(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
    super({ ...opts, label: "Codex", jsonrpc: false });
  }
}
