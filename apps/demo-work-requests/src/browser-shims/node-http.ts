export class IncomingMessage {}

export class ServerResponse {}

export class Server {}

export function createServer(): never {
  throw new Error("node:http is not available in the browser bundle.");
}
