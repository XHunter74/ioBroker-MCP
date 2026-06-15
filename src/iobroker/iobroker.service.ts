import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/configuration.js';
import {
  IoBrokerObject,
  IoBrokerSetStateResult,
  IoBrokerState,
} from './iobroker.types.js';

@Injectable()
export class IoBrokerService implements OnModuleInit {
  private readonly logger = new Logger(IoBrokerService.name);
  private client: AxiosInstance;
  private authParams: Record<string, string>;

  constructor(private readonly configService: ConfigService<AppConfig>) {}

  onModuleInit() {
    const { host, port, useAuth, user, password } =
      this.configService.get('iobroker', { infer: true });

    const baseUrl = `http://${host}:${port}`;
    this.authParams = useAuth ? { user, pass: password } : {};

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 10_000,
    });

    this.logger.log(`Connected to ioBroker simple-api at ${baseUrl} (auth: ${useAuth})`);
  }

  async getState(id: string): Promise<IoBrokerState> {
    const { data } = await this.client.get<IoBrokerState>(`/get/${id}`, {
      params: this.authParams,
    });
    return data;
  }

  async setState(
    id: string,
    value: string | number | boolean,
    ack?: boolean,
  ): Promise<IoBrokerSetStateResult> {
    const params: Record<string, unknown> = { ...this.authParams, value };
    if (ack !== undefined) params.ack = ack;

    const { data } = await this.client.get<IoBrokerSetStateResult>(`/set/${id}`, {
      params,
    });
    return data;
  }

  async getObject(id: string): Promise<IoBrokerObject> {
    // /getObject/ is not supported in all simple-api versions; /get/ returns state+object combined
    const { data } = await this.client.get<IoBrokerObject>(`/get/${id}`, {
      params: this.authParams,
    });
    return data;
  }

  async searchStates(pattern: string): Promise<Record<string, IoBrokerState>> {
    const { data } = await this.client.get<Record<string, IoBrokerState>>('/states', {
      params: this.authParams,
    });
    const regex = this.globToRegex(pattern);
    return Object.fromEntries(
      Object.entries(data).filter(([id]) => regex.test(id)),
    );
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  async searchObjects(pattern: string): Promise<Record<string, IoBrokerObject>> {
    const { data } = await this.client.get<Record<string, IoBrokerObject>>('/objects', {
      params: { ...this.authParams, pattern },
    });
    return data;
  }
}
