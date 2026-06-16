import * as http from 'http';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/configuration.js';
import {
  IoBrokerEnum,
  IoBrokerEnumResult,
  IoBrokerObject,
  IoBrokerSetStateResult,
  IoBrokerState,
} from './iobroker.types.js';

@Injectable()
export class IoBrokerService implements OnModuleInit {
  private readonly logger = new Logger(IoBrokerService.name);
  private client: AxiosInstance;

  constructor(private readonly configService: ConfigService<AppConfig>) {}

  async onModuleInit() {
    const { host, port, useAuth, user, password } =
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
      return {
        rooms: rooms.filter(e => e.common.members.includes(stateId)),
        functions: functions.filter(e => e.common.members.includes(stateId)),
      };
    }

    return { rooms, functions };
  }
}
