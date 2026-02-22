#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';
import {executeCommand} from './commands.js';
import type {CliFlags} from './types.js';

const cli = meow(
	`
Usage
  $ minenet <command> [options]

Commands
  login                Start browser-based device login
  logout               Clear local auth state
  whoami               Show current team profile
  pull                 Pull deployment configurations into local workspace
  push                 Push local configuration YAML changes to remote
  deploy               Queue deploy apply for configuration(s)
  status               Show auth + workspace manifest state

Options
  --workspace, -w      Workspace path (default: ./<team-slug>)
  --config, -c         Configuration id or directory name selector
  --force              Overwrite conflict protections for pull/push
  --detach             Queue deploy and exit without polling run status
  --no-open            Do not auto-open browser for login
  --api                Base URL for minenet-pro (default: https://www.minenet.pro)
  --json               Output machine-readable JSON
  --prune              Deprecated flag (ignored by current deployments API)

Examples
  $ minenet login
  $ minenet pull --workspace ./my-team
  $ minenet push --config lobby-server
  $ minenet deploy --config lobby-server --detach
`,
	{
		importMeta: import.meta,
		flags: {
			workspace: {
				type: 'string',
				shortFlag: 'w',
			},
			config: {
				type: 'string',
				shortFlag: 'c',
			},
			force: {
				type: 'boolean',
				default: false,
			},
			detach: {
				type: 'boolean',
				default: false,
			},
			api: {
				type: 'string',
			},
			json: {
				type: 'boolean',
				default: false,
			},
			prune: {
				type: 'boolean',
				default: true,
			},
			open: {
				type: 'boolean',
				default: true,
			},
		},
	},
);

const command = cli.input[0] ?? '';
if (!command) {
	cli.showHelp();
}

const flags: CliFlags = {
	workspace: cli.flags.workspace,
	config: cli.flags.config,
	force: cli.flags.force,
	detach: cli.flags.detach,
	api: cli.flags.api,
	json: cli.flags.json,
	prune: cli.flags.prune,
	noOpen: !cli.flags.open,
};

const version = cli.pkg.version || 'dev';

if (flags.json) {
	void (async () => {
		try {
			const result = await executeCommand({
				command,
				args: cli.input.slice(1),
				flags,
				cwd: process.cwd(),
				version,
			});
			console.log(JSON.stringify(result.payload ?? {ok: result.ok}, null, 2));
			process.exit(result.exitCode);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unexpected error';
			console.log(JSON.stringify({error: message}, null, 2));
			process.exit(1);
		}
	})();
} else {
	render(
		<App
			command={command}
			args={cli.input.slice(1)}
			flags={flags}
			version={version}
		/>,
	);
}
