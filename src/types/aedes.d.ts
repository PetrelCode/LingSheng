declare module 'aedes' {
  import { EventEmitter } from 'node:events';

  export interface AedesPublishPacket {
    cmd?: string;
    topic: string;
    payload: Buffer;
    qos: 0 | 1 | 2;
    retain: boolean;
  }

  export interface AedesClient {
    id: string;
    clean: boolean;
    conn: { remoteAddress?: string; remotePort?: number };
  }

  export interface AedesAuthenticatePayload {
    username?: string;
    password?: string;
  }

  export interface AedesOptions {
    id?: string;
    heartbeatInterval?: number;
    connectTimeout?: number;
    authenticate?: (
      client: AedesClient,
      username: string | undefined,
      password: string | undefined,
      done: (err: Error | null, success: boolean) => void,
    ) => void;
    authorizePublish?: (client: AedesClient, packet: AedesPublishPacket, done: (err?: Error | null) => void) => void;
    authorizeSubscribe?: (client: AedesClient, sub: { topic: string }, done: (err?: Error | null, sub?: any) => void) => void;
  }

  export interface Aedes extends EventEmitter {
    handle: (stream: any) => void;
    publish(packet: AedesPublishPacket, callback?: (err?: Error) => void): void;
    close(callback?: () => void): void;
    on(event: 'publish', cb: (packet: AedesPublishPacket, client: AedesClient | null) => void): this;
    on(event: 'client', cb: (client: AedesClient) => void): this;
    on(event: 'clientDisconnect', cb: (client: AedesClient) => void): this;
    on(event: 'clientError', cb: (client: AedesClient, err: Error) => void): this;
    on(event: 'connection', cb: (client: AedesClient) => void): this;
  }

  const factory: (options?: AedesOptions) => Aedes;
  export default factory;
}
