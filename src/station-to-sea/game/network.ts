import type { GameAction, GameState } from "./state.ts";

export type NetworkEvent =
  | { type: "joined"; seat: "Amber" | "Teal" }
  | { type: "state"; version: number; state: Omit<GameState, "graph" | "rng"> }
  | { type: "error"; error: string }
  | { type: "closed" };

export class LocalNetwork {
  private socket!: WebSocket;
  private version = -1;
  constructor(connect: () => WebSocket, onEvent: (event: NetworkEvent) => void, roomId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage) {
    let delay = 500;
    const open = () => {
      const socket = this.socket = connect();
      let stopped = false;
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === 'ready') {
          const token = storage.getItem(`station-room-${roomId}`);
          socket.send(JSON.stringify(token ? { type: 'join', token } : { type: 'join' }));
        } else if (message.type === 'joined') {
          storage.setItem(`station-room-${roomId}`, message.token);
          delay = 500;
          onEvent({ type: 'joined', seat: message.seat });
        } else if (message.type === 'state') {
          this.version = message.version;
          onEvent({ type: 'state', version: message.version, state: message.state });
        } else if (message.type === 'error') {
          stopped = ['invalid credential', 'room full', 'invalid join'].includes(message.error);
          onEvent({ type: 'error', error: message.error });
        }
      };
      socket.onclose = event => {
        this.version = -1;
        onEvent({ type: 'closed' });
        if (!stopped && event.code !== 4001) {
          setTimeout(open, delay);
          delay = Math.min(delay * 2, 5000);
        }
      };
    };
    open();
  }
  send(action: GameAction): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "action", id: crypto.randomUUID(), version: this.version, action }));
  }
}
