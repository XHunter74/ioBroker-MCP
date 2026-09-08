import * as http from 'http';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/configuration.js';
import {
  IoBrokerEnum,
  IoBrokerEnumResult,
  IoBrokerLogEntry,
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
  private iobrokerHostId: string | null = null;
  private adminWsHost = '';
  private adminWsPort = 0;
  private adminWsReconnectTimer: NodeJS.Timeout | null = null;

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

      // Socket.io — connects with auto-reconnect enabled
      this.socketReady = this.connectSocket(host, port, user, password);
      this.socketReady.catch(err =>
        this.logger.warn(`Socket.io not available: ${err?.message ?? err}`),
      );

      // Admin WS — connects with auto-reconnect via scheduleAdminWsReconnect
      this.adminWsHost = adminHost;
      this.adminWsPort = adminPort;
      this.adminWsReady = this.scheduleAdminWsReconnect(0);
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

  async setObject(id: string, obj: Record<string, unknown>): Promise<void> {
    await this.socketEmit('setObject', id, obj);
  }

  async deleteObject(id: string): Promise<void> {
    await this.adminWsEmit('delObject', id, { recursive: true });
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

    // Normalize to CRLF — MCP transport strips \r, but ioBroker JS adapter stores scripts with CRLF
    const source = params.source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

    const obj: IoBrokerScript = {
      _id: id,
      type: 'script',
      common: {
        name: params.name ?? base.common?.name ?? id.split('.').pop()!,
        source,
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

  async getLogs(options: {
    minutes?: number;
    level?: string;
    adapter?: string;
    maxLines?: number;
  }): Promise<IoBrokerLogEntry[]> {
    const minutes = options.minutes ?? 30;
    const maxLines = options.maxLines ?? 500;
    const cutoff = Date.now() - minutes * 60_000;

    const hostId = await this.discoverHostId();
    const raw = await this.adminWsEmit<unknown[]>('sendToHost', hostId, 'getLogs', 2000);

    if (!Array.isArray(raw)) return [];

    const entries: IoBrokerLogEntry[] = [];
    for (const line of raw) {
      if (typeof line !== 'string') continue;
      const parsed = parseLogLine(line);
      if (!parsed || parsed.ts < cutoff) continue;
      if (options.level && options.level !== 'all' && parsed.level !== options.level) continue;
      if (options.adapter && !parsed.source.toLowerCase().includes(options.adapter.toLowerCase())) continue;
      entries.push(parsed);
      if (entries.length >= maxLines) break;
    }
    return entries;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async discoverHostId(): Promise<string> {
    if (this.iobrokerHostId) return this.iobrokerHostId;
    const { data } = await this.client.get<Record<string, { _id: string; type: string }>>('/objects', {
      params: { pattern: 'system.host.*', type: 'host' },
    });
    const id = Object.keys(data)[0];
    if (!id) throw new Error('No ioBroker host object found');
    this.iobrokerHostId = id;
    return id;
  }

  private async connectSocket(
    host: string,
    port: number,
    user: string,
    password: string,
  ): Promise<void> {
    // socket.io-client v2 is needed — ioBroker uses socket.io v2.5.x (EIO=3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioModule: any = await import('socket.io-client');
    const ioConnect: (url: string, opts?: object) => any = ioModule.default ?? ioModule;

    this.socket = ioConnect(`http://${host}:${port}`, {
      query: { user, pass: password },
      transports: ['polling', 'websocket'],
      reconnection: true,          // auto-reconnect after ioBroker restarts
      reconnectionDelay: 5_000,
      reconnectionDelayMax: 30_000,
    });

    this.socket.on('connect', () => {
      this.logger.log('Socket.io connected');
    });

    this.socket.on('reconnect', () => {
      this.logger.log('Socket.io reconnected');
    });

    this.socket.on('disconnect', (reason: string) => {
      this.logger.warn(`Socket.io disconnected: ${reason}`);
    });

    this.socket.on('connect_error', (err: Error) => {
      this.logger.warn(`Socket.io connect error: ${err?.message ?? err}`);
    });
  }

  private socketEmit<T = void>(event: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        return reject(new Error('Socket not connected — ioBroker may be restarting'));
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
            const firstArg = args?.[0];
            if (firstArg === null || typeof firstArg === 'string') {
              // Standard format: [error|null, result?]
              if (firstArg) cb.reject(new Error(firstArg as string));
              else cb.resolve(args?.[1]);
            } else {
              // sendToHost-style: result is first arg directly
              cb.resolve(firstArg);
            }
          }
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (this.adminWs === ws) {
          // This was the active connection — schedule reconnect
          this.adminWs = null;
          this.logger.warn('Admin WS disconnected');
          for (const [, cb] of this.adminWsCallbacks) {
            clearTimeout(cb.timer);
            cb.reject(new Error('Admin WS disconnected'));
          }
          this.adminWsCallbacks.clear();
          this.adminWsReady = this.scheduleAdminWsReconnect(5_000);
          this.adminWsReady.catch(() => {});
        } else {
          // Close during initial connect attempt — handled by error/timeout above
          this.adminWs = null;
        }
      });
    });
  }

  // Schedules a reconnect after `delay` ms, then retries with exponential backoff.
  // Resolves when the connection is established.
  private scheduleAdminWsReconnect(delay: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = (d: number) => {
        if (this.adminWsReconnectTimer) clearTimeout(this.adminWsReconnectTimer);
        this.adminWsReconnectTimer = setTimeout(async () => {
          this.adminWsReconnectTimer = null;
          if (d > 0) this.logger.log('Admin WS reconnecting...');
          try {
            await this.connectAdminWs(this.adminWsHost, this.adminWsPort);
            resolve();
          } catch (err) {
            const next = Math.min(Math.max(d, 5_000) * 2, 60_000);
            this.logger.warn(`Admin WS not available: ${(err as Error)?.message ?? err} — retry in ${next / 1000}s`);
            attempt(next);
          }
        }, d);
      };
      attempt(delay);
    });
  }

  private adminWsEmit<T = void>(command: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      // Race against both the connection wait and a hard timeout
      const overall = setTimeout(
        () => reject(new Error(`Admin WS timeout on "${command}"`)),
        10_000,
      );

      this.adminWsReady.then(() => {
        if (!this.adminWs) {
          clearTimeout(overall);
          return reject(new Error('Admin WS not connected'));
        }
        clearTimeout(overall);
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
      }).catch(e => {
        clearTimeout(overall);
        reject(new Error(`Admin WS not available: ${e}`));
      });
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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[\d+m/g;

function parseLogLine(line: string): IoBrokerLogEntry | null {
  const clean = line.replace(ANSI_RE, '');
  const m = clean.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+-\s+(\w+):\s+(\S+)\s+(.*)/);
  if (!m) return null;
  const ts = new Date(m[1].replace(' ', 'T')).getTime();
  if (isNaN(ts)) return null;
  return { ts, isoDate: new Date(ts).toISOString(), level: m[2], source: m[3], message: m[4].trim() };
}
