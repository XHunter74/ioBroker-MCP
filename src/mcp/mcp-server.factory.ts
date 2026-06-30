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
          const [state, enums] = await Promise.all([
            this.ioBrokerService.getState(id),
            this.ioBrokerService.getEnums(id).catch(() => null),
          ]);
          const result: Record<string, unknown> = { ...state };
          if (enums) {
            result.rooms = enums.rooms.map(e => enumName(e.common.name));
            result.functions = enums.functions.map(e => enumName(e.common.name));
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
          const [obj, enums] = await Promise.all([
            this.ioBrokerService.getObject(id),
            this.ioBrokerService.getEnums(id).catch(() => null),
          ]);
          const result: Record<string, unknown> = { ...obj };
          if (enums) {
            result.rooms = enums.rooms.map(e => enumName(e.common.name));
            result.functions = enums.functions.map(e => enumName(e.common.name));
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

    server.tool(
      'create_state',
      'Create a new user-defined ioBroker state (in the 0_userdata.0 namespace) with an optional initial value',
      {
        id: z
          .string()
          .describe('Full state ID, e.g. "0_userdata.0.myTemperature"'),
        name: z
          .string()
          .describe('Human-readable label for the state'),
        type: z
          .enum(['string', 'number', 'boolean', 'mixed'])
          .optional()
          .describe('Data type — string | number | boolean | mixed (default: mixed)'),
        role: z
          .string()
          .optional()
          .describe('Role hint, e.g. "value", "text", "switch" (default: state)'),
        unit: z
          .string()
          .optional()
          .describe('Physical unit, e.g. "°C", "%" (optional)'),
        initial_value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe('Initial value to write after creating the state'),
      },
      async ({ id, name, type, role, unit, initial_value }) => {
        try {
          const result = await this.ioBrokerService.createState(
            id,
            { name, type, role, unit },
            initial_value,
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error creating state "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'list_scripts',
      'List ioBroker JavaScript adapter scripts. Returns id, name, enabled flag, and engine type — no source code.',
      {
        pattern: z
          .string()
          .optional()
          .describe('Glob pattern to filter scripts (default: "script.js.*")'),
      },
      async ({ pattern }) => {
        try {
          const scripts = await this.ioBrokerService.listScripts(pattern);
          const result = scripts.map(s => ({
            id: s._id,
            name: s.common.name,
            enabled: s.common.enabled,
            engineType: s.common.engineType,
          }));
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error listing scripts: ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'get_script',
      'Get the source code and metadata of an ioBroker JavaScript adapter script by its ID',
      {
        id: z.string().describe('Script ID, e.g. "script.js.common.MyScript"'),
      },
      async ({ id }) => {
        try {
          const script = await this.ioBrokerService.getScript(id);
          const result = {
            id: script._id,
            name: script.common.name,
            source: script.common.source,
            enabled: script.common.enabled,
            engineType: script.common.engineType,
            engine: script.common.engine,
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error reading script "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'set_script',
      'Create or update an ioBroker JavaScript adapter script. On update, existing fields are preserved unless explicitly overridden.',
      {
        id: z.string().describe('Script ID, e.g. "script.js.common.MyScript"'),
        source: z.string().describe('JavaScript or TypeScript source code'),
        name: z.string().optional().describe('Display name (defaults to the last segment of the ID)'),
        engine_type: z
          .enum(['JavaScript', 'TypeScript/ts'])
          .optional()
          .describe('Script engine type (default: "JavaScript")'),
        enabled: z.boolean().optional().describe('Whether the script should run (default: true)'),
      },
      async ({ id, source, name, engine_type, enabled }) => {
        try {
          await this.ioBrokerService.setScript(id, {
            source,
            name,
            engineType: engine_type,
            enabled,
          });
          return { content: [{ type: 'text', text: `Script "${id}" saved successfully` }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error saving script "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'delete_state',
      'Delete a user-defined ioBroker state and its object definition',
      {
        id: z
          .string()
          .describe('State ID to delete, e.g. "0_userdata.0.myTemperature"'),
      },
      async ({ id }) => {
        try {
          await this.ioBrokerService.deleteState(id);
          return { content: [{ type: 'text', text: `State "${id}" deleted successfully` }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error deleting state "${id}": ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      'delete_script',
      'Delete an ioBroker JavaScript adapter script by its ID',
      {
        id: z.string().describe('Script ID to delete, e.g. "script.js.common.MyScript"'),
      },
      async ({ id }) => {
        try {
          await this.ioBrokerService.deleteScript(id);
          return { content: [{ type: 'text', text: `Script "${id}" deleted successfully` }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error deleting script "${id}": ${errorMessage(err)}` }],
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

function enumName(name: string | Record<string, string>): string {
  if (typeof name === 'string') return name;
  return name.en ?? name.ru ?? name.de ?? Object.values(name)[0] ?? '';
}
