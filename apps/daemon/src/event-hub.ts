import type { ServerResponse } from "node:http";
import type { AssistantEvent } from "@cc-assistant/shared";

export class EventHub {
  readonly #clients = new Set<ServerResponse>();

  subscribe(response: ServerResponse): () => void {
    this.#clients.add(response);
    response.write(": connected\n\n");

    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": heartbeat\n\n");
    }, 15_000);

    return () => {
      clearInterval(heartbeat);
      this.#clients.delete(response);
    };
  }

  publish(event: AssistantEvent): void {
    const frame = `id: ${event.id}\nevent: assistant-event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients) {
      if (client.destroyed) {
        this.#clients.delete(client);
      } else {
        client.write(frame);
      }
    }
  }
}
