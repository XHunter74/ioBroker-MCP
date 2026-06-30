export interface IoBrokerState {
  val: string | number | boolean | null;
  ts: number;
  ack: boolean;
  lc: number;
  from?: string;
  q?: number;
}

export interface IoBrokerObjectCommon {
  name: string | Record<string, string>;
  type?: string;
  role?: string;
  unit?: string;
  min?: number;
  max?: number;
  read?: boolean;
  write?: boolean;
  states?: Record<string, string>;
  [key: string]: unknown;
}

export interface IoBrokerObject {
  _id: string;
  type: string;
  common: IoBrokerObjectCommon;
  native?: Record<string, unknown>;
  ts?: number;
}

export interface IoBrokerSetStateResult {
  id: string;
  val: string | number | boolean | null;
}

export interface IoBrokerEnum {
  _id: string;
  type: 'enum';
  common: {
    name: string | Record<string, string>;
    members: string[];
    color?: string;
    icon?: string;
    [key: string]: unknown;
  };
}

export interface IoBrokerEnumResult {
  rooms: IoBrokerEnum[];
  functions: IoBrokerEnum[];
}

export interface IoBrokerScript {
  _id: string;
  type: 'script';
  common: {
    name: string;
    source: string;
    enabled: boolean;
    engineType: string;
    engine: string;
    debug?: boolean;
    verbose?: boolean;
    expert?: boolean;
    compiled?: string;
    sourceHash?: string;
  };
  native?: Record<string, unknown>;
}
