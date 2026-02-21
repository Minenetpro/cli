import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp} from 'ink';
import {executeCommand} from './commands.js';
import type {CliFlags} from './types.js';

type Props = {
	command: string;
	args: string[];
	flags: CliFlags;
	version: string;
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export default function App({command, args, flags, version}: Props) {
	const {exit} = useApp();
	const [logs, setLogs] = useState<string[]>([]);
	const [running, setRunning] = useState(true);
	const [ok, setOk] = useState<boolean | null>(null);
	const [frameIndex, setFrameIndex] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrameIndex(current => (current + 1) % FRAMES.length);
		}, 80);

		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		let cancelled = false;

		const run = async () => {
			try {
				const result = await executeCommand({
					command,
					args,
					flags,
					cwd: process.cwd(),
					version,
					onProgress: update => {
						if (cancelled || !update.log) {
							return;
						}
						setLogs(current => [...current, update.log!]);
					},
				});

				if (cancelled) {
					return;
				}

				if (result.logs.length > 0) {
					setLogs(current => [...current, ...result.logs]);
				}

				if (flags.json) {
					const payload = result.payload ?? {ok: result.ok};
					setLogs([JSON.stringify(payload, null, 2)]);
				}

				setOk(result.ok);
				setRunning(false);
				process.exitCode = result.exitCode;

				setTimeout(() => {
					if (!cancelled) {
						exit();
					}
				}, 0);
			} catch (error) {
				if (cancelled) {
					return;
				}

				const message =
					error instanceof Error ? error.message : 'Unexpected error';
				setLogs(current => [...current, `Error: ${message}`]);
				setOk(false);
				setRunning(false);
				process.exitCode = 1;
				setTimeout(() => {
					if (!cancelled) {
						exit();
					}
				}, 0);
			}
		};

		run().catch(error => {
			const message =
				error instanceof Error ? error.message : 'Unexpected error';
			setLogs(current => [...current, `Error: ${message}`]);
			setOk(false);
			setRunning(false);
			process.exitCode = 1;
			exit();
		});

		return () => {
			cancelled = true;
		};
	}, [args, command, exit, flags, version]);

	const header = useMemo(() => {
		if (running) {
			return `${FRAMES[frameIndex]} minenet ${command}`;
		}
		if (ok) {
			return `✓ minenet ${command}`;
		}
		return `✗ minenet ${command}`;
	}, [command, frameIndex, ok, running]);

	return (
		<Box flexDirection="column">
			<Text color={running ? 'cyan' : ok ? 'green' : 'red'}>{header}</Text>
			{logs.map((line, index) => (
				<Text key={`${index}-${line}`}>{line}</Text>
			))}
		</Box>
	);
}
