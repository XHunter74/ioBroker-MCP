import * as http from 'http';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/configuration.js';
import {
  IoBrokerEnum,
  IoBrokerEnumResult,
  IoBrokerObject,
  IoBrokerScript,
  IoBrokerSetStateResult,
  IoBrokerState,
} from './iobroker.types.js';

// ioBroker admin WS protocol message types
const enum WsMsgType { MESSAGE = 0, PING = 1, PONG = 2, CALLBACK = 3 }

@Injectable()
export class IoBrokerService implements OnModuleInit {
  private readonly logger = new Logger(IoBrokerService.name);
  private client: AxiosInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private socket: any = null;
  private socketReady: Promise<void> = Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private adminWs: any = null;
  private adminWsReady: Promise<void> = Promise.resolve();
  private adminWsCallbackId = 0;
  private readonly adminWsCallbacks = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly configService: ConfigService<AppConfig>) {}

  async onModuleInit() {
    const { host, port, adminHost, adminPort, useAuth, user, password } =
      this.configService.get('iobroker', { infer: true });

    const axiosAuth = useAuth ? { username: user, password } : undefined;

    this.client = axios.create({
      baseURL: `http://${host}:${port}`,
      timeout: 10_000,
      auth: axiosAuth,
    });

    // ioBroker admin (port 8082) requires a session cookie — it redirects the
    // first request to set one. Obtain it upfront so all requests succeed.
    if (useAuth) {
      const cookie = await this.fetchSessionCookie(host, port, axiosAuth);
      if (cookie) {
        this.client.defaults.headers.common['Cookie'] = cookie;
        this.logger.log('Session cookie initialized');
      }

      // Auto-refresh session cookie when ioBroker restarts (stale cookie → 302 redirect)
      this.client.interceptors.response.use(
        res => res,
        async (error: unknown) => {
          const err = error as import('axios').AxiosError;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cfg = err?.config as any;
          if (cfg && !cfg.__cookieRetried && err?.response?.status === 302) {
            cfg.__cookieRetried = true;
            this.logger.warn('Session cookie stale — refreshing');
            const fresh = await this.fetchSessionCookie(host, port, axiosAuth);
            if (fresh) {
              this.client.defaults.headers.common['Cookie'] = fresh;
              cfg.headers = { ...cfg.headers, Cookie: fresh };
            }
            return this.client.request(cfg);
          }
          return Promise.reject(error);
        },
      );

      // Socket.io connection for setObject / setState operations
      this.socketReady = this.connectSocket(host, port, user, password);
      this.socketReady.catch(err =>
        this.logger.warn(`Socket.io not available: ${err?.message ?? err}`),
      );

      // Admin WS connection (ioBroker custom protocol) for delObject — admin.2 has auth:false
      this.adminWsReady = this.connectAdminWs(adminHost, adminPort);
      this.adminWsReady.catch(err =>
        this.logger.warn(`Admin WS not available: ${err?.message ?? err}`),
      );
    }

    this.logger.log(`Connected to ioBroker at http://${host}:${port} (auth: ${useAuth})`);
  }

  async getState(id: string): Promise<IoBrokerState> {
    const { data } = await this.client.get<Record<string, IoBrokerState>>('/states', {
      params: { pattern: id },
    });
    const state = data[id];
    if (!state) throw new Error(`State "${id}" not found`);
    return state;
  }

  async setState(
    id: string,
    value: string | number | boolean,
    ack?: boolean,
  ): Promise<IoBrokerSetStateResult> {
    const params: Record<string, unknown> = { value };
    if (ack !== undefined) params.ack = ack;
    const { data } = await this.client.get<IoBrokerSetStateResult>(`/set/${id}`, { params });
    return data;
  }

  async getObject(id: string): Promise<IoBrokerObject> {
    const { data } = await this.client.get<IoBrokerObject>(`/get/${id}`);
    if (!data?._id) throw new Error(`Object "${id}" not found`);
    return data;
  }

  async searchStates(pattern: string): Promise<Record<string, IoBrokerState>> {
    const { data } = await this.client.get<Record<string, IoBrokerState>>('/states', {
      params: { pattern },
    });
    return data;
  }

  async getEnums(stateId?: string): Promise<IoBrokerEnumResult> {
    const [roomsResp, functionsResp] = await Promise.all([
      this.client.get<Record<string, IoBrokerEnum>>('/objects', {
        params: { pattern: 'enum.rooms.*', type: 'enum' },
      }),
      this.client.get<Record<string, IoBrokerEnum>>('/objects', {
        params: { pattern: 'enum.functions.*', type: 'enum' },
      }),
    ]);

    const toList = (data: Record<string, IoBrokerEnum>): IoBrokerEnum[] =>
      Object.values(data).filter(
        (obj): obj is IoBrokerEnum => obj?.type === 'enum' && Array.isArray(obj.common?.members),
      );

    const rooms = toList(roomsResp.data);
    const functions = toList(functionsResp.data);

    if (stateId) {
      const matches = (members: string[]) =>
        members.some(m => m === stateId || stateId.startsWith(m + '.'));
      return {
        rooms: rooms.filter(e => matches(e.common.members)),
        functions: functions.filter(e => matches(e.common.members)),
      };
    }

    return { rooms, functions };
  }

  async createState(
    id: string,
    common: { name: string; type?: string; role?: string; unit?: string },
    initialValue?: string | number | boolean | null,
  ): Promise<{ id: string }> {
    const result = await this.socketEmit<{ id: string }>('setObject', id, {
      type: 'state',
      common: { type: 'mixed', role: 'state', read: true, write: true, ...common },
      native: {},
    });
    if (initialValue !== undefined) {
      await this.socketEmit('setState', id, { val: initialValue, ack: false });
    }
    return result ?? { id };
  }

  async deleteState(id: string): Promise<void> {
    await this.adminWsEmit('delObject', id, { recursive: true });
  }

  async listScripts(pattern = 'script.js.*'): Promise<IoBrokerScript[]> {
    const { data } = await this.client.get<Record<string, IoBrokerScript>>('/objects', {
      params: { pattern, type: 'script' },
    });
    return Object.values(data).filter((o): o is IoBrokerScript => o?.type === 'script');
  }

  async getScript(id: string): Promise<IoBrokerScript> {
    const { data } = await this.client.get<IoBrokerScript>(`/get/${id}`);
    if (!data?._id) throw new Error(`Script "${id}" not found`);
    return data;
  }

  async setScript(
    id: string,
    params: { source: string; name?: string; engineType?: string; enabled?: boolean },
  ): Promise<void> {
    let base: Partial<IoBrokerScript> = {};
    try { base = await this.getScript(id); } catch { /* new script */ }

    const obj: IoBrokerScript = {
      _id: id,
      type: 'script',
      common: {
        name: params.name ?? base.common?.name ?? id.split('.').pop()!,
        source: params.source,
        enabled: params.enabled ?? base.common?.enabled ?? true,
        engineType: params.engineType ?? base.common?.engineType ?? 'JavaScript',
        engine: base.common?.engine ?? 'system.adapter.javascript.0',
        debug: base.common?.debug ?? false,
        verbose: base.common?.verbose ?? false,
      },
      native: base.native ?? {},
    };
    await this.socketEmit('setObject', id, obj);
  }

  async deleteScript(id: string): Promise<void> {
    await this.adminWsEmit('delObject', id, { recursive: true });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async connectSocket(
    host: string,
    port: number,
    user: string,
    password: string,
  ): Promise<void> {
    // socket.io-client v2 is needed — ioBroker uses socket.io v2.5.x (EIO=3)
    // Dynamic import handles CJS interop correctly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioModule: any = await import('socket.io-client');
    const ioConnect: (url: string, opts?: object) => any = ioModule.default ?? ioModule;

    return new Promise<void>((resolve, reject) => {
      this.socket = ioConnect(`http://${host}:${port}`, {
        query: { user, pass: password },
        transports: ['polling', 'websocket'],
        reconnection: false,
      });

      this.socket.on('connect', () => {
        this.logger.log('Socket.io connected');
        // Server needs ~1 s after connect to register all event handlers
        setTimeout(resolve, 1000);
      });

      this.socket.on('connect_error', (err: Error) => {
        this.logger.error(`Socket.io connect error: ${err?.message ?? err}`);
        reject(err);
      });
    });
  }

  private socketEmit<T = void>(event: string, ...args: unknown[]): Promise<T> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.socketReady;
      } catch (e) {
        return reject(new Error(`Socket not available: ${e}`));
      }
      if (!this.socket?.connected) {
        return reject(new Error('Socket not connected'));
      }
      const timer = setTimeout(
        () => reject(new Error(`Socket timeout on "${event}"`)),
        10_000,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.socket.emit(event, ...args, (err: any, result: T) => {
        clearTimeout(timer);
        if (err) {
          const msg = String(err);
          reject(
            new Error(
              msg === 'permissionError'
                ? `Permission denied: "${event}" is not allowed on this socket interface`
                : msg,
            ),
          );
        } else {
          resolve(result);
        }
      });
    });
  }

  private connectAdminWs(host: string, adminPort: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sid = Date.now();
      const url = `ws://${host}:${adminPort}/?sid=${sid}&name=iobroker-mcp`;

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const WsClass = require('ws');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws: any = new WsClass(url);

      const timeout = setTimeout(() => {
        ws.terminate?.();
        reject(new Error('Admin WS connection timeout'));
      }, 10_000);

      ws.on('open', () => {
        this.logger.log(`Admin WS connected to ws://${host}:${adminPort}`);
      });

      ws.on('message', (data: Buffer | string) => {
        let msg: unknown[];
        try { msg = JSON.parse(data.toString()); } catch { return; }

        const type: number = msg[0] as number;
        const id: number = msg[1] as number;
        const name: string = msg[2] as string;
        const args: unknown[] = msg[3] as unknown[];

        if (type === WsMsgType.PING) {
          ws.send(JSON.stringify([WsMsgType.PONG]));
          return;
        }

        if (type === WsMsgType.MESSAGE && name === '___ready___') {
          clearTimeout(timeout);
          this.adminWs = ws;
          resolve();
          return;
        }

        if (type === WsMsgType.CALLBACK) {
          const cb = this.adminWsCallbacks.get(id);
          if (cb) {
            clearTimeout(cb.timer);
            this.adminWsCallbacks.delete(id);
            const error = args?.[0] as string | null;
            if (error) cb.reject(new Error(error));
            else cb.resolve(args?.[1]);
          }
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        this.adminWs = null;
        reject(err);
      });

      ws.on('close', () => {
        this.adminWs = null;
        this.logger.warn('Admin WS disconnected');
      });
    });
  }

  private adminWsEmit<T = void>(command: string, ...args: unknown[]): Promise<T> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.adminWsReady;
      } catch (e) {
        return reject(new Error(`Admin WS not available: ${e}`));
      }
      if (!this.adminWs) {
        return reject(new Error('Admin WS not connected'));
      }
      const id = ++this.adminWsCallbackId;
      const timer = setTimeout(() => {
        this.adminWsCallbacks.delete(id);
        reject(new Error(`Admin WS timeout on "${command}"`));
      }, 10_000);
      this.adminWsCallbacks.set(id, {
        resolve: v => resolve(v as T),
        reject,
        timer,
      });
      this.adminWs.send(JSON.stringify([WsMsgType.CALLBACK, id, command, args]));
    });
  }

  private fetchSessionCookie(
    host: string,
    port: number,
    auth?: { username: string; password: string },
  ): Promise<string> {
    const authHeader = auth
      ? 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
      : undefined;
    const collected: string[] = [];

    const follow = (path: string, depth = 0): Promise<string> =>
      new Promise(resolve => {
        if (depth > 5) return resolve(collected.join('; '));

        const headers: Record<string, string> = {};
        if (authHeader) headers['Authorization'] = authHeader;
        if (collected.length) headers['Cookie'] = collected.join('; ');

        const req = http.get({ host, port, path, headers }, res => {
          for (const c of res.headers['set-cookie'] ?? []) {
            collected.push(c.split(';')[0]);
          }
          res.resume();

          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            const next = res.headers.location.startsWith('/')
              ? res.headers.location
              : `/${res.headers.location}`;
            resolve(follow(next, depth + 1));
          } else {
            this.logger.log(`Session cookie: ${collected.join('; ').substring(0, 60)}`);
            resolve(collected.join('; '));
          }
        });
        req.on('error', () => resolve(collected.join('; ')));
        req.end();
      });

    return follow('/states?pattern=system.alive');
  }
}
