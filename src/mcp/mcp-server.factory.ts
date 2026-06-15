import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IoBrokerService } from '../iobroker/iobroker.service.js';

@Injectable()
export class McpServerFactory {
  constructor(private readonly ioBrokerService: IoBrokerService) {}

  create(): McpServer {
    const server = new McpServer({
      name: 'iobroker-mcp',
      version: '1.0.0',
    });

    server.tool(
      'get_state',
      'Get the current value and metadata of an ioBroker datapoint by its ID',
      {
        id: z
          .string()
          .describe('ioBroker datapoint ID, e.g. hm-rpc.0.ABC123.STATE or system.adapter.admin.0.alive'),
      },
      async ({ id }) => {
        try {
          const state = await this.ioBrokerService.getState(id);
          return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error reading state "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'set_state',
      'Set the value of an ioBroker datapoint',
      {
        id: z.string().describe('ioBroker datapoint ID'),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe('Value to set (string, number, or boolean)'),
        ack: z
          .boolean()
          .optional()
          .describe('Acknowledge flag — true means the value was confirmed by the device (default: false)'),
      },
      async ({ id, value, ack }) => {
        try {
          const result = await this.ioBrokerService.setState(id, value, ack);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error setting state "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'get_object',
      'Get the definition (metadata) of an ioBroker object — device, channel, or datapoint',
      {
        id: z.string().describe('ioBroker object ID'),
      },
      async ({ id }) => {
        try {
          const obj = await this.ioBrokerService.getObject(id);
          return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error reading object "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'search_states',
      'List all ioBroker states matching a glob pattern, with their current values',
      {
        pattern: z
          .string()
          .describe('Glob pattern, e.g. "hm-rpc.0.*" or "system.adapter.*.alive"'),
      },
      async ({ pattern }) => {
        try {
          const states = await this.ioBrokerService.searchStates(pattern);
          const count = Object.keys(states).length;
          const text = count > 0
            ? JSON.stringify(states, null, 2)
            : `No states found matching pattern "${pattern}"`;
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error searching states: ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'get_enums',
      'Get ioBroker enumerations (rooms and functions). If a state ID is provided, returns only the enums that contain that state.',
      {
        state_id: z
          .string()
          .optional()
          .describe('Optional ioBroker state ID to filter enums — returns only rooms/functions this state belongs to'),
      },
      async ({ state_id }) => {
        try {
          const result = await this.ioBrokerService.getEnums(state_id);
          const formatEnum = (e: { _id: string; common: { name: unknown; members: string[] } }) => ({
            id: e._id,
            name: e.common.name,
            members: e.common.members,
          });
          const output = {
            rooms: result.rooms.map(formatEnum),
            functions: result.functions.map(formatEnum),
          };
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error fetching enums: ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    return server;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
