// The `agy acp` child: the shared JSON-RPC stdio process (../jsonrpc.ts), JSON-RPC 2.0 as ACP wants it.
import { JsonRpcProcess, RpcError } from "../jsonrpc.ts";

export { RpcError as AgyRpcError };
export type { ExitInfo, RequestId } from "../jsonrpc.ts";

export class AgyProcess extends JsonRpcProcess {
  constructor(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
    super({ ...opts, label: "Antigravity", jsonrpc: true });
  }
}
